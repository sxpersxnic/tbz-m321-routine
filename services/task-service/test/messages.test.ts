import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PermanentError } from '@routine/service-kit';
import { localDate, parseCreateParams, parseDate, parseId, parseLimit } from '../src/messages.ts';

const zurich = 'Europe/Zurich';

describe('task-service params', () => {
  it('parses task.create and ignores unknown fields', () => {
    const params = parseCreateParams({ title: '  Review  ', dueInDays: 2, priority: 'high', extra: 'ignored' }, zurich);
    assert.equal(params.title, 'Review');
    assert.equal(params.dueDate, localDate(zurich, 2));
    assert.equal(params.priority, 'high');
    assert.equal(params.listId, null);
  });

  it('prefers dueDate over v1 dueInDays, relative to today in the owner’s time zone', () => {
    assert.equal(parseCreateParams({ title: 'x', dueInDays: 5, dueDate: '2026-12-24' }, zurich).dueDate, '2026-12-24');
    assert.equal(parseCreateParams({ title: 'x', dueDate: '+1d' }, zurich).dueDate, localDate(zurich, 1));
    // just before midnight UTC it is already tomorrow in Auckland
    assert.equal(localDate('Pacific/Auckland', 0, new Date('2026-09-28T23:30:00Z')), '2026-09-29');
    assert.equal(parseDate('', 'x', zurich), null);
  });

  it('reads an optional target list', () => {
    const listId = '5c1f0e1e-0000-4000-8000-000000000001';
    assert.equal(parseCreateParams({ title: 'x', listId }, zurich).listId, listId);
    assert.equal(parseCreateParams({ title: 'x', listId: '' }, zurich).listId, null);
    assert.throws(() => parseCreateParams({ title: 'x', listId: 'groceries' }, zurich), { code: 'INVALID_PARAMS' });
  });

  it('treats invalid params as permanent INVALID_PARAMS errors', () => {
    for (const params of [{}, { title: 'x', priority: 'urgent' }, { title: 'x', dueInDays: -1 }, { title: 'x', dueDate: 'soon' }]) {
      assert.throws(() => parseCreateParams(params, zurich), (error: PermanentError) => error instanceof PermanentError && error.code === 'INVALID_PARAMS');
    }
    assert.throws(() => parseId(undefined, 'taskId', 'task', true), /"taskId" is required/);
    assert.throws(() => parseLimit(500), /1 to 100/);
    assert.equal(parseLimit(undefined), 20);
  });
});
