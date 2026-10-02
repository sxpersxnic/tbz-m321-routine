/**
 * "Wait" (flow.wait, 06-engine §9): when a sleeping step wakes up – after a duration, or at the next
 * HH:mm in the owner's time zone. Pure, so the engine and validation share it.
 */
import { ControlError } from './control.ts';
import { nextRun } from './schedule.ts';

/** The longest a run may sleep in one step. */
export const MAX_WAIT_MS = 7 * 24 * 3_600_000;

const DURATION = /^P(?!$)(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * An ISO 8601 duration in milliseconds, or null when it isn't one. Years and months have no fixed
 * length – they count as 365 and 30 days, which only matters for saying "too long".
 */
export function durationMs(value: string): number | null {
  const match = DURATION.exec(value);
  if (!match) return null;
  const [years, months, weeks, days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0));
  return ((((years * 365 + months * 30 + weeks * 7 + days) * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

/** Why a Wait step's literal params can't work, or null – for validation (templated values wait until run time). */
export function waitIssue(params: Record<string, unknown>): string | null {
  const given = (value: unknown) => value !== undefined && value !== null && value !== '';
  if (given(params.for) === given(params.until)) return 'a wait needs either how long ("for") or until when ("until")';
  if (typeof params.for === 'string' && !params.for.includes('{{')) {
    const ms = durationMs(params.for);
    if (ms !== null && ms > MAX_WAIT_MS) return 'a wait can last at most 7 days';
  }
  return null;
}

/** When a Wait step that starts `now` wakes up. Throws ControlError for params that can't work. */
export function wakeAt(params: Record<string, unknown>, now: Date, timezone: string): Date {
  const issue = waitIssue(params);
  if (issue) throw new ControlError(issue);
  if (params.for !== undefined && params.for !== null && params.for !== '') {
    const ms = typeof params.for === 'string' ? durationMs(params.for) : null;
    if (ms === null) throw new ControlError(`"${String(params.for)}" is not a duration like PT2H`);
    return new Date(now.getTime() + ms);
  }
  const time = typeof params.until === 'string' ? TIME.exec(params.until) : null;
  if (!time) throw new ControlError(`"${String(params.until)}" is not a time like 17:00`);
  // the next 17:00 on the owner's wall clock (DST included) – today if it is still ahead, else tomorrow
  return nextRun(`${Number(time[2])} ${Number(time[1])} * * *`, timezone, now);
}
