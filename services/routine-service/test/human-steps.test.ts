/** Human steps (06-engine §5): waiting for a person, expiry, skip and cancel – against a real database. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { DomainManifest } from '@routine/service-kit';
import type { FastifyInstance } from 'fastify';
import { DefinitionError, validateRoutine } from '../src/domain/definition.ts';
import { Catalog } from '../src/domain/catalog.ts';
import { BUILTIN_MANIFESTS } from '../src/domain/builtin-manifests.ts';
import { getRoutine } from '../src/store.ts';
import { engineHarness, needsDatabase, type EngineHarness } from './support/engine-harness.ts';

/** A step timeout as the definition spells it (06 §2): "then" is its field, not a thenable. */
const expiry = (after: string, then: string) => ({ after, then }) as { after: string; then: 'skip' | 'fail' };

/** A fixture domain with one step a person does and one ordinary action. */
const CHORES: DomainManifest = {
  contract: 1,
  domain: 'chores',
  manifestVersion: 1,
  service: 'chores-service',
  name: 'Chores',
  description: 'A test fixture domain.',
  icon: 'home',
  tint: 'indigo',
  order: 50,
  optional: true,
  prefixes: ['chore'],
  capabilities: [
    {
      type: 'chore.await',
      kind: 'human',
      label: 'Do a chore',
      sentence: 'Do {title}',
      description: 'You do it.',
      params: [{ name: 'title', label: 'Title', type: 'text', required: true }],
      output: [{ name: 'doneAt', label: 'Done at', type: 'text' }],
      sideEffects: true,
      human: { awaits: 'task' },
      since: 1,
    },
    {
      type: 'chore.log',
      kind: 'action',
      label: 'Log',
      sentence: 'Log {title}',
      description: 'Writes it down.',
      params: [{ name: 'title', label: 'Title', type: 'text' }],
      output: [],
      sideEffects: true,
      since: 1,
    },
  ],
};

describe('human step definitions (06 §2.1)', () => {
  const catalog = new Catalog([...BUILTIN_MANIFESTS, CHORES]);
  const routine = (timeout: ReturnType<typeof expiry>, type = 'chore.await') => ({
    name: 'R',
    trigger: { type: 'manual' as const },
    actions: [{ key: 'a', type, params: { title: 'x' }, timeout }],
  });
  const issues = (input: ReturnType<typeof routine>) => {
    try {
      validateRoutine(input, catalog);
      return [];
    } catch (error) {
      if (error instanceof DefinitionError) return error.issues;
      throw error;
    }
  };

  it('keeps a timeout on a step you do yourself', () => {
    assert.deepEqual(validateRoutine(routine(expiry('PT2H', 'skip')), catalog).actions[0].timeout, expiry('PT2H', 'skip'));
  });

  it('refuses a timeout on any other step, and a malformed one', () => {
    assert.deepEqual(issues(routine(expiry('PT2H', 'skip'), 'chore.log')), ['action "a": only steps you do yourself can time out']);
    assert.deepEqual(issues(routine(expiry('2 hours', 'skip'))), ['action "a": the time to wait must be a duration like PT2H']);
    assert.deepEqual(issues(routine(expiry('PT2H', 'retry'))), ['action "a": after the wait the step is skipped or fails']);
  });
});

describe('human steps', { skip: needsDatabase }, () => {
  let h: EngineHarness;
  let app: FastifyInstance;
  before(async () => {
    h = await engineHarness();
    await h.register(CHORES);
    app = await h.api();
  });
  after(async () => {
    await app?.close();
    await h?.close();
  });

  const item = (title: string) => ({ kind: 'task' as const, refId: randomUUID(), title });
  const cancelsOf = async (executionId: string) => (await h.published('ActionCancelRequested')).filter((message) => message.data.executionId === executionId);
  const waitingEventsOf = async (executionId: string) => (await h.published('ExecutionWaitingForYou')).filter((message) => message.data.executionId === executionId);

  /** A routine: a human step (with an optional timeout), then a step that logs. Started; the human step is dispatched. */
  async function started(timeout?: ReturnType<typeof expiry>) {
    const routine = await h.routine({
      actions: [
        { key: 'stretch', type: 'chore.await', step: 1, params: { title: 'Stretch' }, ...(timeout && { timeout }) },
        { key: 'log', type: 'chore.log', step: 2, params: { title: 'done' } },
      ],
    });
    const id = await h.run(routine);
    const [stretch] = await h.dispatched(id);
    return { id, routine, stretch };
  }

  it('waits for the person: AWAITING_USER, WAITING_FOR_YOU, one ExecutionWaitingForYou – then goes on when they are done', async () => {
    const { id, stretch } = await started(expiry('PT2H', 'skip'));
    const refId = randomUUID();
    await h.awaiting(id, stretch.actionId, { kind: 'task', refId, title: 'Stretch' });
    await h.awaiting(id, stretch.actionId, { kind: 'task', refId, title: 'Stretch' }); // redelivered

    const waiting = (await h.actions(id)).stretch;
    assert.equal(waiting.status, 'AWAITING_USER');
    assert.deepEqual(waiting.awaiting, { kind: 'task', refId, title: 'Stretch' });
    assert.ok(waiting.accepted_at && waiting.deadline_at);
    assert.equal(Math.round((waiting.deadline_at.getTime() - waiting.accepted_at.getTime()) / 60_000), 120, 'deadline = accepted + PT2H');
    assert.equal((await h.execution(id))?.status, 'WAITING_FOR_YOU');
    assert.ok((await h.log(id)).some((entry) => entry.kind === 'ACTION_AWAITING' && entry.message === 'Waiting for you: Stretch'));

    const events = await waitingEventsOf(id);
    assert.equal(events.length, 1, 'once on entering, not per result');
    assert.deepEqual((events[0].data.awaiting as unknown[])[0], { actionKey: 'stretch', kind: 'task', refId, title: 'Stretch', dueAt: waiting.deadline_at.toISOString() });

    await h.complete(id, stretch.actionId, { doneAt: 'now' });
    assert.equal((await h.execution(id))?.status, 'RUNNING');
    const [, log] = await h.dispatched(id);
    assert.equal(log.actionKey, 'log');
    await h.complete(id, log.actionId);
    assert.equal((await h.execution(id))?.status, 'COMPLETED');
  });

  it('a step without a timeout waits indefinitely', async () => {
    const { id, stretch } = await started();
    await h.awaiting(id, stretch.actionId, item('Stretch'));
    assert.equal((await h.actions(id)).stretch.deadline_at, null);
    assert.equal(await h.engine.expireAwaitingActions(), 0);
  });

  it('expires with then: skip – skipped (expired), item cancelled, the run goes on', async () => {
    const { id, stretch } = await started(expiry('PT0S', 'skip'));
    await h.awaiting(id, stretch.actionId, item('Stretch'));
    assert.ok((await h.engine.expireAwaitingActions()) >= 1);

    const actions = await h.actions(id);
    assert.equal(actions.stretch.status, 'SKIPPED');
    assert.equal(actions.stretch.skip_reason, 'expired');
    const cancels = await cancelsOf(id);
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0].data.reason, 'expired');
    assert.equal(cancels[0].data.actionType, 'chore.await');
    assert.equal(actions.log.status, 'DISPATCHED', 'the next step runs');
  });

  it('expires with then: fail – the run fails with AWAIT_EXPIRED', async () => {
    const { id, stretch } = await started(expiry('PT0S', 'fail'));
    await h.awaiting(id, stretch.actionId, item('Stretch'));
    await h.engine.expireAwaitingActions();

    const actions = await h.actions(id);
    assert.equal(actions.stretch.status, 'FAILED');
    assert.equal(actions.stretch.error_code, 'AWAIT_EXPIRED');
    assert.equal(actions.log.skip_reason, 'failure');
    assert.equal((await h.execution(id))?.status, 'FAILED');
    const failed = (await h.published('ExecutionFailed')).filter((message) => message.data.executionId === id);
    assert.equal(failed[0]?.data.errorCode, 'AWAIT_EXPIRED');
    assert.equal((await cancelsOf(id))[0]?.data.reason, 'expired');
  });

  it('expires each step once, however many replicas run housekeeping', async () => {
    const { id, stretch } = await started(expiry('PT0S', 'skip'));
    await h.awaiting(id, stretch.actionId, item('Stretch'));
    await Promise.all([h.engine.expireAwaitingActions(), h.engine.expireAwaitingActions(), h.engine.expireAwaitingActions()]);
    assert.equal((await cancelsOf(id)).length, 1);
    assert.equal((await h.dispatched(id)).filter((command) => command.actionKey === 'log').length, 1);
  });

  it('the race (05 §5 rule 4): done in the moment it expired – the first transition wins, the late one is noted', async () => {
    const { id, stretch } = await started(expiry('PT0S', 'skip'));
    await h.awaiting(id, stretch.actionId, item('Stretch'));
    await h.engine.expireAwaitingActions();
    await h.complete(id, stretch.actionId, { doneAt: 'too late' });
    const actions = await h.actions(id);
    assert.equal(actions.stretch.status, 'SKIPPED');
    assert.equal(actions.stretch.output, null);
    assert.ok((await h.log(id)).some((entry) => entry.kind === 'ACTION_LATE' && entry.action_key === 'stretch'));

    // and the other way round: done first, then the deadline passes – nothing expires
    const other = await started(expiry('PT0S', 'fail'));
    await h.awaiting(other.id, other.stretch.actionId, item('Stretch'));
    await h.complete(other.id, other.stretch.actionId, {});
    await h.engine.expireAwaitingActions();
    assert.equal((await h.actions(other.id)).stretch.status, 'COMPLETED');
    assert.equal((await cancelsOf(other.id)).length, 0);
  });

  it('skip: the person skips a waiting step on the run page – 409 for a step that does not wait', async () => {
    const { id, stretch } = await started();
    const early = await app.inject({ method: 'POST', url: `/api/v1/executions/${id}/actions/stretch/skip` });
    assert.equal(early.statusCode, 409, 'dispatched, not waiting yet');
    await h.awaiting(id, stretch.actionId, item('Stretch'));

    const response = await app.inject({ method: 'POST', url: `/api/v1/executions/${id}/actions/stretch/skip` });
    assert.equal(response.statusCode, 200);
    const step = response.json().actions.find((action: { key: string }) => action.key === 'stretch');
    assert.equal(step.status, 'SKIPPED');
    assert.equal(step.skipReason, 'user');
    assert.equal((await cancelsOf(id))[0]?.data.reason, 'skipped');
    assert.equal((await h.actions(id)).log.status, 'DISPATCHED');

    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/executions/${id}/actions/nope/skip` })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/executions/${randomUUID()}/actions/stretch/skip` })).statusCode, 404);
  });

  it('cancel: every unfinished step is skipped, every waiting item closed, the run ends CANCELLED – no ExecutionFailed, no health count', async () => {
    const routine = await h.routine({
      actions: [
        { key: 'one', type: 'chore.await', step: 1, params: { title: 'One' } },
        { key: 'two', type: 'chore.await', step: 1, params: { title: 'Two' } },
        { key: 'log', type: 'chore.log', step: 1, params: {} },
        { key: 'later', type: 'chore.log', step: 2, params: {} },
      ],
    });
    const id = await h.run(routine);
    const commands = await h.dispatched(id);
    for (const command of commands.filter((candidate) => candidate.actionType === 'chore.await')) await h.awaiting(id, command.actionId, item(command.actionKey));

    const response = await app.inject({ method: 'POST', url: `/api/v1/executions/${id}/cancel` });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.status, 'FAILED');
    assert.equal(body.errorCode, 'CANCELLED');
    for (const action of body.actions) {
      assert.equal(action.status, 'SKIPPED', action.key);
      assert.equal(action.skipReason, 'user', action.key);
    }
    const cancels = await cancelsOf(id);
    assert.deepEqual(cancels.map((message) => message.data.actionKey).sort(), ['one', 'two'], 'only the waiting human items');
    assert.ok(cancels.every((message) => message.data.reason === 'runCancelled'));
    assert.equal((await h.published('ExecutionFailed')).filter((message) => message.data.executionId === id).length, 0);
    assert.equal((await getRoutine(h.pool, h.ownerId, routine.id))?.consecutive_failures, 0);

    // a late result changes nothing, a second cancel and a resume are refused
    await h.complete(id, commands.find((command) => command.actionKey === 'log')?.actionId ?? '', {});
    assert.equal((await h.actions(id)).log.status, 'SKIPPED');
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/executions/${id}/cancel` })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/executions/${id}/resume` })).statusCode, 409);
    const listed = (await app.inject({ url: `/api/v1/routines/${routine.id}/executions` })).json().items[0];
    assert.equal(listed.errorCode, 'CANCELLED');
  });

  it('resuming a run whose step expired with then: fail waits for the person again', async () => {
    const { id, stretch } = await started(expiry('PT0S', 'fail'));
    await h.awaiting(id, stretch.actionId, item('Stretch'));
    await h.engine.expireAwaitingActions();
    assert.equal(await h.engine.resume(id, h.ownerId, h.ownerId), 'resumed');
    const reset = (await h.actions(id)).stretch;
    assert.equal(reset.status, 'DISPATCHED');
    assert.equal(reset.awaiting, null);
    assert.equal(reset.deadline_at, null);
    assert.equal((await h.dispatched(id)).filter((command) => command.actionKey === 'stretch').length, 2, 'the same step is requested again');
  });

  it('never sends a human step in a test run', async () => {
    const { routine } = await started();
    const response = await app.inject({ method: 'POST', url: '/api/v1/routines/test-step', payload: { routineId: routine.id, action: { key: 'stretch', type: 'chore.await', params: { title: 'x' } } } });
    const step = response.json().actions.find((action: { key: string }) => action.key === 'stretch');
    assert.equal(step.status, 'SKIPPED');
    assert.equal(step.skipReason, 'test');
  });
});
