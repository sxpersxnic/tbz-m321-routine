/**
 * Loop protection end to end (M4-07): events carry `origin` exactly as the domain kit writes them
 * (emitEvent with the step's context.depth + 1), and a routine that causes the event it starts on
 * runs once, then is stopped – logged as `loop`.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { emitEvent, withTransaction, type Envelope } from '@routine/service-kit';
import { listDecisions, matchEvent, readEvent, type IncomingEvent } from '../src/matching.ts';
import { applyRoutineState } from '../src/projection.ts';
import { harness, needsDatabase, type Harness } from './support/harness.ts';

describe('a routine that creates a task in the list it watches', { skip: needsDatabase }, () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(async () => {
    await h?.close();
  });

  const ownerId = randomUUID();
  const routineId = randomUUID();
  const listId = randomUUID();

  /** task.created as task-service emits it through the kit – with origin when a routine step created the task. */
  const taskCreated = async (origin?: { executionId: string; routineId: string; actionId: string; depth: number }): Promise<IncomingEvent> => {
    const taskId = randomUUID();
    await withTransaction(h.pool, (tx) => emitEvent(tx, 'task-service', 'task.created', { ownerId, taskId, title: 'Water plants', listId }, origin));
    const { rows } = await h.pool.query<{ payload: Envelope }>(`SELECT payload FROM outbox WHERE payload->'data'->>'taskId' = $1`, [taskId]);
    return readEvent(rows[0].payload) as IncomingEvent;
  };
  const startsFor = async (id: string) =>
    (await h.pool.query<{ payload: { data: { depth: number } } }>(`SELECT payload FROM outbox WHERE payload->>'type' = 'StartRoutineRequested' AND payload->'data'->>'routineId' = $1`, [id])).rows;

  it('runs once for the task a person created, then stops at its own task', async () => {
    await applyRoutineState(h.pool, { routineId, ownerId, version: 1, active: true, event: { type: 'task.created', filter: [{ field: 'listId', operator: 'equals', value: listId }] } });

    // 1. a person adds a task to the list (HTTP – no origin) → the routine starts at depth 0
    await matchEvent(h.pool, await taskCreated());
    const [start] = await startsFor(routineId);
    assert.equal(start.payload.data.depth, 0);

    // 2. its task.create step runs with context.depth = the run's depth; the kit adds 1
    const own = await taskCreated({ executionId: randomUUID(), routineId, actionId: randomUUID(), depth: start.payload.data.depth + 1 });
    await matchEvent(h.pool, own);

    assert.equal((await startsFor(routineId)).length, 1, 'ran once');
    assert.deepEqual((await listDecisions(h.pool, ownerId, routineId)).map((decision) => decision.outcome), ['loop', 'started']);
  });

  it('two routines feeding each other stop at depth 5', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const otherList = randomUUID();
    // A watches the list and creates tasks in the other list; B does it the other way round
    await applyRoutineState(h.pool, { routineId: a, ownerId, version: 1, active: true, event: { type: 'task.created', filter: [{ field: 'listId', operator: 'equals', value: listId }] } });
    await applyRoutineState(h.pool, { routineId: b, ownerId, version: 1, active: true, event: { type: 'task.created', filter: [{ field: 'listId', operator: 'equals', value: otherList }] } });

    let depth = 0;
    let runs = 0;
    let nextList = listId;
    let cause: string | undefined;
    for (let round = 0; round < 10; round++) {
      const taskId = randomUUID();
      const origin = cause ? { executionId: randomUUID(), routineId: cause, actionId: randomUUID(), depth } : undefined;
      await withTransaction(h.pool, (tx) => emitEvent(tx, 'task-service', 'task.created', { ownerId, taskId, title: 'Ping', listId: nextList }, origin));
      const { rows } = await h.pool.query<{ payload: Envelope }>(`SELECT payload FROM outbox WHERE payload->'data'->>'taskId' = $1`, [taskId]);
      const counts = await matchEvent(h.pool, readEvent(rows[0].payload) as IncomingEvent);
      if (counts.started === 0) break;
      runs++;
      // the started run (depth = this event's origin depth, 0 for a person) creates a task in the other list
      cause = nextList === listId ? a : b;
      depth = (origin?.depth ?? 0) + 1;
      nextList = nextList === listId ? otherList : listId;
    }
    assert.equal(runs, 5, 'the 5th generation still runs, its event starts nothing');
  });
});
