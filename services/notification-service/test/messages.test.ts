import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { createEnvelope, PermanentError } from '@routine/service-kit';
import { contractErrors } from '../../../contracts/validate.ts';
import { actionCompleted, parseSendNotification, readExecutionEvent } from '../src/messages.ts';

const base = { executionId: randomUUID(), routineId: randomUUID(), ownerId: randomUUID(), routineName: 'Weekly Review' };
const v2Fields = { notification: { title: 'Routine completed', body: 'All done' }, priority: 'high' };

const completed = (version: number, data: Record<string, unknown>) =>
  createEnvelope({ type: 'ExecutionCompleted', version, source: 'routine-service', data: { ...base, ...data } });

describe('ExecutionCompleted reader – every phase of expand and contract', () => {
  const phases = {
    v1: completed(1, { message: 'Routine "Weekly Review" completed' }),
    expand: completed(2, { message: 'Routine "Weekly Review" completed', ...v2Fields }),
    v2: completed(2, v2Fields),
  };

  it('fixtures match the published contracts', () => {
    assert.deepEqual(contractErrors('execution-completed.v1.schema.json', phases.v1), []);
    assert.deepEqual(contractErrors('execution-completed.v2.schema.json', phases.expand), []);
    assert.deepEqual(contractErrors('execution-completed.v2.schema.json', phases.v2), []);
  });

  it('legacy reader handles v1 and expand, but breaks on the contracted v2', () => {
    assert.equal(readExecutionEvent(phases.v1, 'legacy').title, 'Routine "Weekly Review" completed');
    assert.equal(readExecutionEvent(phases.expand, 'legacy').title, 'Routine "Weekly Review" completed');
    assert.throws(() => readExecutionEvent(phases.v2, 'legacy'), PermanentError);
  });

  it('tolerant reader handles all phases and prefers v2 fields', () => {
    assert.equal(readExecutionEvent(phases.v1, 'tolerant').title, 'Routine "Weekly Review" completed');
    for (const envelope of [phases.expand, phases.v2]) {
      const draft = readExecutionEvent(envelope, 'tolerant');
      assert.equal(draft.title, 'Routine completed');
      assert.equal(draft.body, 'All done');
      assert.equal(draft.priority, 'high');
    }
  });

  it('uses the execution as idempotency key', () => {
    assert.equal(readExecutionEvent(phases.v2, 'tolerant').sourceKey, `execution:${base.executionId}:completed`);
  });
});

describe('notification.send', () => {
  const request = (params: Record<string, unknown>) =>
    createEnvelope({
      type: 'ActionRequested',
      version: 1,
      source: 'routine-service',
      data: { actionId: randomUUID(), executionId: base.executionId, routineId: base.routineId, ownerId: base.ownerId, actionKey: 'n', actionType: 'notification.send', params },
    });

  it('rejects a missing title permanently (no retries)', () => {
    assert.throws(() => parseSendNotification(request({ body: 'x' })), PermanentError);
  });

  it('produces a valid ActionCompleted', () => {
    const { ref } = parseSendNotification(request({ title: 'Hallo' }));
    assert.deepEqual(contractErrors('action-completed.v1.schema.json', actionCompleted(ref, { notificationId: randomUUID() }, 'n@1', false)), []);
  });
});
