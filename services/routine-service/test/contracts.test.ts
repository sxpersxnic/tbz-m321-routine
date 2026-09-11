/** Consumer-driven contract tests: messages produced by this service must match contracts/schemas. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { createEnvelope } from '@routine/service-kit';
import { contractErrors } from '../../../contracts/validate.ts';
import { actionRequested, executionCompleted, executionFailed, parseActionResult, routineTriggered } from '../src/messages.ts';

const ids = { executionId: randomUUID(), routineId: randomUUID(), ownerId: randomUUID(), correlationId: randomUUID() };

describe('routine-service produces valid messages', () => {
  it('RoutineTriggered v1', () => {
    const message = routineTriggered({ ...ids, trigger: 'schedule', scheduledFor: new Date() });
    assert.deepEqual(contractErrors('routine-triggered.v1.schema.json', message.envelope), []);
    assert.equal(message.routingKey, 'routine.triggered');
  });

  it('ActionRequested v1 routed by action type', () => {
    const message = actionRequested({ ...ids, actionId: randomUUID(), actionKey: 'weather', actionType: 'weather.get', params: { city: 'Bern' } });
    assert.deepEqual(contractErrors('action-requested.v1.schema.json', message.envelope), []);
    assert.equal(message.routingKey, 'action.weather.get');
  });

  it('ExecutionFailed v1', () => {
    const message = executionFailed({ ...ids, routineName: 'X', reason: 'boom', failedActionKey: 'a' });
    assert.deepEqual(contractErrors('execution-failed.v1.schema.json', message.envelope), []);
  });

  describe('ExecutionCompleted – expand and contract', () => {
    const input = { ...ids, routineName: 'Weekly Review', durationMs: 1234 };

    it('v1 format satisfies the v1 contract only', () => {
      const { envelope } = executionCompleted(input, 'v1');
      assert.deepEqual(contractErrors('execution-completed.v1.schema.json', envelope), []);
      assert.notDeepEqual(contractErrors('execution-completed.v2.schema.json', envelope), []);
    });

    it('expand format is readable by v1 consumers and valid v2', () => {
      const { envelope } = executionCompleted(input, 'expand');
      assert.deepEqual(contractErrors('execution-completed.v2.schema.json', envelope), []);
      assert.equal(typeof (envelope.data as Record<string, unknown>).message, 'string', 'v1 field still present');
    });

    it('v2 format drops the legacy field', () => {
      const { envelope } = executionCompleted(input, 'v2');
      assert.deepEqual(contractErrors('execution-completed.v2.schema.json', envelope), []);
      assert.equal((envelope.data as Record<string, unknown>).message, undefined);
    });
  });
});

describe('routine-service reads results tolerantly', () => {
  it('ignores unknown fields in ActionCompleted', () => {
    const envelope = createEnvelope({
      type: 'ActionCompleted',
      version: 1,
      source: 'test',
      data: { actionId: 'a', executionId: 'e', actionType: 'x', output: { ok: true }, processedBy: 'w1', futureField: 42 },
    });
    assert.deepEqual(parseActionResult(envelope), {
      kind: 'completed',
      actionId: 'a',
      executionId: 'e',
      output: { ok: true },
      processedBy: 'w1',
      duplicate: false,
    });
  });
});
