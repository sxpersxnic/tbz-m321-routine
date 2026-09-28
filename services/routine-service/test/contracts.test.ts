/** Consumer-driven contract tests: messages produced by this service must match contracts/schemas. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { createEnvelope } from '@routine/service-kit';
import { contractErrors } from '../../../contracts/validate.ts';
import { actionRequested, executionCompleted, executionFailed, executionResumed, parseActionResult, routineTriggered, routineUnhealthy, subRoutineResult } from '../src/messages.ts';

const ids = { executionId: randomUUID(), routineId: randomUUID(), ownerId: randomUUID(), correlationId: randomUUID() };

describe('routine-service produces valid messages', () => {
  it('RoutineTriggered v1', () => {
    const message = routineTriggered({ ...ids, trigger: 'schedule', scheduledFor: new Date() });
    assert.deepEqual(contractErrors('routine-triggered.v1.schema.json', message.envelope), []);
    assert.equal(message.routingKey, 'routine.triggered');
  });

  it('RoutineTriggered v1 for a routine called by another routine', () => {
    const message = routineTriggered({ ...ids, trigger: 'routine', scheduledFor: null });
    assert.deepEqual(contractErrors('routine-triggered.v1.schema.json', message.envelope), []);
  });

  it('answers a routine.run step like a worker would', () => {
    const ref = { actionId: randomUUID(), executionId: randomUUID(), correlationId: randomUUID() };
    const done = subRoutineResult({ ...ref, outcome: { ok: true, output: { result: 42 } } });
    assert.equal(done.routingKey, 'action.completed');
    assert.deepEqual(contractErrors('action-completed.v1.schema.json', done.envelope), []);
    assert.equal(parseActionResult(done.envelope as never).kind, 'completed');
    const failed = subRoutineResult({ ...ref, outcome: { ok: false, error: 'boom' } });
    assert.equal(failed.routingKey, 'action.failed');
    assert.deepEqual(contractErrors('action-failed.v1.schema.json', failed.envelope), []);
  });

  it('RoutineTriggered v1 for a webhook call', () => {
    const message = routineTriggered({ ...ids, trigger: 'webhook', scheduledFor: null });
    assert.deepEqual(contractErrors('routine-triggered.v1.schema.json', message.envelope), []);
  });

  it('ActionRequested v1 routed by action type', () => {
    const message = actionRequested({ ...ids, actionId: randomUUID(), actionKey: 'weather', actionType: 'weather.get', params: { city: 'Bern' } });
    assert.deepEqual(contractErrors('action-requested.v1.schema.json', message.envelope), []);
    assert.equal(message.routingKey, 'action.weather.get');
  });

  it('ExecutionFailed v1', () => {
    const message = executionFailed({ ...ids, routineName: 'X', reason: 'boom', failedActionKey: 'a' });
    assert.deepEqual(contractErrors('execution-failed.v1.schema.json', message.envelope), []);
    const again = executionFailed({ ...ids, routineName: 'X', reason: 'boom', failedActionKey: 'a', resumeCount: 2 });
    assert.deepEqual(contractErrors('execution-failed.v1.schema.json', again.envelope), []);
  });

  it('RoutineUnhealthy v1', () => {
    const message = routineUnhealthy({ ...ids, routineName: 'Backup', consecutiveFailures: 2, lastErrorCode: 'NOT_FOUND' });
    assert.deepEqual(contractErrors('routine-unhealthy.v1.schema.json', message.envelope), []);
    assert.equal(message.routingKey, 'routine.unhealthy');
  });

  it('ExecutionResumed v1', () => {
    const message = executionResumed({ ...ids, fromActionKey: 'call', resumedBy: ids.ownerId, resumeCount: 1 });
    assert.deepEqual(contractErrors('execution-resumed.v1.schema.json', message.envelope), []);
    assert.equal(message.routingKey, 'execution.resumed');
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

describe('v2 additions to the v1 contracts (05-messaging §3)', () => {
  const requested = (actionType: string) =>
    actionRequested({ ...ids, actionId: randomUUID(), actionKey: 'step', actionType, params: {} }).envelope as { data: Record<string, unknown> };

  it('ActionRequested accepts every v1 type and <prefix>.<camelCaseName>', () => {
    const types = ['task.create', 'notification.send', 'weather.get', 'http.request', 'summary.generate', 'email.send', 'routine.run'];
    for (const type of [...types, 'budget.recordTransaction', 'health2.logEntry']) {
      assert.deepEqual(contractErrors('action-requested.v1.schema.json', requested(type)), [], type);
    }
  });

  it('ActionRequested rejects three segments, upper-case prefixes and upper-case names', () => {
    for (const type of ['budget.transaction.record', 'Budget.record', 'budget.RecordTransaction', 'budget.', '1x.run']) {
      assert.notDeepEqual(contractErrors('action-requested.v1.schema.json', requested(type)), [], type);
    }
  });

  it('ActionRequested carries an optional context', () => {
    const message = requested('budget.recordTransaction');
    message.data.context = { mode: 'test', timezone: 'Europe/Zurich', currency: 'CHF', routineName: 'Lunch log', stepIndex: 2, stepCount: 4, depth: 0, areaId: null };
    assert.deepEqual(contractErrors('action-requested.v1.schema.json', message), []);
    message.data.context = { mode: 'dry-run' };
    assert.notDeepEqual(contractErrors('action-requested.v1.schema.json', message), []);
  });

  it('ActionFailed accepts the error codes and the v1 class names, nothing else', () => {
    const failed = (code: string) =>
      createEnvelope({
        type: 'ActionFailed',
        version: 1,
        source: 'test',
        data: { actionId: randomUUID(), executionId: randomUUID(), actionType: 'http.request', error: { code, message: 'x' }, attempts: 1, processedBy: 'w1' },
      });
    for (const code of ['NOT_FOUND', 'TIMEOUT', 'INVALID_PARAMS', 'INTERNAL', 'PermanentError', 'TransientError', 'Error', 'SubRoutineFailed']) {
      assert.deepEqual(contractErrors('action-failed.v1.schema.json', failed(code)), [], code);
    }
    assert.notDeepEqual(contractErrors('action-failed.v1.schema.json', failed('TypeError')), []);
  });

  it('ExecutionFailed carries the failed action\'s error code and type', () => {
    const message = executionFailed({ ...ids, routineName: 'X', reason: 'boom', failedActionKey: 'a' }).envelope as { data: Record<string, unknown> };
    Object.assign(message.data, { errorCode: 'NOT_FOUND', failedActionType: 'http.request' });
    assert.deepEqual(contractErrors('execution-failed.v1.schema.json', message), []);
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
