import { clock, dayClock } from '../format.ts';
import type { ExecutionAction, ExecutionDetail, StepTimeout } from '../types.ts';

/** "If you don't get to it" as the definition spells it (06-engine §2) – `then` is a field, not a thenable. */
export const stepTimeout = (after: string, then: StepTimeout['then']): StepTimeout => ({ after, then });

/** A moment today as "07:30", any other day as "Fri 07:30". */
export function moment(iso: string, now = new Date()): string {
  return new Date(iso).toDateString() === now.toDateString() ? clock(iso) : dayClock(iso);
}

/**
 * The line under a step that waits for you (02-experience §7): "Waiting for you since 07:30 ·
 * skips at 12:00" – what happens at the deadline follows the step's "If you don't get to it".
 */
export function waitingLine(action: Pick<ExecutionAction, 'acceptedAt' | 'deadlineAt' | 'timeout'>, now = new Date()): string {
  const since = action.acceptedAt ? `Waiting for you since ${moment(action.acceptedAt, now)}` : 'Waiting for you';
  if (!action.deadlineAt) return since;
  return `${since} · ${action.timeout?.then === 'fail' ? 'fails' : 'skips'} at ${moment(action.deadlineAt, now)}`;
}

/** Where the person does a waiting step: the task on its list, the question in Notifications. */
export function doItHref(action: Pick<ExecutionAction, 'awaiting'>): string {
  return action.awaiting?.kind === 'question' ? '#/notifications' : '#/tasks';
}

/** Steps that wait for a person now. */
export const waitingSteps = (e: Pick<ExecutionDetail, 'actions'>) => e.actions.filter((action) => action.status === 'AWAITING_USER');

/** A step the person did after it was skipped or expired – the run says "done too late" (05 §5 rule 4). */
export const doneTooLate = (e: Pick<ExecutionDetail, 'log'>, key: string) => e.log.some((entry) => entry.kind === 'ACTION_LATE' && entry.actionKey === key);
