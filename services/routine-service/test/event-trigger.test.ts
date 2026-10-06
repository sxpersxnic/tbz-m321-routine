/** Event triggers in routine-service (M4-02, M4-03): the definition, RoutineSaved / RoutineDeleted, the internal list, StartRoutineRequested. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createEnvelope } from '@routine/service-kit';
import type { FastifyInstance } from 'fastify';
import { contractErrors } from '../../../contracts/validate.ts';
import { type DefinitionError, type RoutineInput, validateRoutine } from '../src/domain/definition.ts';
import { parseStartRoutineRequested } from '../src/messages.ts';
import { engineHarness, needsDatabase, type EngineHarness } from './support/engine-harness.ts';

/** A routine that runs when another routine fails – `execution.failed` is a trigger of the built-in `routines` domain. */
const onFailure = (trigger: Record<string, unknown> = {}, value = 'Fix {{trigger.event.routineName}}'): RoutineInput => ({
  name: 'When a routine fails',
  trigger: { type: 'event', event: 'execution.failed', ...trigger } as RoutineInput['trigger'],
  actions: [{ key: 'note', type: 'variable.set', params: { name: 'result', value } }],
});

const issues = (input: RoutineInput) => {
  try {
    validateRoutine(input);
    return [];
  } catch (error) {
    return (error as DefinitionError).issues;
  }
};

describe('event trigger definition (06 §2.1)', () => {
  it('keeps a known event with its filter, and reads its fields as {{trigger.event.<field>}}', () => {
    const definition = validateRoutine(onFailure({ filter: [{ field: 'errorCode', operator: 'equals', value: 'NOT_FOUND' }] }));
    assert.deepEqual(definition.trigger, { type: 'event', event: 'execution.failed', filter: [{ field: 'errorCode', operator: 'equals', value: 'NOT_FOUND' }] });
    assert.deepEqual(validateRoutine(onFailure()).trigger, { type: 'event', event: 'execution.failed' }, 'no filter = every event');
  });

  it('refuses an unknown event, an unknown field, an unknown comparison and more than 5 conditions', () => {
    assert.deepEqual(issues(onFailure({ event: 'nothing.happened' })), ['unknown event "nothing.happened"']);
    assert.deepEqual(issues(onFailure({ filter: [{ field: 'colour', operator: 'equals', value: 'red' }] })), ['unknown field "colour" of "execution.failed"']);
    assert.deepEqual(issues(onFailure({ filter: [{ field: 'errorCode', operator: 'between' }] })), ['unknown comparison "between"']);
    const six = Array.from({ length: 6 }, () => ({ field: 'errorCode', operator: 'isNotEmpty' }));
    assert.deepEqual(issues(onFailure({ filter: six })), ['an event trigger can check at most 5 conditions']);
  });

  it('{{trigger.event.<field>}} only in an event-triggered routine, and only fields the event has', () => {
    assert.deepEqual(issues(onFailure({}, '{{trigger.event.colour}}')), ['action "note": the event "execution.failed" has no field "colour"']);
    assert.deepEqual(issues({ ...onFailure(), trigger: { type: 'manual' } }), ['action "note": "{{trigger.event.routineName}}" is only available for event triggers']);
  });
});

describe('routine events and the internal list', { skip: needsDatabase }, () => {
  let h: EngineHarness;
  let app: FastifyInstance;
  before(async () => {
    h = await engineHarness();
    app = await h.api();
  });
  after(async () => {
    await app?.close();
    await h?.close();
  });

  const savedOf = async (routineId: string) => (await h.published('RoutineSaved')).filter((message) => message.data.routineId === routineId);

  it('announces every version – create, edit, activate, deactivate, restore – and the delete', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/routines', payload: onFailure() });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().id as string;
    await app.inject({ method: 'POST', url: `/api/v1/routines/${id}/activate` });
    await app.inject({ method: 'PUT', url: `/api/v1/routines/${id}`, payload: onFailure({ filter: [{ field: 'errorCode', operator: 'isNotEmpty' }] }) });
    await app.inject({ method: 'POST', url: `/api/v1/routines/${id}/deactivate` });
    await app.inject({ method: 'POST', url: `/api/v1/routines/${id}/versions/1/restore` });

    const saved = await savedOf(id);
    assert.deepEqual(saved.map((message) => [message.data.version, message.data.active]), [[1, false], [2, true], [3, true], [4, false], [5, false]]);
    assert.deepEqual((saved[2].data.trigger as { filter: unknown[] }).filter, [{ field: 'errorCode', operator: 'isNotEmpty' }]);
    assert.deepEqual((saved[4].data.trigger as { filter?: unknown }).filter, undefined, 'restore brings version 1 back');
    for (const message of saved) assert.deepEqual(contractErrors('routine-saved.v1.schema.json', message), []);

    assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/routines/${id}` })).statusCode, 204);
    const deleted = (await h.published('RoutineDeleted')).filter((message) => message.data.routineId === id);
    assert.equal(deleted.length, 1);
    assert.deepEqual(contractErrors('routine-deleted.v1.schema.json', deleted[0]), []);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/routines/${id}` })).statusCode, 404);
    assert.equal((await h.published('RoutineDeleted')).filter((message) => message.data.routineId === id).length, 1, 'nothing announced for nothing deleted');
  });

  it('lists every event-triggered routine to a service – and to nobody else', async () => {
    const event = await app.inject({ method: 'POST', url: '/api/v1/routines', payload: onFailure() });
    const manual = await app.inject({ method: 'POST', url: '/api/v1/routines', payload: { ...onFailure(), trigger: { type: 'manual' }, actions: [{ key: 'x', type: 'variable.set', params: { name: 'x', value: 1 } }] } });
    assert.equal(manual.statusCode, 201, manual.body);

    assert.equal((await app.inject({ url: '/internal/v1/routines?trigger=event' })).statusCode, 401, 'a user is not a service');
    const listed = await app.inject({ url: '/internal/v1/routines?trigger=event', headers: { 'x-test-service': 'trigger-service' } });
    assert.equal(listed.statusCode, 200);
    const ids = listed.json().items.map((item: { routineId: string }) => item.routineId);
    assert.ok(ids.includes(event.json().id));
    assert.ok(!ids.includes(manual.json().id));
    const item = listed.json().items.find((candidate: { routineId: string }) => candidate.routineId === event.json().id);
    assert.deepEqual(contractErrors('routine-saved.v1.schema.json', { messageId: randomUUID(), type: 'RoutineSaved', version: 1, occurredAt: new Date().toISOString(), source: 'x', correlationId: 'x', data: item }), [], 'same shape as RoutineSaved');
  });

  it('refuses an event trigger through the API with what is wrong (422)', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/routines', payload: onFailure({ event: 'nothing.happened' }) });
    assert.equal(response.statusCode, 422);
    assert.deepEqual(response.json().errors, ['unknown event "nothing.happened"']);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/routines', payload: { ...onFailure(), trigger: { type: 'event' } } })).statusCode, 400, 'an event trigger names its event');
  });
});

describe('StartRoutineRequested (05 §4.3)', { skip: needsDatabase }, () => {
  let h: EngineHarness;
  let app: FastifyInstance;
  before(async () => {
    h = await engineHarness();
    app = await h.api();
  });
  after(async () => {
    await app?.close();
    await h?.close();
  });

  /** An event-triggered routine, created and activated through the API (version 2). */
  const eventRoutine = async (input: RoutineInput = onFailure()) => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/routines', payload: input });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().id as string;
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/routines/${id}/activate` })).statusCode, 200);
    return id;
  };

  /** The command trigger-service sends for one `execution.failed` event – checked against its contract. */
  const command = (routineId: string, { routineVersion = 2, depth = 0, eventMessageId = randomUUID(), data = {} as Record<string, unknown> } = {}) => {
    const envelope = createEnvelope({
      type: 'StartRoutineRequested',
      version: 1,
      source: 'trigger-service',
      correlationId: randomUUID(),
      data: {
        routineId,
        ownerId: h.ownerId,
        routineVersion,
        trigger: { type: 'event', event: 'execution.failed', eventMessageId, data: { routineName: 'Backup', errorCode: 'TIMEOUT', ...data } },
        idempotencyKey: `event:${eventMessageId}`,
        depth,
      },
    });
    assert.deepEqual(contractErrors('start-routine-requested.v1.schema.json', envelope), []);
    return parseStartRoutineRequested(envelope);
  };

  const runsOf = async (routineId: string) =>
    (await h.pool.query<{ id: string }>('SELECT id FROM executions WHERE routine_id = $1', [routineId])).rows.map((row) => row.id);

  it('starts the run with the event: trigger "event", {{trigger.event.<field>}}, depth on its steps and events', async () => {
    const id = await eventRoutine({
      ...onFailure(),
      actions: [
        { key: 'note', type: 'variable.set', params: { name: 'result', value: 'Fix {{trigger.event.routineName}}' } },
        { key: 'call', type: 'http.request', params: { method: 'GET', url: 'https://example.com/{{trigger.event.errorCode}}' } },
      ],
    });
    const execution = await h.engine.startFromEvent(command(id, { depth: 2 }));
    assert.ok(execution);
    assert.equal(execution.trigger_type, 'event');
    assert.equal(execution.depth, 2);
    assert.equal(execution.trigger_event?.event, 'execution.failed');

    const triggered = (await h.published('RoutineTriggered')).find((message) => message.data.executionId === execution.id);
    assert.equal(triggered?.data.trigger, 'event');
    assert.deepEqual(contractErrors('routine-triggered.v1.schema.json', triggered), []);
    assert.equal((await h.log(execution.id))[0].message, 'Started by execution.failed');

    await h.engine.start(execution.id);
    assert.equal((await h.actions(execution.id)).note.output?.value, 'Fix Backup');
    const [call] = await h.dispatched(execution.id);
    assert.equal(call.params.url, 'https://example.com/TIMEOUT');
    assert.equal(call.context?.depth, 2, 'the step knows how deep in the chain it runs');

    await h.complete(execution.id, call.actionId, { status: 200 });
    const completed = (await h.published('ExecutionCompleted')).find((message) => message.data.executionId === execution.id);
    assert.equal(completed?.data.depth, 2, 'trigger-service derives the origin of execution events from it');

    const detail = await app.inject({ url: `/api/v1/executions/${execution.id}` });
    assert.equal(detail.json().trigger, 'event');
    assert.equal(detail.json().depth, 2);
    assert.equal(detail.json().triggerEvent.data.routineName, 'Backup');
  });

  it('starts one run for a command delivered twice', async () => {
    const id = await eventRoutine();
    const once = command(id);
    const first = await h.engine.startFromEvent(once);
    const second = await h.engine.startFromEvent(once);
    assert.equal(second?.id, first?.id);
    assert.deepEqual(await runsOf(id), [first?.id]);
    assert.equal((await h.published('RoutineTriggered')).filter((message) => message.data.routineId === id).length, 1);
  });

  it('drops a command for an inactive or deleted routine', async () => {
    const id = await eventRoutine();
    await app.inject({ method: 'POST', url: `/api/v1/routines/${id}/deactivate` });
    assert.equal(await h.engine.startFromEvent(command(id, { routineVersion: 3 })), null);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/routines/${id}` })).statusCode, 204);
    assert.equal(await h.engine.startFromEvent(command(id, { routineVersion: 3 })), null);
    assert.deepEqual(await runsOf(id), []);
  });

  it('drops a command matched against an older version whose trigger or filter changed since', async () => {
    const id = await eventRoutine();
    await app.inject({ method: 'PUT', url: `/api/v1/routines/${id}`, payload: { ...onFailure({ event: 'execution.completed' }) } });
    assert.equal(await h.engine.startFromEvent(command(id)), null, 'now starts on another event');

    await app.inject({ method: 'PUT', url: `/api/v1/routines/${id}`, payload: onFailure({ filter: [{ field: 'errorCode', operator: 'equals', value: 'NOT_FOUND' }] }) });
    assert.equal(await h.engine.startFromEvent(command(id)), null, 'the newer filter lets TIMEOUT no longer through');
    assert.ok(await h.engine.startFromEvent(command(id, { data: { errorCode: 'NOT_FOUND' } })), 'but NOT_FOUND still');
    assert.equal((await runsOf(id)).length, 1);
  });

  it('refuses a malformed command for good', () => {
    const envelope = createEnvelope({ type: 'StartRoutineRequested', version: 1, source: 'x', correlationId: 'x', data: { routineId: randomUUID(), trigger: { type: 'schedule' } } });
    assert.throws(() => parseStartRoutineRequested(envelope), /without an event trigger/);
  });
});
