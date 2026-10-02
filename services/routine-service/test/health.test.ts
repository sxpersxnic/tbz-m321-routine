/** Routine health (06-engine §10) against a real database. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { getRoutine, refreshHealthIfDue, type RoutineRow } from '../src/store.ts';
import { engineHarness, needsDatabase, type EngineHarness } from './support/engine-harness.ts';

describe('routine health', { skip: needsDatabase }, () => {
  let h: EngineHarness;
  before(async () => {
    h = await engineHarness();
  });
  after(async () => {
    await h?.close();
  });

  const routine = (alertAfterFailures?: number | null) =>
    h.routine({ actions: [{ key: 'call', type: 'http.request', step: 1, params: { url: 'http://mock-external:8090/switch/x' } }], alertAfterFailures });

  /** One run of `r` that fails or succeeds; returns the routine's row afterwards. */
  async function run(r: RoutineRow, outcome: 'fail' | 'succeed'): Promise<RoutineRow> {
    const id = await h.run(r);
    const [call] = await h.dispatched(id);
    if (outcome === 'fail') await h.fail(id, call.actionId, 'answered 404', 'NOT_FOUND');
    else await h.complete(id, call.actionId, { status: 200 });
    const row = await getRoutine(h.pool, h.ownerId, r.id);
    assert.ok(row);
    return row;
  }
  const unhealthyFor = async (routineId: string) => (await h.published('RoutineUnhealthy')).filter((message) => message.data.routineId === routineId);

  it('counts failures in a row, and a success resets them', async () => {
    const r = await routine();
    assert.equal((await run(r, 'fail')).consecutive_failures, 1);
    const twice = await run(r, 'fail');
    assert.equal(twice.consecutive_failures, 2);
    assert.ok(twice.last_failure_at);
    const ok = await run(r, 'succeed');
    assert.equal(ok.consecutive_failures, 0);
    assert.ok(ok.last_success_at);
    assert.equal(ok.runs_30d, 3);
    assert.equal(ok.failures_30d, 2);
  });

  it('publishes RoutineUnhealthy once per streak, when the failures reach the threshold', async () => {
    const r = await routine(); // default threshold 2
    await run(r, 'fail');
    assert.equal((await unhealthyFor(r.id)).length, 0);
    await run(r, 'fail');
    await run(r, 'fail');
    const events = await unhealthyFor(r.id);
    assert.equal(events.length, 1, 'not again on the third failure');
    assert.equal(events[0].data.consecutiveFailures, 2);
    assert.equal(events[0].data.lastErrorCode, 'NOT_FOUND');
    assert.equal(events[0].data.routineName, 'Test');

    await run(r, 'succeed');
    await run(r, 'fail');
    await run(r, 'fail');
    assert.equal((await unhealthyFor(r.id)).length, 2, 'a new streak alerts again');
  });

  it("respects the routine's threshold, and never alerts when it is null", async () => {
    const three = await routine(3);
    for (let i = 0; i < 2; i++) await run(three, 'fail');
    assert.equal((await unhealthyFor(three.id)).length, 0);
    await run(three, 'fail');
    assert.equal((await unhealthyFor(three.id)).length, 1);

    const never = await routine(null);
    for (let i = 0; i < 4; i++) await run(never, 'fail');
    assert.equal((await unhealthyFor(never.id)).length, 0);
  });

  it('recomputes the 30-day counts once a day after 03:00 UTC, on one replica', async () => {
    const r = await routine();
    await run(r, 'fail');
    await run(r, 'succeed');
    // one of the runs is old now
    await h.pool.query(`UPDATE executions SET created_at = now() - interval '40 days' WHERE id = (SELECT id FROM executions WHERE routine_id = $1 AND status = 'FAILED')`, [r.id]);

    // today, at fixed times of day (the window counts back 30 days from the given time)
    const today = (time: string, days = 0) => new Date(new Date(`${new Date().toISOString().slice(0, 10)}T${time}Z`).getTime() + days * 86_400_000);
    assert.equal(await refreshHealthIfDue(h.pool, today('02:59:00')), false, 'not before 03:00');
    const results = await Promise.all([refreshHealthIfDue(h.pool, today('03:05:00')), refreshHealthIfDue(h.pool, today('03:05:00'))]);
    assert.deepEqual(results.sort(), [false, true], 'one replica does it');
    assert.equal(await refreshHealthIfDue(h.pool, today('23:00:00')), false, 'once per day');
    const row = await getRoutine(h.pool, h.ownerId, r.id);
    assert.equal(row?.runs_30d, 1);
    assert.equal(row?.failures_30d, 0);
    assert.equal(await refreshHealthIfDue(h.pool, today('03:00:00', 1)), true, 'the next day again');
  });

  it('keeps the threshold when an update leaves it out, and exposes health in the DTO', async () => {
    const app = await h.api();
    const created = await app.inject({ method: 'POST', url: '/api/v1/routines', payload: { name: 'H', trigger: { type: 'manual' }, actions: [{ key: 'w', type: 'weather.get', params: { city: 'Bern' } }], alertAfterFailures: 5 } });
    const id = created.json().id;
    assert.equal(created.json().alertAfterFailures, 5);
    assert.deepEqual(created.json().health, { consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null, runs30d: 0, failures30d: 0 });
    const updated = await app.inject({ method: 'PUT', url: `/api/v1/routines/${id}`, payload: { name: 'H2', trigger: { type: 'manual' }, actions: [{ key: 'w', type: 'weather.get', params: { city: 'Bern' } }] } });
    assert.equal(updated.json().alertAfterFailures, 5);
    const never = await app.inject({ method: 'PUT', url: `/api/v1/routines/${id}`, payload: { name: 'H2', trigger: { type: 'manual' }, actions: [{ key: 'w', type: 'weather.get', params: { city: 'Bern' } }], alertAfterFailures: null } });
    assert.equal(never.json().alertAfterFailures, null);
    const invalid = await app.inject({ method: 'PUT', url: `/api/v1/routines/${id}`, payload: { name: 'H2', trigger: { type: 'manual' }, actions: [{ key: 'w', type: 'weather.get', params: { city: 'Bern' } }], alertAfterFailures: 0 } });
    assert.equal(invalid.statusCode, 400);
    await app.close();
  });
});
