import { CronExpressionParser } from 'cron-parser';

/** Guards the system against routines that would fire every second. */
export const MIN_SCHEDULE_INTERVAL_MS = 10_000;
export const DEFAULT_TIMEZONE = 'Europe/Zurich';

/** Next occurrence strictly after `after`. Supports 5- and 6-field (seconds) cron. */
export function nextRun(cron: string, timezone: string, after: Date): Date {
  return CronExpressionParser.parse(cron, { currentDate: after, tz: timezone }).next().toDate();
}

export function validateSchedule(cron: string, timezone: string): string[] {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    return [`unknown timezone "${timezone}"`];
  }
  try {
    const expression = CronExpressionParser.parse(cron, { currentDate: new Date(), tz: timezone, strict: false });
    const first = expression.next().toDate();
    const second = expression.next().toDate();
    if (second.getTime() - first.getTime() < MIN_SCHEDULE_INTERVAL_MS) {
      return [`schedule "${cron}" fires more often than every ${MIN_SCHEDULE_INTERVAL_MS / 1000}s`];
    }
    return [];
  } catch (error) {
    return [`invalid cron expression "${cron}": ${error instanceof Error ? error.message : String(error)}`];
  }
}
