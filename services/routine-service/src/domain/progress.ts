/**
 * Pure state machine of an execution – no I/O, fully unit tested (docs/v2/06-engine.md §1).
 *
 *   PENDING ──start──▶ RUNNING ─────────all steps done─────────▶ COMPLETED
 *                        │ ▲
 *                        ▼ │ result arrives / person acts / timer fires
 *     WAITING (worker slow or retrying) · WAITING_FOR_YOU (person) · DELAYED (timer)
 *                        │
 *   any action failed ───┴──────────────────────────────────────▶ FAILED
 */

export type ExecutionStatus = 'PENDING' | 'RUNNING' | 'WAITING' | 'WAITING_FOR_YOU' | 'DELAYED' | 'COMPLETED' | 'FAILED';
export type ActionStatus = 'PENDING' | 'DISPATCHED' | 'RETRYING' | 'AWAITING_USER' | 'SCHEDULED' | 'COMPLETED' | 'FAILED' | 'SKIPPED';

export const TERMINAL_EXECUTION_STATUSES: ReadonlySet<ExecutionStatus> = new Set(['COMPLETED', 'FAILED']);
export const TERMINAL_ACTION_STATUSES: ReadonlySet<ActionStatus> = new Set(['COMPLETED', 'FAILED', 'SKIPPED']);
/** Handed over and not finished: a worker, a person or a timer has it. */
export const IN_FLIGHT_ACTION_STATUSES: ReadonlySet<ActionStatus> = new Set(['DISPATCHED', 'RETRYING', 'AWAITING_USER', 'SCHEDULED']);

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

  if (actions.some((action) => IN_FLIGHT_ACTION_STATUSES.has(action.status))) return { kind: 'wait' };

  const pending = actions.filter((action) => action.status === 'PENDING');
  if (pending.length === 0) return { kind: 'complete' };

  const step = Math.min(...pending.map((action) => action.step));
  return { kind: 'dispatch', step, keys: pending.filter((action) => action.step === step).map((action) => action.key) };
}

export type InFlightStatus = 'RUNNING' | 'WAITING' | 'WAITING_FOR_YOU' | 'DELAYED';

/**
 * The execution's status while actions are in flight – the machine first, then people, then timers:
 *   1. any RETRYING, or DISPATCHED for `waitingAfterMs` without an answer → WAITING
 *   2. else any DISPATCHED → RUNNING
 *   3. else any AWAITING_USER → WAITING_FOR_YOU
 *   4. else (only SCHEDULED) → DELAYED
 */
export function inFlightStatus(actions: ActionProgress[], now: Date, waitingAfterMs: number): InFlightStatus {
  const waiting = actions.some(
    (action) =>
      action.status === 'RETRYING' ||
      (action.status === 'DISPATCHED' &&
        action.dispatchedAt != null &&
        now.getTime() - action.dispatchedAt.getTime() >= waitingAfterMs),
  );
  if (waiting) return 'WAITING';
  if (actions.some((action) => action.status === 'DISPATCHED')) return 'RUNNING';
  if (actions.some((action) => action.status === 'AWAITING_USER')) return 'WAITING_FOR_YOU';
  if (actions.some((action) => action.status === 'SCHEDULED')) return 'DELAYED';
  return 'RUNNING';
}
