/** Param parsing of the task capabilities: the contract's params → the task service's own model. */
import { PermanentError } from '@routine/service-kit';

export const SOURCE = 'task-service';

const INVALID_PARAMS = { code: 'INVALID_PARAMS' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Priority = 'low' | 'normal' | 'high';

export interface CreateTaskParams {
  title: string;
  description: string;
  priority: Priority;
  /** YYYY-MM-DD in the owner's time zone, or null. */
  dueDate: string | null;
  /** Target list; null = the owner's default list. */
  listId: string | null;
}

/** Today in `timezone` as YYYY-MM-DD, `offsetDays` later. */
export function localDate(timezone: string, offsetDays = 0, now = new Date()): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

/** A `date` param (04 §2.1): YYYY-MM-DD, or `+Nd` relative to today in the owner's time zone. */
export function parseDate(value: unknown, name: string, timezone: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const relative = typeof value === 'string' ? /^\+(\d+)d$/.exec(value) : null;
  if (relative) return localDate(timezone, Number(relative[1]));
  throw new PermanentError(`param "${name}" must be a date (YYYY-MM-DD or +Nd)`, INVALID_PARAMS);
}

export function parseId(value: unknown, name: string, what: string, required: true): string;
export function parseId(value: unknown, name: string, what: string, required?: false): string | null;
export function parseId(value: unknown, name: string, what: string, required = false): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new PermanentError(`param "${name}" is required`, INVALID_PARAMS);
    return null;
  }
  if (typeof value !== 'string' || !UUID.test(value)) throw new PermanentError(`param "${name}" must be a ${what} id`, INVALID_PARAMS);
  return value;
}

/** task.create – v1's `dueInDays` or v2's `dueDate` (the latter wins). */
export function parseCreateParams(params: Record<string, unknown>, timezone: string): CreateTaskParams {
  const title = params.title;
  if (typeof title !== 'string' || title.trim() === '') throw new PermanentError('param "title" is required', INVALID_PARAMS);
  const priority = params.priority ?? 'normal';
  if (priority !== 'low' && priority !== 'normal' && priority !== 'high') throw new PermanentError('param "priority" must be low, normal or high', INVALID_PARAMS);
  const dueInDays = params.dueInDays;
  if (dueInDays !== undefined && dueInDays !== null && dueInDays !== '' && (!Number.isInteger(Number(dueInDays)) || Number(dueInDays) < 0)) {
    throw new PermanentError('param "dueInDays" must be a non-negative integer', INVALID_PARAMS);
  }
  const dueDate = parseDate(params.dueDate, 'dueDate', timezone)
    ?? (dueInDays === undefined || dueInDays === null || dueInDays === '' ? null : localDate(timezone, Number(dueInDays)));
  return {
    title: title.trim().slice(0, 200),
    description: typeof params.description === 'string' ? params.description : '',
    priority,
    dueDate,
    listId: parseId(params.listId, 'listId', 'list'),
  };
}

export function parseLimit(value: unknown, fallback = 20): number {
  if (value === undefined || value === null || value === '') return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new PermanentError('param "limit" must be a whole number from 1 to 100', INVALID_PARAMS);
  return limit;
}
