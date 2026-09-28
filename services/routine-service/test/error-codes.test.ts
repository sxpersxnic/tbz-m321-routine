import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { createEnvelope, type Queryable } from '@routine/service-kit';
import { contractErrors } from '../../../contracts/validate.ts';
import { executionFailed, parseActionResult, subRoutineResult } from '../src/messages.ts';
import { markActionFailed } from '../src/store.ts';

const failed = (code: unknown) =>
  createEnvelope({
    type: 'ActionFailed',
    version: 1,
    source: 'test',
    data: { actionId: randomUUID(), executionId: randomUUID(), actionType: 'http.request', error: { code, message: 'x' }, attempts: 3, processedBy: 'w1' },
  });

const codeOf = (code: unknown) => {
  const result = parseActionResult(failed(code));
  assert.equal(result.kind, 'failed');
  return result.kind === 'failed' ? result.code : undefined;
};

describe('error codes (05-messaging §6)', () => {
  it('reads the code of ActionFailed, mapping v1 class names and unknown codes to INTERNAL', () => {
    assert.equal(codeOf('NOT_FOUND'), 'NOT_FOUND');
    assert.equal(codeOf('RATE_LIMITED'), 'RATE_LIMITED');
    assert.equal(codeOf('SubRoutineFailed'), 'SUBROUTINE_FAILED');
    for (const legacy of ['PermanentError', 'TransientError', 'Error', 'SOMETHING_NEW', undefined, 42]) assert.equal(codeOf(legacy), 'INTERNAL');
  });

  it('answers a failed routine.run step with SUBROUTINE_FAILED', () => {
    const message = subRoutineResult({ actionId: randomUUID(), executionId: randomUUID(), correlationId: randomUUID(), outcome: { ok: false, error: 'boom' } });
    assert.equal((message.envelope.data as { error: { code: string } }).error.code, 'SUBROUTINE_FAILED');
    assert.equal(codeOf('SUBROUTINE_FAILED'), 'SUBROUTINE_FAILED');
  });

  it('puts the failed action\'s code and type into ExecutionFailed', () => {
    const message = executionFailed({
      executionId: randomUUID(),
      routineId: randomUUID(),
      ownerId: randomUUID(),
      routineName: 'Morning',
      reason: 'Action "fetch" failed: gone',
      failedActionKey: 'fetch',
      failedActionType: 'http.request',
      errorCode: 'NOT_FOUND',
      correlationId: randomUUID(),
    });
    assert.deepEqual(contractErrors('execution-failed.v1.schema.json', message.envelope), []);
    assert.equal((message.envelope.data as { errorCode: string }).errorCode, 'NOT_FOUND');
    assert.equal((message.envelope.data as { failedActionType: string }).failedActionType, 'http.request');
  });

  it('stores the code with the failed action', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const db = { query: async (sql: string, params: unknown[]) => queries.push({ sql, params }) } as unknown as Queryable;
    await markActionFailed(db, 'action-1', { error: 'gone', code: 'NOT_FOUND' }, 'w1', 3);
    assert.match(queries[0].sql, /error_code = \$3/);
    assert.deepEqual(queries[0].params, ['action-1', 'gone', 'NOT_FOUND', 'w1', 3]);
  });
});
