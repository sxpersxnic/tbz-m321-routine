/** The `notifications` domain against the conformance checklist (04 §7), with a real database. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createEnvelope, createPool, handleCommand, runKitMigrations, runMigrations, validateManifest, withTransaction, type Envelope, type Pool } from '@routine/service-kit';
import pg from 'pg';
import pino from 'pino';
import { contractErrors } from '../../../contracts/validate.ts';
import { notificationHandlers } from '../src/inbox.ts';
import { answerQuestion, expireQuestion, questionHandlers } from '../src/questions.ts';
import { NOTIFICATIONS_MANIFEST } from '../src/manifest.ts';

const logger = pino({ level: 'silent' });
const needsDatabase = process.env.TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL not set';

describe('notifications manifest', () => {
  it('validates, and every capability has a handler', () => {
    const result = validateManifest(NOTIFICATIONS_MANIFEST);
    assert.equal(result.valid, true, result.valid ? '' : result.errors.join('; '));
    assert.deepEqual(Object.keys({ ...notificationHandlers(logger), ...questionHandlers() }), NOTIFICATIONS_MANIFEST.capabilities.map((capability) => capability.type));
  });
});

describe('notifications domain (04 §7)', { skip: needsDatabase }, () => {
  let admin: pg.Pool;
  let pool: Pool;
  let name: string;

  before(async () => {
    admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    name = `notifications_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
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

  it('delivers once per action, answers by contract, and emits notification.created in the same transaction', async () => {
    const envelope = createEnvelope({
      type: 'ActionRequested',
      version: 1,
      source: 'routine-service',
      data: { actionId: randomUUID(), executionId: randomUUID(), routineId: randomUUID(), ownerId: randomUUID(), actionKey: 'n', actionType: 'notification.send', params: { title: 'Good morning' }, context: { mode: 'live', depth: 0 } },
    });
    const run = () => handleCommand(pool, { handlers: notificationHandlers(logger), logger, service: 'notification-service' }, envelope);
    await run();
    await run();
    const { rows } = await pool.query('SELECT id FROM notifications WHERE source_key = $1', [`action:${envelope.data.actionId}`]);
    assert.equal(rows.length, 1, 'one effect');

    const outbox = (await pool.query<{ routing_key: string; payload: Envelope<Record<string, unknown>> }>('SELECT routing_key, payload FROM outbox ORDER BY id')).rows;
    const results = outbox.filter((row) => row.routing_key === 'action.completed');
    assert.equal(results.length, 2);
    assert.deepEqual(results[0].payload.data.output, results[1].payload.data.output);
    assert.deepEqual(contractErrors('action-completed.v1.schema.json', results[0].payload), []);

    const created = outbox.filter((row) => row.routing_key === 'notification.created');
    assert.equal(created.length, 1, 'one event for one notification');
    assert.equal(created[0].payload.type, 'NotificationCreated');
    assert.equal(created[0].payload.data.notificationId, rows[0].id);
    assert.equal(created[0].payload.data.routineId, envelope.data.routineId);
    assert.deepEqual(created[0].payload.data.origin, { executionId: envelope.data.executionId, routineId: envelope.data.routineId, actionId: envelope.data.actionId, depth: 1 }, 'caused by a routine step');
  });

  describe('questions – notification.ask (notification-service.md §10)', () => {
    const ownerId = randomUUID();
    const handlers = { ...notificationHandlers(logger), ...questionHandlers() };
    const cancel = { 'notification.ask': (command: Parameters<typeof expireQuestion>[0], tools: Parameters<typeof expireQuestion>[1]) => expireQuestion(command, tools, logger) };
    const ask = (params: Record<string, unknown> = { question: 'How did you sleep?', options: [{ value: 'well', label: 'Well' }, { value: 'badly', label: 'Badly' }] }) =>
      createEnvelope({
        type: 'ActionRequested',
        version: 1,
        source: 'routine-service',
        data: { actionId: randomUUID(), executionId: randomUUID(), routineId: randomUUID(), ownerId, actionKey: 'mood', actionType: 'notification.ask', params, context: { mode: 'live', depth: 0 } },
      });
    const run = (envelope: Envelope) => handleCommand(pool, { handlers, cancel, logger, service: 'notification-service' }, envelope);
    const cancelOf = (envelope: Envelope) => createEnvelope({ type: 'ActionCancelRequested', version: 1, source: 'routine-service', data: { ...envelope.data, reason: 'expired' } });
    const outbox = async () => (await pool.query<{ routing_key: string; payload: Envelope<Record<string, unknown>> }>('SELECT routing_key, payload FROM outbox ORDER BY id')).rows;
    const resultsOf = async (envelope: Envelope, routingKey: string) => (await outbox()).filter((row) => row.payload.data.actionId === envelope.data.actionId && row.routing_key === routingKey);
    const questionOf = async (envelope: Envelope) => (await pool.query('SELECT * FROM notifications WHERE awaiting_action_id = $1', [envelope.data.actionId])).rows[0];
    const answer = (id: string, value: string) => withTransaction(pool, (tx) => answerQuestion(tx, ownerId, id, value));

    it('asks once and waits: ActionAwaitingUser, notification.created with the options', async () => {
      const envelope = ask();
      await run(envelope);
      await run(envelope);
      const question = await questionOf(envelope);
      assert.equal(question.kind, 'question');
      assert.equal(question.state, 'open');
      const awaiting = await resultsOf(envelope, 'action.awaiting-user');
      assert.equal(awaiting.length, 2);
      assert.deepEqual(contractErrors('action-awaiting-user.v1.schema.json', awaiting[0].payload), []);
      assert.deepEqual(awaiting[0].payload.data.awaiting, { kind: 'question', refId: question.id, title: 'How did you sleep?' });
      const created = (await outbox()).filter((row) => row.routing_key === 'notification.created' && row.payload.data.notificationId === question.id);
      assert.equal(created.length, 1);
      assert.equal(created[0].payload.data.kind, 'question');
      assert.equal((created[0].payload.data.options as unknown[]).length, 2);
    });

    it('an answer completes the step exactly once; a second answer is 409, an unknown one 422', async () => {
      const envelope = ask();
      await run(envelope);
      const question = await questionOf(envelope);
      await assert.rejects(answer(question.id, 'maybe'), { status: 422 });
      const answered = await answer(question.id, 'well');
      assert.equal(answered.state, 'answered');
      assert.ok(answered.read_at);
      await assert.rejects(answer(question.id, 'badly'), { status: 409 });

      const completed = await resultsOf(envelope, 'action.completed');
      assert.equal(completed.length, 1);
      assert.deepEqual(contractErrors('action-completed.v1.schema.json', completed[0].payload), []);
      const output = completed[0].payload.data.output as Record<string, unknown>;
      assert.equal(output.value, 'well');
      assert.equal(output.label, 'Well');
      assert.ok(output.answeredAt);
      const event = (await outbox()).find((row) => row.routing_key === 'notification.answered' && row.payload.data.notificationId === question.id);
      assert.equal(event?.payload.type, 'NotificationAnswered');
      assert.equal(event?.payload.data.value, 'well');

      await run(cancelOf(envelope)); // too late: the answer stands
      assert.equal((await questionOf(envelope)).state, 'answered');
    });

    it('an expired question can not be answered', async () => {
      const envelope = ask({ question: 'Coffee?', options: ['Yes', 'No'] });
      await run(envelope);
      await run(cancelOf(envelope));
      const question = await questionOf(envelope);
      assert.equal(question.state, 'expired');
      assert.deepEqual(question.options, [{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }], 'plain answers are their own labels');
      await assert.rejects(answer(question.id, 'Yes'), { status: 409 });
      assert.equal((await resultsOf(envelope, 'action.completed')).length, 0);
    });

    it('refuses a question with fewer than 2 or more than 4 answers', async () => {
      await assert.rejects(run(ask({ question: 'One?', options: ['Only'] })), { code: 'INVALID_PARAMS' });
      await assert.rejects(run(ask({ question: 'Five?', options: ['a', 'b', 'c', 'd', 'e'] })), { code: 'INVALID_PARAMS' });
      await assert.rejects(run(ask({ question: '', options: ['a', 'b'] })), { code: 'INVALID_PARAMS' });
    });
  });
});
