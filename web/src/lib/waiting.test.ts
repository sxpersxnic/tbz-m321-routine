import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { delayedUntil, doItHref, doneTooLate, stepTimeout, waitingLine } from './waiting.ts';

describe('waiting for you (02-experience §7)', () => {
  const now = new Date('2026-10-01T09:00:00');
  const at = (time: string) => new Date(`2026-10-01T${time}:00`).toISOString();

  const skip = stepTimeout('PT4H30M', 'skip');
  const fail = stepTimeout('PT4H30M', 'fail');

  it('says since when, and what happens at the deadline', () => {
    assert.equal(waitingLine({ acceptedAt: at('07:30'), deadlineAt: null }, now), 'Waiting for you since 07:30');
    assert.equal(waitingLine({ acceptedAt: at('07:30'), deadlineAt: at('12:00'), timeout: skip }, now), 'Waiting for you since 07:30 · skips at 12:00');
    assert.equal(waitingLine({ acceptedAt: at('07:30'), deadlineAt: at('12:00'), timeout: fail }, now), 'Waiting for you since 07:30 · fails at 12:00');
  });

  it('names the day of a moment that is not today', () => {
    assert.match(waitingLine({ acceptedAt: '2026-09-29T07:30:00', deadlineAt: null }, now), /^Waiting for you since Tue 07:30$/);
  });

  it('opens the task or the question', () => {
    assert.equal(doItHref({ awaiting: { kind: 'task', refId: 'x', title: 't' } }), '#/tasks');
    assert.equal(doItHref({ awaiting: { kind: 'question', refId: 'x', title: 't' } }), '#/notifications');
  });

  it('says until when a delayed run waits', () => {
    const wait = (wakeAt: string, status = 'SCHEDULED') => ({ status, wakeAt }) as never;
    assert.equal(delayedUntil({ actions: [wait('2026-10-01T15:00:00Z'), wait('2026-10-01T14:00:00Z'), wait('2026-10-01T13:00:00Z', 'COMPLETED')] }), '2026-10-01T14:00:00Z');
    assert.equal(delayedUntil({ actions: [] }), undefined);
  });

  it('knows a step done too late', () => {
    const log = [{ at: '', kind: 'ACTION_LATE', actionKey: 'stretch', message: '' }];
    assert.equal(doneTooLate({ log }, 'stretch'), true);
    assert.equal(doneTooLate({ log }, 'other'), false);
  });
});
