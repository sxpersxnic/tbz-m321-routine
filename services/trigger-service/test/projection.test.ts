/** The subscriptions projection (M4-05): version rule, tombstones, resync, the resync routes. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createEnvelope, createHttpServer, type Envelope, type Role } from '@routine/service-kit';
import { parseRoutineMessage, routineState, type RoutineState } from '../src/messages.ts';
import { applyRoutineMessage, applyRoutineState, projectionEmpty, resync } from '../src/projection.ts';
import { routineClient } from '../src/routine-client.ts';
import { registerRoutes } from '../src/routes.ts';
import { harness, needsDatabase, silentLogger, type Harness } from './support/harness.ts';

const ownerId = randomUUID();

/** RoutineSaved data of an event-triggered routine (or another trigger). */
const saved = (routineId: string, version: number, trigger: Record<string, unknown> = { type: 'event', event: 'task.completed' }, active = true) =>
  createEnvelope({ type: 'RoutineSaved', version: 1, source: 'routine-service', correlationId: 'c', data: { routineId, ownerId, version, active, name: 'R', trigger, areaId: null } });

describe('routine messages (tolerant reader)', () => {
  it('reads an event trigger with its filter, and nothing for other triggers', () => {
    const id = randomUUID();
    const message = parseRoutineMessage(saved(id, 2, { type: 'event', event: 'task.completed', filter: [{ field: 'listId', operator: 'equals', value: 'x' }, { bogus: true }] }));
    assert.deepEqual(message, { kind: 'saved', routine: { routineId: id, ownerId, version: 2, active: true, event: { type: 'task.completed', filter: [{ field: 'listId', operator: 'equals', value: 'x' }] } } });
    assert.equal((parseRoutineMessage(saved(id, 3, { type: 'schedule', cron: '0 7 * * *' })) as { routine: RoutineState }).routine.event, null);
    assert.throws(() => routineState({ routineId: id, ownerId }), /without a version/);
  });
});

describe('subscriptions projection', { skip: needsDatabase }, () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(async () => {
    await h?.close();
  });
  beforeEach(async () => {
    await h.pool.query('DELETE FROM subscriptions');
  });

  const row = async (routineId: string) =>
    (await h.pool.query<{ event_type: string | null; routine_version: number; active: boolean; filter: unknown[] }>('SELECT * FROM subscriptions WHERE routine_id = $1', [routineId])).rows[0];
  const apply = (envelope: Envelope) => applyRoutineMessage(h.pool, parseRoutineMessage(envelope));

  it('stores an event trigger and follows newer versions – an older one never wins', async () => {
    const id = randomUUID();
    assert.equal(await apply(saved(id, 2)), 'stored');
    assert.equal(await apply(saved(id, 4, { type: 'event', event: 'task.created' }, false)), 'stored');
    assert.equal(await apply(saved(id, 3)), 'stale', 'arrived late');
    const stored = await row(id);
    assert.deepEqual([stored.event_type, stored.routine_version, stored.active], ['task.created', 4, false]);
    assert.equal(await apply(saved(id, 4, { type: 'event', event: 'task.created' }, false)), 'stored', 'a redelivery is harmless');
  });

  it('keeps a tombstone when the trigger changes, so a late older save cannot bring it back', async () => {
    const id = randomUUID();
    await apply(saved(id, 2));
    assert.equal(await apply(saved(id, 3, { type: 'manual' })), 'removed');
    assert.equal(await apply(saved(id, 2)), 'stale');
    assert.equal((await row(id)).event_type, null);
    assert.equal(await apply(saved(id, 4)), 'stored', 'an event trigger again');
  });

  it('a deleted routine stays deleted, whatever arrives after', async () => {
    const id = randomUUID();
    await apply(saved(id, 2));
    const deleted = createEnvelope({ type: 'RoutineDeleted', version: 1, source: 'routine-service', correlationId: 'c', data: { routineId: id, ownerId } });
    assert.equal(await apply(deleted), 'removed');
    assert.equal(await apply(saved(id, 9)), 'stale');
    assert.equal((await row(id)).event_type, null);
  });

  it('resync rebuilds from the list without undoing what changed meanwhile', async () => {
    const kept = randomUUID();
    const gone = randomUUID();
    const late = randomUUID();
    await apply(saved(kept, 1));
    await apply(saved(gone, 1));
    assert.equal(await projectionEmpty(h.pool), false);

    const result = await resync(h.pool, async () => {
      // consumed while the list was on its way: newer than the list's version, and not in the list
      await applyRoutineState(h.pool, { routineId: kept, ownerId, version: 5, active: false, event: { type: 'task.completed', filter: [] } });
      await applyRoutineState(h.pool, { routineId: late, ownerId, version: 1, active: true, event: { type: 'task.created', filter: [] } });
      return [{ routineId: kept, ownerId, version: 3, active: true, event: { type: 'task.completed', filter: [] } }];
    });
    assert.deepEqual(result, { stored: 0, removed: 1 });
    assert.equal((await row(kept)).routine_version, 5, 'the newer save stays');
    assert.equal(await row(gone), undefined, 'no longer event-triggered');
    assert.ok(await row(late), 'saved after the list was asked for');
  });

  it('starts empty – the cue for the automatic resync', async () => {
    assert.equal(await projectionEmpty(h.pool), true);
  });
});

describe('routine-service client', () => {
  it('asks the internal list with its service token and reads the items', async () => {
    const id = randomUUID();
    let seen: { url: string; authorization: string | null } | undefined;
    const fake: typeof fetch = async (input, init) => {
      seen = { url: String(input), authorization: new Headers(init?.headers).get('authorization') };
      return Response.json({ items: [{ routineId: id, ownerId, version: 2, active: true, name: 'R', trigger: { type: 'event', event: 'task.completed' }, areaId: null }] });
    };
    const client = routineClient('http://routine-service:3000', { token: async () => 'service-token' }, fake);
    assert.deepEqual(await client.eventRoutines(), [{ routineId: id, ownerId, version: 2, active: true, event: { type: 'task.completed', filter: [] } }]);
    assert.deepEqual(seen, { url: 'http://routine-service:3000/internal/v1/routines?trigger=event', authorization: 'Bearer service-token' });
    const failing = routineClient('http://x', { token: async () => 't' }, async () => new Response('', { status: 503 }));
    await assert.rejects(failing.eventRoutines(), /HTTP 503/);
  });
});

describe('resync routes', () => {
  const app = (roles: Role[] | null) => {
    const server = createHttpServer({ service: 'trigger-service-test', logger: silentLogger });
    server.decorateRequest('user', null);
    server.decorateRequest('caller', null);
    server.addHook('preHandler', async (request) => {
      if (roles) request.user = { id: randomUUID(), email: 'a@routine.local', roles };
    });
    registerRoutes(server, { resync: async () => ({ stored: 2, removed: 0 }) });
    return server;
  };

  it('lets an admin resync through the API, nobody else', async () => {
    assert.equal((await app(['user', 'admin']).inject({ method: 'POST', url: '/api/v1/triggers/resync' })).json().stored, 2);
    assert.equal((await app(['user']).inject({ method: 'POST', url: '/api/v1/triggers/resync' })).statusCode, 403);
  });
});
