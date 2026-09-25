import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { createEnvelope, PermanentError } from '@routine/service-kit';
import { contractErrors } from '../../../contracts/validate.ts';
import { actionCompleted, actionFailed, actionRetryScheduled, parseCreateTask } from '../src/messages.ts';

const request = (params: Record<string, unknown>, actionType = 'task.create') =>
  createEnvelope({
    type: 'ActionRequested',
    version: 1,
    source: 'routine-service',
    data: { actionId: randomUUID(), executionId: randomUUID(), routineId: randomUUID(), ownerId: randomUUID(), actionKey: 't', actionType, params, extra: 'ignored' },
  });

describe('task-service messages', () => {
  it('parses task.create and ignores unknown fields', () => {
    const command = parseCreateTask(request({ title: '  Review  ', dueInDays: 2, priority: 'high' }));
    assert.equal(command.title, 'Review');
    assert.equal(command.dueInDays, 2);
    assert.equal(command.priority, 'high');
  });

  it('reads an optional target list', () => {
    const listId = randomUUID();
    assert.equal(parseCreateTask(request({ title: 'x', listId })).listId, listId);
    assert.equal(parseCreateTask(request({ title: 'x' })).listId, null);
    assert.equal(parseCreateTask(request({ title: 'x', listId: '' })).listId, null);
    assert.throws(() => parseCreateTask(request({ title: 'x', listId: 'groceries' })), PermanentError);
  });

  it('treats invalid params and foreign action types as permanent errors', () => {
    assert.throws(() => parseCreateTask(request({})), PermanentError);
    assert.throws(() => parseCreateTask(request({ title: 'x', priority: 'urgent' })), PermanentError);
    assert.throws(() => parseCreateTask(request({ title: 'x' }, 'weather.get')), PermanentError);
  });

  it('produces results that match the contracts', () => {
    const command = parseCreateTask(request({ title: 'Review' }));
    const error = new Error('db down');
    assert.deepEqual(contractErrors('action-completed.v1.schema.json', actionCompleted(command, { taskId: randomUUID() }, 'task@1', false)), []);
    assert.deepEqual(contractErrors('action-failed.v1.schema.json', actionFailed(command, error, 4, 'task@1')), []);
    assert.deepEqual(contractErrors('action-retry-scheduled.v1.schema.json', actionRetryScheduled(command, error, 1, 1000, 'task@1')), []);
  });
});
