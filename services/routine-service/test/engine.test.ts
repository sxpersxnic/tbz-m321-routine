/** Engine behaviour against a real database (see test/support/engine-harness.ts). */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { executionDto } from '../src/store.ts';
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
});
