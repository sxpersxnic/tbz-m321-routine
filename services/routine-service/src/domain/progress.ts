/**
 * Pure state machine of an execution – no I/O, fully unit tested.
 *
 *   PENDING ──start──▶ RUNNING ──all steps done──▶ COMPLETED
 *                        │  ▲
 *        retry / no      │  │ result arrives
 *        worker response ▼  │
 *                       WAITING
 *                        │
 *   any action failed ───┴──────────────────────▶ FAILED
 */

export type ExecutionStatus = 'PENDING' | 'RUNNING' | 'WAITING' | 'COMPLETED' | 'FAILED';
export type ActionStatus = 'PENDING' | 'DISPATCHED' | 'RETRYING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';

export const TERMINAL_EXECUTION_STATUSES: ReadonlySet<ExecutionStatus> = new Set(['COMPLETED', 'FAILED']);
export const TERMINAL_ACTION_STATUSES: ReadonlySet<ActionStatus> = new Set(['COMPLETED', 'FAILED', 'SKIPPED']);

export interface ActionProgress {
  key: string;
  step: number;
  status: ActionStatus;
  dispatchedAt?: Date | null;
}

export type Decision =
  | { kind: 'dispatch'; step: number; keys: string[] }
  | { kind: 'complete' }
  | { kind: 'fail'; failedKey: string }
  | { kind: 'wait' };

/** What should happen next, given the current state of all actions. */
export function decideNext(actions: ActionProgress[]): Decision {
  const failed = actions.find((action) => action.status === 'FAILED');
  if (failed) return { kind: 'fail', failedKey: failed.key };

  if (actions.some((action) => action.status === 'DISPATCHED' || action.status === 'RETRYING')) {
    return { kind: 'wait' };
  }

  const pending = actions.filter((action) => action.status === 'PENDING');
  if (pending.length === 0) return { kind: 'complete' };

  const step = Math.min(...pending.map((action) => action.step));
  return { kind: 'dispatch', step, keys: pending.filter((action) => action.step === step).map((action) => action.key) };
}

/**
 * While actions are in flight an execution is RUNNING – or WAITING when an
 * action awaits a retry or no worker has answered within `waitingAfterMs`
 * (e.g. because the responsible service is down).
 */
export function inFlightStatus(actions: ActionProgress[], now: Date, waitingAfterMs: number): 'RUNNING' | 'WAITING' {
  const waiting = actions.some(
    (action) =>
      action.status === 'RETRYING' ||
      (action.status === 'DISPATCHED' &&
        action.dispatchedAt != null &&
        now.getTime() - action.dispatchedAt.getTime() >= waitingAfterMs),
  );
  return waiting ? 'WAITING' : 'RUNNING';
}
