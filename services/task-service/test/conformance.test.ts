/** The `tasks` domain against the conformance checklist (04 §7), with a real database. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createEnvelope, createPool, emitEvent, handleCommand, OutboxRelay, runKitMigrations, runMigrations, validateManifest, withTransaction, type Envelope, type Pool } from '@routine/service-kit';
import pg from 'pg';
import pino from 'pino';
import { contractErrors } from '../../../contracts/validate.ts';
import { cancelStepTask, taskHandlers } from '../src/capabilities.ts';
import { changeStatus } from '../src/status.ts';
import { TASKS_MANIFEST } from '../src/manifest.ts';
import { defaultListId, eventFields, insertTask } from '../src/tasks.ts';

const logger = pino({ level: 'silent' });
const needsDatabase = process.env.TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL not set';

describe('tasks manifest', () => {
  it('validates, and every capability has a handler', () => {
    const result = validateManifest(TASKS_MANIFEST);
    assert.equal(result.valid, true, result.valid ? '' : result.errors.join('; '));
    assert.deepEqual(Object.keys(taskHandlers(logger)).sort(), TASKS_MANIFEST.capabilities.map((capability) => capability.type).sort());
  });
});

describe('tasks domain (04 §7)', { skip: needsDatabase }, () => {
  let admin: pg.Pool;
  let pool: Pool;
  let name: string;
  const ownerId = randomUUID();
  const handlers = taskHandlers(logger);

  before(async () => {
    admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    name = `tasks_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.TEST_DATABASE_URL as string);
    url.pathname = `/${name}`;
    pool = createPool(url.toString());
    pool.on('error', () => undefined);
    await runMigrations(pool, join(import.meta.dirname, '..', 'migrations'), logger);
    await runKitMigrations(pool, ['outbox', 'processed_actions'], logger);
  });
  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin?.end();
  });

  const command = (actionType: string, params: Record<string, unknown>, context: Record<string, unknown> = { mode: 'live', depth: 0 }) =>
    createEnvelope({
      type: 'ActionRequested',
      version: 1,
      source: 'routine-service',
      data: { actionId: randomUUID(), executionId: randomUUID(), routineId: randomUUID(), ownerId, actionKey: 'a', actionType, params, context },
    });
  const cancel = { 'task.await': async (cmd: Parameters<typeof cancelStepTask>[0], tools: Parameters<typeof cancelStepTask>[1]) => void (await cancelStepTask(cmd, tools, logger)) };
  const run = (envelope: Envelope) => handleCommand(pool, { handlers, cancel, logger, service: 'task-service' }, envelope);
  const cancelOf = (envelope: Envelope, reason = 'expired') =>
    createEnvelope({ type: 'ActionCancelRequested', version: 1, source: 'routine-service', data: { ...envelope.data, reason } });
  const tick = (taskId: string, status: 'OPEN' | 'DONE' = 'DONE') => withTransaction(pool, (tx) => changeStatus(tx, ownerId, taskId, status));
  const stepTask = async (envelope: Envelope) =>
    (await pool.query<{ id: string; status: string; kind: string; source_routine_name: string | null }>('SELECT * FROM tasks WHERE awaiting_action_id = $1', [envelope.data.actionId])).rows[0];
  const resultsOf = async (envelope: Envelope, routingKey: string) => (await outbox()).filter((row) => row.payload.data.actionId === envelope.data.actionId && row.routing_key === routingKey);
  const outbox = async () => (await pool.query<{ routing_key: string; payload: Envelope<Record<string, unknown>> }>('SELECT routing_key, payload FROM outbox ORDER BY id')).rows;
  const resultOf = async (envelope: Envelope) => (await outbox()).filter((row) => row.payload.data.actionId === envelope.data.actionId && row.routing_key.startsWith('action.')).at(-1);
  /** The output of a command's (last) result – there must be one. */
  const outputOf = async <T = Record<string, unknown>>(envelope: Envelope): Promise<T> => {
    const result = await resultOf(envelope);
    assert.ok(result, 'a result');
    return result.payload.data.output as T;
  };
  const trigger = (type: string) => TASKS_MANIFEST.triggers?.find((candidate) => candidate.type === type);

  it('creates a task once per action, with a contract-valid result and a task.created event with origin', async () => {
    const envelope = command('task.create', { title: 'Write review', priority: 'high', dueDate: '2026-10-01' });
    await run(envelope);
    await run(envelope);
    const { rows } = await pool.query('SELECT * FROM tasks WHERE source_action_id = $1', [envelope.data.actionId]);
    assert.equal(rows.length, 1, 'one effect');
    const results = (await outbox()).filter((row) => row.payload.data.actionId === envelope.data.actionId);
    assert.equal(results.length, 2);
    assert.deepEqual(results[0].payload.data.output, results[1].payload.data.output, 'same output');
    assert.deepEqual(contractErrors('action-completed.v1.schema.json', results[0].payload), []);

    const event = (await outbox()).find((row) => row.routing_key === 'task.created' && row.payload.data.taskId === rows[0].id);
    assert.ok(event);
    assert.equal(event.payload.type, 'TaskCreated');
    const fields = trigger('task.created')?.fields.map((field) => field.name) ?? [];
    for (const field of fields) assert.ok(field in event.payload.data, `event field ${field}`);
    assert.equal((event.payload.data.origin as { depth: number }).depth, 1);
    assert.equal(event.payload.data.sourceRoutineId, envelope.data.routineId);
  });

  it('completes, moves and reads tasks; each capability answers by its contract', async () => {
    const created = command('task.create', { title: 'Tidy desk' });
    await run(created);
    const { taskId } = await outputOf<{ taskId: string }>(created);

    const list = await pool.query<{ id: string }>(`INSERT INTO task_lists (id, owner_id, name) VALUES ($1, $2, 'Home') RETURNING id`, [randomUUID(), ownerId]);
    const move = command('task.move', { taskId, listId: list.rows[0].id, dueDate: '+1d' });
    await run(move);
    const moved = (await outbox()).find((row) => row.routing_key === 'task.moved' && row.payload.data.taskId === taskId);
    assert.equal(moved?.payload.data.listName, 'Home');

    const open = command('task.openTasks', { listId: list.rows[0].id });
    await run(open);
    assert.deepEqual(await outputOf(open), { items: [{ taskId, title: 'Tidy desk', dueDate: (moved?.payload.data.dueDate as string) ?? null, priority: 'normal' }], count: 1 });

    const complete = command('task.complete', { taskId });
    await run(complete);
    assert.deepEqual(contractErrors('action-completed.v1.schema.json', (await resultOf(complete))?.payload), []);
    assert.ok((await outbox()).some((row) => row.routing_key === 'task.completed' && row.payload.data.taskId === taskId && row.payload.data.completedAt));

    const again = command('task.complete', { taskId });
    await assert.rejects(run(again), { code: 'CONFLICT' });
    await assert.rejects(run(command('task.complete', { taskId: randomUUID() })), { code: 'REFERENCE_GONE' });

    const done = command('task.doneTasks', { since: '+0d' });
    await run(done);
    assert.equal((await outputOf<{ count: number }>(done)).count, 1);
    const count = command('task.count', {});
    await run(count);
    assert.equal((await outputOf<{ count: number }>(count)).count, 1, 'the first task is still open');
  });

  it('runs values in test mode and emits nothing there', async () => {
    const before = (await outbox()).filter((row) => !row.routing_key.startsWith('action.')).length;
    const test = command('task.openTasks', {}, { mode: 'test', depth: 0 });
    await run(test);
    assert.ok((await outputOf<{ count: number }>(test)).count >= 1);
    assert.equal((await outbox()).filter((row) => !row.routing_key.startsWith('action.')).length, before);
  });

  it('commits an event with its change – rolled back together, published after a restart', async () => {
    await assert.rejects(
      withTransaction(pool, async (tx) => {
        const { row } = await insertTask(tx, { ownerId, listId: await defaultListId(tx, ownerId), title: 'Never', description: '', priority: 'normal', dueDate: null });
        await emitEvent(tx, 'task-service', 'task.created', await eventFields(tx, row));
        throw new Error('crash before commit');
      }),
    );
    assert.equal((await pool.query(`SELECT 1 FROM tasks WHERE title = 'Never'`)).rows.length, 0);
    assert.ok(!(await outbox()).some((row) => row.payload.data.title === 'Never'), 'no event without its task');

    // committed, but the process "dies" before publishing: the relay of the next start sends it
    await withTransaction(pool, async (tx) => {
      const { row } = await insertTask(tx, { ownerId, listId: await defaultListId(tx, ownerId), title: 'Survives', description: '', priority: 'normal', dueDate: null });
      await emitEvent(tx, 'task-service', 'task.created', await eventFields(tx, row));
    });
    const published: string[] = [];
    const relay = new OutboxRelay(pool, { publish: async (_exchange, routingKey, envelope) => void published.push(`${routingKey}:${(envelope.data as { title?: string }).title}`) }, logger, { batchSize: 500, intervalMs: 10, duplicateRate: 0 });
    while (await relay.relayBatch());
    assert.ok(published.includes('task.created:Survives'));
  });

  describe('human step task.await (services/task-service.md §10)', () => {
    const awaitCommand = () => command('task.await', { title: 'Stretch for 5 minutes' }, { mode: 'live', depth: 0, routineName: 'Morning checklist' });

    it('creates a step task and answers ActionAwaitingUser; ticking completes the step exactly once', async () => {
      const envelope = awaitCommand();
      await run(envelope);
      await run(envelope); // redelivered
      const task = await stepTask(envelope);
      assert.equal(task.kind, 'step');
      assert.equal(task.source_routine_name, 'Morning checklist');
      const awaiting = await resultsOf(envelope, 'action.awaiting-user');
      assert.equal(awaiting.length, 2, 'the duplicate gets the same answer');
      assert.deepEqual(contractErrors('action-awaiting-user.v1.schema.json', awaiting[0].payload), []);
      assert.deepEqual(awaiting[0].payload.data.awaiting, { kind: 'task', refId: task.id, title: 'Stretch for 5 minutes' });
      assert.equal((await pool.query('SELECT 1 FROM tasks WHERE awaiting_action_id = $1', [envelope.data.actionId])).rows.length, 1, 'one task');

      await tick(task.id);
      await tick(task.id); // ticked again: nothing changes
      const completed = await resultsOf(envelope, 'action.completed');
      assert.equal(completed.length, 1);
      assert.deepEqual(contractErrors('action-completed.v1.schema.json', completed[0].payload), []);
      assert.equal((completed[0].payload.data.output as { taskId: string }).taskId, task.id);
      const event = (await outbox()).find((row) => row.routing_key === 'task.completed' && row.payload.data.taskId === task.id);
      assert.equal(event?.payload.data.kind, 'step');
      assert.equal(event?.payload.data.origin, undefined, 'a person ticked it (HTTP): no origin, so it may start any routine');

      await assert.rejects(tick(task.id, 'OPEN'), { status: 409 }, 'a done step stays done');
      await run(cancelOf(envelope, 'runCancelled')); // cancel after the tick: ignored
      assert.equal((await stepTask(envelope)).status, 'DONE');
      assert.equal((await resultsOf(envelope, 'action.completed')).length, 1);
    });

    it('groups the steps of one run into a checklist, in the order they were asked', async () => {
      const executionId = randomUUID();
      const first = command('task.await', { title: 'One' });
      const second = command('task.await', { title: 'Two' });
      for (const envelope of [first, second]) envelope.data.executionId = executionId;
      await run(first);
      await run(second);
      const { rows } = await pool.query<{ title: string; step_group: string; step_position: number }>('SELECT title, step_group, step_position FROM tasks WHERE step_group = $1 ORDER BY step_position', [executionId]);
      assert.deepEqual(rows.map((row) => [row.title, row.step_position]), [['One', 0], ['Two', 1]]);
    });

    it('cancel before the tick closes the task; ticking it then is refused and sends nothing', async () => {
      const envelope = awaitCommand();
      await run(envelope);
      await run(cancelOf(envelope, 'expired'));
      const task = await stepTask(envelope);
      assert.equal(task.status, 'CANCELLED');
      await assert.rejects(tick(task.id), { status: 409 });
      assert.equal((await resultsOf(envelope, 'action.completed')).length, 0);
    });

    it('asked again after its run was resumed: the same task, open again', async () => {
      const envelope = awaitCommand();
      await run(envelope);
      const first = await stepTask(envelope);
      await run(cancelOf(envelope, 'expired'));
      await run(envelope); // the resumed run requests the step again
      const again = await stepTask(envelope);
      assert.equal(again.id, first.id);
      assert.equal(again.status, 'OPEN');
      assert.equal((await resultsOf(envelope, 'action.awaiting-user')).length, 2);
      assert.ok((await outbox()).some((row) => row.routing_key === 'task.reopened' && row.payload.data.taskId === first.id));
    });
  });

  it('every task event it emitted fits its contract (domain-event.v1 and the type\'s own schema)', async () => {
    const events = (await outbox()).filter((row) => row.routing_key.startsWith('task.'));
    assert.ok(events.length >= 5, 'the tests above emitted events');
    for (const event of events) {
      assert.deepEqual(contractErrors('domain-event.v1.schema.json', event.payload), [], event.routing_key);
      assert.deepEqual(contractErrors(`${event.routing_key.replace('.', '-')}.v1.schema.json`, event.payload), [], event.routing_key);
    }
  });
});
