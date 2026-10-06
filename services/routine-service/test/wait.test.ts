/** flow.wait (06-engine §9): durations, the next wall-clock time, the 7-day limit. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { durationMs, MAX_WAIT_MS, wakeAt, waitIssue } from '../src/domain/wait.ts';
import { engineHarness, needsDatabase, type EngineHarness } from './support/engine-harness.ts';

describe('Wait', () => {
  it('reads ISO 8601 durations', () => {
    assert.equal(durationMs('PT2H'), 7_200_000);
    assert.equal(durationMs('PT1H30M'), 5_400_000);
    assert.equal(durationMs('P1DT12H'), 36 * 3_600_000);
    assert.equal(durationMs('P1W'), 7 * 24 * 3_600_000);
    assert.equal(durationMs('PT0.5S'), 500);
    assert.equal(durationMs('2 hours'), null);
    assert.equal(durationMs('P'), null);
    assert.equal(durationMs('PT'), null);
  });

  it('needs exactly one of "for" and "until", and at most 7 days', () => {
    assert.match(waitIssue({}) ?? '', /either/);
    assert.match(waitIssue({ for: 'PT1H', until: '17:00' }) ?? '', /either/);
    assert.equal(waitIssue({ for: 'PT1H' }), null);
    assert.equal(waitIssue({ for: 'P7D' }), null);
    assert.equal(waitIssue({ for: '{{vars.delay}}' }), null, 'checked when it runs');
    assert.match(waitIssue({ for: 'P8D' }) ?? '', /7 days/);
    assert.match(waitIssue({ for: 'P1M' }) ?? '', /7 days/);
    assert.ok(MAX_WAIT_MS === 7 * 24 * 3_600_000);
  });

  it('wakes after a duration', () => {
    const now = new Date('2026-10-01T08:00:00Z');
    assert.equal(wakeAt({ for: 'PT15M' }, now, 'Europe/Zurich').toISOString(), '2026-10-01T08:15:00.000Z');
    assert.throws(() => wakeAt({ for: 'soon' }, now, 'Europe/Zurich'), /not a duration/);
    assert.throws(() => wakeAt({ for: 'P10D' }, now, 'Europe/Zurich'), /7 days/);
  });

  it('wakes at the next HH:mm on the owner\'s clock – today if ahead, else tomorrow, across DST', () => {
    // 10:00 in Zurich (CEST, UTC+2) – 17:00 is still ahead today
    assert.equal(wakeAt({ until: '17:00' }, new Date('2026-10-01T08:00:00Z'), 'Europe/Zurich').toISOString(), '2026-10-01T15:00:00.000Z');
    // 18:00 in Zurich – the next 17:00 is tomorrow
    assert.equal(wakeAt({ until: '17:00' }, new Date('2026-10-01T16:00:00Z'), 'Europe/Zurich').toISOString(), '2026-10-02T15:00:00.000Z');
    // the night summer time ends (25 Oct 2026): 07:00 CET is 06:00 UTC
    assert.equal(wakeAt({ until: '07:00' }, new Date('2026-10-24T20:00:00Z'), 'Europe/Zurich').toISOString(), '2026-10-25T06:00:00.000Z');
    assert.throws(() => wakeAt({ until: '25:00' }, new Date(), 'Europe/Zurich'), /not a time/);
  });
});

describe('Wait in a run', { skip: needsDatabase }, () => {
  let h: EngineHarness;
  before(async () => {
    h = await engineHarness();
  });
  after(async () => {
    await h?.close();
  });

  const routine = (wait: Record<string, unknown>) =>
    h.routine({
      actions: [
        { key: 'pause', type: 'flow.wait', step: 1, params: wait },
        { key: 'after', type: 'variable.set', step: 2, params: { name: 'done', value: 'yes' } },
      ],
    });

  it('sleeps as SCHEDULED – the run is DELAYED – and goes on once housekeeping wakes it', async () => {
    const id = await h.run(await routine({ for: 'PT0S' }));
    const pause = (await h.actions(id)).pause;
    assert.equal(pause.status, 'SCHEDULED');
    assert.ok(pause.wake_at);
    assert.equal((await h.execution(id))?.status, 'DELAYED');

    await Promise.all([h.engine.wakeDueWaits(), h.engine.wakeDueWaits()]);
    const actions = await h.actions(id);
    assert.equal(actions.pause.status, 'COMPLETED');
    assert.ok(actions.pause.output?.wokeAt);
    assert.equal(actions.after.status, 'COMPLETED');
    assert.equal((await h.execution(id))?.status, 'COMPLETED');
    assert.equal((await h.log(id)).filter((entry) => entry.message === 'Waited long enough').length, 1, 'woken once');
  });

  it('waits until a time of day – nothing wakes before it', async () => {
    const id = await h.run(await routine({ until: '03:00' }));
    const pause = (await h.actions(id)).pause;
    assert.ok(pause.wake_at && pause.wake_at.getTime() > Date.now());
    assert.equal(await h.engine.wakeDueWaits(), 0);
    assert.equal(await h.engine.cancel(id, h.ownerId), 'cancelled');
    assert.equal((await h.actions(id)).pause.status, 'SKIPPED');
  });

  it('fails a wait whose templated duration turns out wrong', async () => {
    const id = await h.run(await h.routine({
      actions: [
        { key: 'delay', type: 'variable.set', step: 1, params: { name: 'delay', value: 'P30D' } },
        { key: 'pause', type: 'flow.wait', step: 2, params: { for: '{{vars.delay}}' } },
      ],
    }));
    const pause = (await h.actions(id)).pause;
    assert.equal(pause.status, 'FAILED');
    assert.equal(pause.error_code, 'INVALID_PARAMS');
    assert.match(pause.error ?? '', /7 days/);
  });

  it('a test of a Wait step does not wait', async () => {
    const saved = await routine({ for: 'PT1H' });
    const app = await h.api();
    const response = await app.inject({ method: 'POST', url: '/api/v1/routines/test-step', payload: { routineId: saved.id, action: { key: 'pause', type: 'flow.wait', params: { for: 'PT1H' } } } });
    await app.close();
    assert.equal(response.json().status, 'COMPLETED');
  });

  it('refuses a wait without a time, or longer than 7 days, when saving', async () => {
    await assert.rejects(routine({}), /either/);
    await assert.rejects(routine({ for: 'P8D' }), /7 days/);
  });
});
