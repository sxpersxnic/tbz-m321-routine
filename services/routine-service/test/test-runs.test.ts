/** "Try this step" (06-engine §12): test runs through the real routes against a real database. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { deleteExpiredTestRuns, getRoutine, type RoutineRow } from '../src/store.ts';
import { engineHarness, needsDatabase, type EngineHarness } from './support/engine-harness.ts';

describe('test runs', { skip: needsDatabase }, () => {
  let h: EngineHarness;
  let app: FastifyInstance;
  let routine: RoutineRow;
  let sampleId: string;

  before(async () => {
    h = await engineHarness();
    app = await h.api();
    // a routine with one finished run – the sample whose values a test resolves against
    routine = await h.routine({
      actions: [
        { key: 'weather', type: 'weather.get', step: 1, params: { city: 'Bern' } },
        { key: 'notify', type: 'notification.send', step: 2, params: { title: '{{actions.weather.summary}}' } },
      ],
    });
    sampleId = await h.run(routine);
    const [weather] = await h.dispatched(sampleId);
    await h.complete(sampleId, weather.actionId, { summary: 'Bern: sunny', temperatureC: 21 });
    const [, notify] = await h.dispatched(sampleId);
    await h.complete(sampleId, notify.actionId, {});
  });
  after(async () => {
    await app?.close();
    await h?.close();
  });

  const tryStep = async (action: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/routines/test-step', payload: { routineId: routine.id, action, ...extra } });
    return { status: response.statusCode, body: response.json() };
  };

  it("runs a side-effect-free step as a test, with the last run's values, and says so in the command", async () => {
    const { status, body } = await tryStep({ key: 'weather2', type: 'weather.get', step: 3, params: { city: '{{actions.weather.summary}}' } });
    assert.equal(status, 201);
    assert.equal(body.kind, 'test');
    const [command] = (await h.dispatched(body.id)).filter((candidate) => candidate.actionKey === 'weather2');
    assert.equal(command.params.city, 'Bern: sunny', 'references resolve against the sample run');
    assert.equal(command.context?.mode, 'test');
    await h.complete(body.id, command.actionId, { summary: 'ok' });
    assert.equal((await h.execution(body.id))?.status, 'COMPLETED');
  });

  it('evaluates scripting steps right away', async () => {
    const { body } = await tryStep({ key: 'double', type: 'math.calculate', params: { a: '{{actions.weather.temperatureC}}', operator: '*', b: 2 } });
    assert.equal(body.status, 'COMPLETED');
    assert.deepEqual(body.actions.find((action: { key: string }) => action.key === 'double').output, { result: 42 });
  });

  it('skips steps that would change something', async () => {
    const { body } = await tryStep({ key: 'notify', type: 'notification.send', params: { title: 'x' } });
    const notify = body.actions.find((action: { key: string; status: string }) => action.key === 'notify' && action.status !== 'COMPLETED');
    assert.equal(notify.status, 'SKIPPED');
    assert.equal(notify.skipReason, 'test');
    assert.equal(body.status, 'COMPLETED');
    assert.equal((await h.dispatched(body.id)).length, 0, 'nothing sent to a worker');
  });

  it('keeps test runs out of lists, stats, health and events', async () => {
    const before = await getRoutine(h.pool, h.ownerId, routine.id);
    const failed = await tryStep({ key: 'w', type: 'weather.get', params: { city: 'Nowhere' } });
    const [command] = await h.dispatched(failed.body.id);
    await h.fail(failed.body.id, command.actionId, 'no such city', 'INVALID_PARAMS');
    assert.equal((await h.execution(failed.body.id))?.status, 'FAILED');

    const list = (await app.inject({ url: '/api/v1/executions?limit=100' })).json().items;
    assert.ok(list.every((execution: { kind: string }) => execution.kind === 'live'));
    assert.ok(!list.some((execution: { id: string }) => execution.id === failed.body.id));
    const routineRuns = (await app.inject({ url: `/api/v1/routines/${routine.id}/executions` })).json().items;
    assert.deepEqual(routineRuns.map((execution: { id: string }) => execution.id), [sampleId]);
    const stats = (await app.inject({ url: '/api/v1/executions/stats?hours=24' })).json();
    assert.equal(stats.byStatus.FAILED ?? 0, 0);

    const afterwards = await getRoutine(h.pool, h.ownerId, routine.id);
    assert.equal(afterwards?.consecutive_failures, before?.consecutive_failures);
    assert.equal(afterwards?.runs_30d, before?.runs_30d);
    const events = [...(await h.published('ExecutionFailed')), ...(await h.published('ExecutionCompleted'))];
    assert.ok(events.every((event) => event.data.executionId === sampleId), 'only the live run announced itself');
  });

  it('sends context.mode live for real runs', async () => {
    const commands = await h.dispatched(sampleId);
    assert.deepEqual(commands.map((command) => command.context?.mode), ['live', 'live']);
    assert.equal(commands[0].context?.routineName, 'Test');
  });

  it("refuses unknown types and other people's sample runs; deletes test runs after the TTL", async () => {
    assert.equal((await tryStep({ key: 'x', type: 'nope.nothing' })).status, 422);
    assert.equal((await tryStep({ key: 'x', type: 'weather.get' }, { sampleExecutionId: '00000000-0000-4000-8000-000000000000' })).status, 404);

    const { body } = await tryStep({ key: 'double', type: 'math.calculate', params: { a: 1, operator: '+', b: 1 } });
    assert.equal(await deleteExpiredTestRuns(h.pool, 3_600_000), 0, 'young test runs stay');
    await h.pool.query(`UPDATE executions SET created_at = now() - interval '2 hours' WHERE id = $1`, [body.id]);
    assert.ok((await deleteExpiredTestRuns(h.pool, 3_600_000)) >= 1);
    assert.equal(await h.execution(body.id), null);
    assert.ok(await h.execution(sampleId), 'live runs are never deleted');
  });
});
