/** Matching (M4-06): filter semantics (shared table), loop protection, outbox + match_log, the log route. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createEnvelope, createHttpServer, eventTypeName } from '@routine/service-kit';
import { contractErrors } from '../../../contracts/validate.ts';
import { ConditionError, evaluate, filterMatches } from '../src/conditions.ts';
import { decide, eventTypeOf, listDecisions, matchEvent, readEvent, type IncomingEvent, type Subscription } from '../src/matching.ts';
import { applyRoutineState } from '../src/projection.ts';
import { registerRoutes } from '../src/routes.ts';
import { harness, needsDatabase, silentLogger, type Harness } from './support/harness.ts';

const table = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'contracts', 'fixtures', 'conditions.json'), 'utf8')) as {
  cases: Array<{ operator: string; left?: unknown; right?: unknown; result: boolean | 'error' }>;
};

describe('filter semantics', () => {
  it('follows the shared condition table (contracts/fixtures/conditions.json, also routine-service condition.if)', () => {
    for (const { operator, left, right, result } of table.cases) {
      const label = `${JSON.stringify(left)} ${operator} ${JSON.stringify(right)}`;
      if (result === 'error') assert.throws(() => evaluate(operator, left, right), ConditionError, label);
      else assert.equal(evaluate(operator, left, right), result, label);
    }
  });

  it('needs every condition; an impossible comparison does not match', () => {
    const data = { listId: 'groceries', title: 'Buy MILK', estimate: '3' };
    assert.equal(filterMatches([], data), true, 'no filter = every event');
    assert.equal(filterMatches([{ field: 'listId', operator: 'equals', value: 'groceries' }, { field: 'title', operator: 'contains', value: 'milk' }], data), true);
    assert.equal(filterMatches([{ field: 'listId', operator: 'equals', value: 'groceries' }, { field: 'estimate', operator: 'greaterThan', value: 5 }], data), false);
    assert.equal(filterMatches([{ field: 'title', operator: 'greaterThan', value: 5 }], data), false);
    assert.equal(filterMatches([{ field: 'dueDate', operator: 'isEmpty' }], data), true, 'a missing field is empty');
  });
});

describe('reading events', () => {
  const ownerId = randomUUID();
  const envelope = (routingKey: string, data: Record<string, unknown>) =>
    createEnvelope({ type: eventTypeName(routingKey), version: 1, source: 'x', correlationId: 'c', data: { ownerId, ...data } });

  it('turns the envelope type back into the trigger type – whatever the routing key of a retry', () => {
    for (const key of ['task.completed', 'execution.failed', 'budget.incomeRecorded', 'home.shoppingItemAdded']) assert.equal(eventTypeOf(eventTypeName(key)), key);
    assert.equal(eventTypeOf('weird'), null);
  });

  it('takes the origin of domain events, and derives it for execution events', () => {
    const routineId = randomUUID();
    assert.equal(readEvent(envelope('task.completed', { taskId: 'x' }))?.origin, null, 'a person did it');
    assert.deepEqual(readEvent(envelope('task.completed', { origin: { executionId: 'e', routineId, actionId: 'a', depth: 2 } }))?.origin, { routineId, depth: 2 });
    assert.deepEqual(readEvent(envelope('execution.failed', { routineId, depth: 1 }))?.origin, { routineId, depth: 2 }, 'one level deeper than the run');
    assert.deepEqual(readEvent(envelope('execution.completed', { routineId }))?.origin, { routineId, depth: 1 }, 'v1 events without depth');
    assert.equal(readEvent(createEnvelope({ type: 'TaskCompleted', version: 1, source: 'x', correlationId: 'c', data: {} })), null, 'no owner');
  });
});

describe('deciding', () => {
  const routineId = randomUUID();
  const subscription: Subscription = { routine_id: routineId, owner_id: 'o', event_type: 'task.completed', filter: [], routine_version: 1, active: true };
  const event = (origin: IncomingEvent['origin']): IncomingEvent => ({ type: 'task.completed', messageId: randomUUID(), correlationId: 'c', ownerId: 'o', data: { listId: 'a' }, origin });

  it('starts, filters, refuses loops and inactive routines', () => {
    assert.equal(decide(subscription, event(null)), 'started');
    assert.equal(decide({ ...subscription, active: false }, event(null)), 'inactive');
    assert.equal(decide({ ...subscription, filter: [{ field: 'listId', operator: 'equals', value: 'b' }] }, event(null)), 'filtered');
    assert.equal(decide(subscription, event({ routineId, depth: 1 })), 'loop', 'caused by its own run');
    assert.equal(decide(subscription, event({ routineId: randomUUID(), depth: 4 })), 'started');
    assert.equal(decide(subscription, event({ routineId: randomUUID(), depth: 5 })), 'loop', 'the chain is 5 deep');
  });
});

describe('matching against the projection', { skip: needsDatabase }, () => {
  let h: Harness;
  const ownerId = randomUUID();
  before(async () => {
    h = await harness();
  });
  after(async () => {
    await h?.close();
  });
  beforeEach(async () => {
    await h.pool.query('DELETE FROM subscriptions; DELETE FROM match_log; DELETE FROM outbox');
  });

  const subscribe = (routineId: string, event = 'task.completed', filter: Array<{ field: string; operator: string; value?: unknown }> = [], active = true) =>
    applyRoutineState(h.pool, { routineId, ownerId, version: 3, active, event: { type: event, filter } });
  const starts = async () =>
    (await h.pool.query<{ payload: { data: Record<string, unknown> } }>(`SELECT payload FROM outbox WHERE payload->>'type' = 'StartRoutineRequested' ORDER BY id`)).rows.map((row) => row.payload);
  const taskCompleted = (data: Record<string, unknown> = {}) =>
    readEvent(createEnvelope({ type: 'TaskCompleted', version: 1, source: 'task-service', correlationId: 'c', data: { ownerId, occurredAt: new Date().toISOString(), taskId: randomUUID(), listId: 'groceries', ...data } })) as IncomingEvent;

  it('sends one StartRoutineRequested per matching routine, logged in the same transaction', async () => {
    const [match, filtered, other, off] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await subscribe(match, 'task.completed', [{ field: 'listId', operator: 'equals', value: 'groceries' }]);
    await subscribe(filtered, 'task.completed', [{ field: 'listId', operator: 'equals', value: 'work' }]);
    await subscribe(other, 'task.created');
    await subscribe(off, 'task.completed', [], false);
    await applyRoutineState(h.pool, { routineId: randomUUID(), ownerId: randomUUID(), version: 1, active: true, event: { type: 'task.completed', filter: [] } });

    const event = taskCompleted();
    assert.deepEqual(await matchEvent(h.pool, event), { started: 1, filtered: 1, loop: 0, inactive: 1 });
    const [start] = await starts();
    assert.deepEqual(contractErrors('start-routine-requested.v1.schema.json', start), []);
    assert.deepEqual(
      { routineId: start.data.routineId, routineVersion: start.data.routineVersion, idempotencyKey: start.data.idempotencyKey, depth: start.data.depth },
      { routineId: match, routineVersion: 3, idempotencyKey: `event:${event.messageId}`, depth: 0 },
    );
    assert.deepEqual(((start.data.trigger as { data: Record<string, unknown> }).data).listId, 'groceries');

    const log = await listDecisions(h.pool, ownerId, filtered);
    assert.deepEqual(log.map((decision) => [decision.event, decision.outcome]), [['task.completed', 'filtered']]);
  });

  it('decides a redelivered event only once – one start, one log row', async () => {
    const id = randomUUID();
    await subscribe(id);
    const event = taskCompleted();
    await matchEvent(h.pool, event);
    assert.deepEqual(await matchEvent(h.pool, event), { started: 0, filtered: 0, loop: 0, inactive: 0 });
    await Promise.all([matchEvent(h.pool, event), matchEvent(h.pool, event)]);
    assert.equal((await starts()).length, 1);
    assert.equal((await listDecisions(h.pool, ownerId, id)).length, 1);
  });

  it('stops a routine triggering itself and chains deeper than 5, and passes the depth on', async () => {
    const self = randomUUID();
    const next = randomUUID();
    await subscribe(self);
    await subscribe(next);
    await matchEvent(h.pool, taskCompleted({ origin: { executionId: randomUUID(), routineId: self, actionId: randomUUID(), depth: 3 } }));
    assert.deepEqual((await listDecisions(h.pool, ownerId, self)).map((decision) => decision.outcome), ['loop']);
    assert.deepEqual((await starts()).map((start) => [start.data.routineId, start.data.depth]), [[next, 3]]);

    await matchEvent(h.pool, taskCompleted({ origin: { executionId: randomUUID(), routineId: randomUUID(), actionId: randomUUID(), depth: 5 } }));
    assert.deepEqual((await listDecisions(h.pool, ownerId, next)).map((decision) => decision.outcome), ['loop', 'started']);
  });

  it('answers the owner\'s log, and nothing about another owner\'s routine', async () => {
    const id = randomUUID();
    await subscribe(id);
    await matchEvent(h.pool, taskCompleted());
    const app = createHttpServer({ service: 'trigger-service-test', logger: silentLogger });
    let userId = ownerId;
    app.decorateRequest('user', null);
    app.addHook('preHandler', async (request) => {
      request.user = { id: userId, email: 'a@routine.local', roles: ['user'] };
    });
    registerRoutes(app, { resync: async () => ({ stored: 0, removed: 0 }), decisions: (owner, routineId) => listDecisions(h.pool, owner, routineId) });
    const mine = await app.inject({ url: `/api/v1/triggers/log?routineId=${id}` });
    assert.equal(mine.json().items[0].outcome, 'started');
    assert.equal((await app.inject({ url: '/api/v1/triggers/log?routineId=nope' })).statusCode, 400);
    userId = randomUUID();
    assert.deepEqual((await app.inject({ url: `/api/v1/triggers/log?routineId=${id}` })).json().items, []);
  });
});
