/** Engine behaviour against a real database (see test/support/engine-harness.ts). */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { validateRoutine } from '../src/domain/definition.ts';
import { executionDto, updateRoutine } from '../src/store.ts';
import { engineHarness, needsDatabase, type EngineHarness } from './support/engine-harness.ts';

describe('engine', { skip: needsDatabase }, () => {
  let h: EngineHarness;
  before(async () => {
    h = await engineHarness();
  });
  after(async () => {
    await h?.close();
  });

  describe('skip reasons (06-engine §6)', () => {
    it('marks a step whose condition did not hold as skipped for `condition`', async () => {
      const routine = await h.routine({
        actions: [
          { key: 'check', type: 'condition.if', step: 1, params: { left: 1, operator: 'equals', right: 2 } },
          { key: 'yes', type: 'variable.set', step: 2, runIf: { action: 'check', is: true }, params: { name: 'x', value: 1 } },
          { key: 'no', type: 'variable.set', step: 2, runIf: { action: 'check', is: false }, params: { name: 'x', value: 2 } },
        ],
      });
      const id = await h.run(routine);
      const actions = await h.actions(id);
      assert.equal((await h.execution(id))?.status, 'COMPLETED');
      assert.equal(actions.yes.status, 'SKIPPED');
      assert.equal(actions.yes.skip_reason, 'condition');
      assert.equal(actions.no.status, 'COMPLETED');
      assert.equal(actions.no.skip_reason, null);
    });

    it('marks the steps after a failure as skipped for `failure`, with the error code on the failed one', async () => {
      const routine = await h.routine({
        actions: [
          { key: 'call', type: 'http.request', step: 1, params: { url: 'http://mock-external:8090/status/404' } },
          { key: 'notify', type: 'notification.send', step: 2, params: { title: 'never' } },
        ],
      });
      const id = await h.run(routine);
      const [call] = await h.dispatched(id);
      await h.fail(id, call.actionId, 'answered 404', 'NOT_FOUND');

      const actions = await h.actions(id);
      assert.equal((await h.execution(id))?.status, 'FAILED');
      assert.equal(actions.call.error_code, 'NOT_FOUND');
      assert.equal(actions.notify.status, 'SKIPPED');
      assert.equal(actions.notify.skip_reason, 'failure');
    });

    it('exposes skipReason and errorCode in the execution DTO', async () => {
      const routine = await h.routine({
        actions: [
          { key: 'call', type: 'http.request', step: 1, params: { url: 'http://mock-external:8090/status/404' } },
          { key: 'notify', type: 'notification.send', step: 2, params: { title: 'never' } },
        ],
      });
      const id = await h.run(routine);
      const [call] = await h.dispatched(id);
      await h.fail(id, call.actionId, 'answered 404', 'NOT_FOUND');
      const execution = await h.execution(id);
      assert.ok(execution);
      const dto = executionDto(execution, Object.values(await h.actions(id)), []);
      assert.equal(dto.errorCode, 'NOT_FOUND');
      assert.deepEqual(
        dto.actions?.map((action) => [action.key, action.status, action.skipReason, action.errorCode]),
        [
          ['call', 'FAILED', null, 'NOT_FOUND'],
          ['notify', 'SKIPPED', 'failure', null],
        ],
      );
    });
  });

  describe('resume (06-engine §6, routine-service §10)', () => {
    const plan = {
      actions: [
        { key: 'weather', type: 'weather.get', step: 1, params: { city: 'Bern' } },
        { key: 'check', type: 'condition.if', step: 1, params: { left: 1, operator: 'equals', right: 2 } },
        { key: 'onlyIf', type: 'variable.set', step: 2, runIf: { action: 'check', is: true }, params: { name: 'x', value: 1 } },
        { key: 'call', type: 'http.request', step: 2, params: { url: 'http://mock-external:8090/status/404' } },
        { key: 'notify', type: 'notification.send', step: 3, params: { title: '{{actions.weather.summary}}' } },
      ],
    };

    /** Runs the plan until "call" failed: weather done, onlyIf skipped by its condition, notify skipped by the failure. */
    async function failedRun() {
      const routine = await h.routine(plan);
      const id = await h.run(routine);
      const [weather] = await h.dispatched(id);
      await h.complete(id, weather.actionId, { summary: 'Bern: sunny' });
      const call = (await h.dispatched(id)).find((command) => command.actionKey === 'call');
      assert.ok(call);
      await h.fail(id, call.actionId, 'answered 404', 'NOT_FOUND');
      assert.equal((await h.execution(id))?.status, 'FAILED');
      return { routine, id, call };
    }

    it('reruns the failed step with the same actionId and the steps skipped because of it; the rest stays', async () => {
      const { id, call } = await failedRun();
      const before = await h.actions(id);

      assert.equal(await h.engine.resume(id, h.ownerId, h.ownerId), 'resumed');
      const actions = await h.actions(id);
      const execution = await h.execution(id);
      assert.equal(execution?.status, 'RUNNING');
      assert.equal(execution?.resume_count, 1);
      assert.equal(execution?.error, null);
      assert.deepEqual(actions.weather.output, before.weather.output, 'earlier outputs unchanged');
      assert.equal(actions.onlyIf.status, 'SKIPPED', 'a condition skip stays');
      assert.equal(actions.onlyIf.skip_reason, 'condition');
      assert.equal(actions.call.status, 'DISPATCHED');
      assert.equal(actions.call.error_code, null);
      assert.equal(actions.notify.status, 'PENDING', 'waits for the rerun step');

      const calls = (await h.dispatched(id)).filter((command) => command.actionKey === 'call');
      assert.equal(calls.length, 2);
      assert.equal(calls[1].actionId, call.actionId, 'same idempotency key for the worker');

      await h.complete(id, call.actionId, { status: 200 });
      const notify = (await h.dispatched(id)).find((command) => command.actionKey === 'notify');
      assert.equal(notify?.params.title, 'Bern: sunny', 'templates still see the earlier outputs');
      await h.complete(id, notify?.actionId ?? '', {});
      assert.equal((await h.execution(id))?.status, 'COMPLETED');
    });

    it('publishes ExecutionResumed and logs RESUMED', async () => {
      const { routine, id } = await failedRun();
      await h.engine.resume(id, h.ownerId, h.ownerId);
      const resumed = (await h.published('ExecutionResumed')).find((message) => message.data.executionId === id);
      assert.deepEqual(resumed?.data, { executionId: id, routineId: routine.id, ownerId: h.ownerId, fromActionKey: 'call', resumedBy: h.ownerId, resumeCount: 1 });
      assert.ok((await h.log(id)).some((entry) => entry.kind === 'RESUMED' && entry.action_key === 'call'));
    });

    it('runs the step with the routine\'s current settings (Edit step, then Retry from here)', async () => {
      const { routine, id, call } = await failedRun();
      const fixed = structuredClone(plan);
      fixed.actions[3].params.url = 'http://mock-external:8090/status/200';
      await updateRoutine(h.pool, routine, validateRoutine({ name: 'Test', trigger: { type: 'manual' }, ...fixed }), null);

      await h.engine.resume(id, h.ownerId, h.ownerId);
      const rerun = (await h.dispatched(id)).filter((command) => command.actionKey === 'call').at(-1);
      assert.equal(rerun?.actionId, call.actionId);
      assert.equal(rerun?.params.url, 'http://mock-external:8090/status/200');
    });

    it('counts resumes, and a second failure carries the resume count', async () => {
      const { id, call } = await failedRun();
      await h.engine.resume(id, h.ownerId, h.ownerId);
      await h.fail(id, call.actionId, 'answered 404 again', 'NOT_FOUND');
      const failures = (await h.published('ExecutionFailed')).filter((message) => message.data.executionId === id);
      assert.deepEqual(failures.map((message) => message.data.resumeCount), [0, 1]);
      await h.engine.resume(id, h.ownerId, h.ownerId);
      assert.equal((await h.execution(id))?.resume_count, 2);
    });

    it('refuses runs that are not failed, and other owners\' runs', async () => {
      const { id } = await failedRun();
      assert.equal(await h.engine.resume(id, randomUUID(), randomUUID()), 'not_found');
      assert.equal(await h.engine.resume(randomUUID(), h.ownerId, h.ownerId), 'not_found');
      await h.engine.resume(id, h.ownerId, h.ownerId);
      assert.equal(await h.engine.resume(id, h.ownerId, h.ownerId), 'not_failed', 'already running again');
    });

    it('reruns only the failed item of a loop', async () => {
      const routine = await h.routine({
        actions: [
          { key: 'team', type: 'variable.set', step: 1, params: { name: 'team', value: ['ada@example.com', 'bob@example.com'] } },
          { key: 'mail', type: 'email.send', step: 2, forEach: '{{vars.team}}', params: { to: '{{item}}', subject: 'Hi' } },
        ],
      });
      const id = await h.run(routine);
      const [ada, bob] = await h.dispatched(id);
      await h.complete(id, ada.actionId, { messageId: 'm1' });
      await h.fail(id, bob.actionId, 'mail provider down', 'UNREACHABLE');
      assert.equal((await h.execution(id))?.status, 'FAILED');

      await h.engine.resume(id, h.ownerId, h.ownerId);
      const mails = (await h.dispatched(id)).filter((command) => command.actionType === 'email.send');
      assert.deepEqual(mails.map((command) => command.actionId), [ada.actionId, bob.actionId, bob.actionId]);
      assert.equal(mails[2].params.to, 'bob@example.com');
      await h.complete(id, bob.actionId, { messageId: 'm2' });
      assert.equal((await h.execution(id))?.status, 'COMPLETED');
    });
  });
});
