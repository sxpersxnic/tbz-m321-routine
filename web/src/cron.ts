import { CronExpressionParser } from 'cron-parser';

/**
 * Turning a cron expression back into something a human can check.
 *
 * The scheduler in routine-service parses the very same library and version, so
 * a preview here cannot disagree with what will actually run – which is the only
 * reason a preview is worth showing at all.
 */

/** Mirrors MIN_SCHEDULE_INTERVAL_MS in services/routine-service/src/domain/schedule.ts. */
export const MIN_INTERVAL_MS = 10_000;

const locale = 'en-GB';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export type CronPreview =
  | { ok: false; message: string }
  | { ok: true; text: string | undefined; next: Date[] };

/** "Monday, Wednesday and Friday" – a list the way it is spoken, not "Monday, Wednesday, Friday". */
function list(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * The step size of a field that fires at evenly spaced values across its whole
 * range – "*&#47;5". Anything irregular returns null so the caller can stay silent
 * rather than describe it wrongly.
 */
function step(values: readonly number[], range: number): number | null {
  if (values.length < 2 || range % values.length !== 0) return null;
  const size = range / values.length;
  const fitsGrid = values.every((value, index) => value === values[0] + index * size);
  return fitsGrid && values[0] < size ? size : null;
}

const isEvery = (values: readonly number[], range: number) => values.length === range;

/** "at 07:30", "every 5 minutes", … or null when the shape is not one we can phrase. */
function describeTime(seconds: readonly number[], minutes: readonly number[], hours: readonly number[]): string | null {
  const everySecond = isEvery(seconds, 60);
  const secondStep = step(seconds, 60);
  const atSecond = seconds.length === 1 ? seconds[0] : null;

  // sub-minute schedules: only the second field carries the rhythm
  if (atSecond === null) {
    if (!isEvery(minutes, 60) || !isEvery(hours, 24)) return null;
    if (everySecond) return 'every second';
    return secondStep ? `every ${secondStep} seconds` : null;
  }

  const suffix = atSecond === 0 ? '' : `:${pad(atSecond)}`;
  const minuteStep = step(minutes, 60);
  const hourStep = step(hours, 24);

  if (isEvery(minutes, 60)) {
    if (isEvery(hours, 24)) return `every minute${suffix ? ` at second ${atSecond}` : ''}`;
    return null;
  }
  if (minuteStep && isEvery(hours, 24)) return `every ${minuteStep} minutes`;
  if (minutes.length !== 1) return null;

  const at = (hour: number) => `${pad(hour)}:${pad(minutes[0])}${suffix}`;
  if (isEvery(hours, 24)) return `every hour at :${pad(minutes[0])}${suffix}`;
  if (hourStep) return `every ${hourStep} hours at :${pad(minutes[0])}${suffix}`;
  if (hours.length <= 3) return `at ${list(hours.map(at))}`;
  return null;
}

/** "every weekday", "on the 1st of the month", … or null when the shape is ambiguous. */
function describeDays(daysOfMonth: readonly number[], months: readonly number[], daysOfWeek: readonly number[]): string | null {
  // cron-parser reports Sunday as both 0 and 7; fold it so the sets compare cleanly
  const weekdays = [...new Set(daysOfWeek.map((day) => day % 7))].sort((a, b) => a - b);
  const anyWeekday = weekdays.length === 7;
  const anyMonthDay = isEvery(daysOfMonth, 31);

  // Standard cron ORs a restricted day-of-month with a restricted day-of-week.
  // Saying "on the 1st and on Mondays" would read as "and", so stay silent instead.
  if (!anyWeekday && !anyMonthDay) return null;

  const when = isEvery(months, 12) ? '' : ` in ${list(months.map((month) => MONTHS[month - 1]))}`;

  if (!anyWeekday) {
    const key = weekdays.join(',');
    if (key === '1,2,3,4,5') return `every weekday${when}`;
    if (key === '0,6') return `on weekends${when}`;
    return `every ${list(weekdays.map((day) => WEEKDAYS[day]))}${when}`;
  }
  if (!anyMonthDay) {
    if (daysOfMonth.length > 3) return null;
    return `on the ${list(daysOfMonth.map(ordinal))}${when || ' of the month'}`;
  }
  return when ? `daily${when}` : 'daily';
}

/** 1 → "1st", 22 → "22nd", 13 → "13th" */
const ordinal = (day: number) => {
  const teen = day % 100 >= 11 && day % 100 <= 13;
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[day % 10] ?? 'th';
  return `${day}${suffix}`;
};

const capitalise = (text: string) => text[0].toUpperCase() + text.slice(1);

/**
 * Joins the two halves the way they are said. A clock time needs the day ("at
 * 18:00" alone says nothing), but a frequency already implies every day, so
 * "daily every 5 minutes" only adds noise.
 */
function sentence(days: string, time: string): string {
  const isClockTime = time.startsWith('at ');
  if (days === 'daily' && !isClockTime) return capitalise(time);
  return `${capitalise(days)} ${time}`;
}

/**
 * Parses `cron` in `timezone` and returns either the reason it cannot run or a
 * preview of it. `text` is a plain-English phrase and stays undefined for shapes
 * we will not risk paraphrasing; `next` is always filled, because concrete dates
 * are unambiguous and are what a user actually checks against.
 */
export function previewCron(cron: string, timezone: string, count = 3, from = new Date()): CronPreview {
  if (!cron.trim()) return { ok: false, message: 'Cron expression is missing' };
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    return { ok: false, message: `Unknown time zone "${timezone}"` };
  }

  let expression: ReturnType<typeof CronExpressionParser.parse>;
  try {
    expression = CronExpressionParser.parse(cron.trim(), { currentDate: from, tz: timezone });
  } catch {
    // the field format is spelled out in the hint right above – repeating it here
    // would bury the one new fact, which is that *this* text is not valid
    return { ok: false, message: `"${cron.trim()}" is not a valid cron expression.` };
  }

  const next: Date[] = [];
  try {
    for (let index = 0; index < Math.max(count, 2); index += 1) next.push(expression.next().toDate());
  } catch {
    return { ok: false, message: 'This expression never fires again.' };
  }

  // the same guard the routine service applies, so the save cannot fail on it
  if (next[1].getTime() - next[0].getTime() < MIN_INTERVAL_MS) {
    return { ok: false, message: `Too frequent – a routine may start at most every ${MIN_INTERVAL_MS / 1000} seconds.` };
  }

  const fields = expression.fields;
  const time = describeTime(fields.second.values, fields.minute.values, fields.hour.values);
  const days = describeDays(fields.dayOfMonth.values as number[], fields.month.values, fields.dayOfWeek.values as number[]);
  return { ok: true, text: time && days ? sentence(days, time) : undefined, next: next.slice(0, count) };
}

/**
 * "Thu 17/09, 07:30" – the weekday is included because that is what the
 * user is checking. Seconds only appear for schedules that actually use them;
 * a trailing ":00" on every line is noise that hides the part that differs.
 */
export function runTime(date: Date, timezone: string, withSeconds = false): string {
  return date.toLocaleString(locale, {
    timeZone: timezone,
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' as const } : {}),
  });
}

export const usesSeconds = (runs: Date[]) => runs.some((run) => run.getSeconds() !== 0);
