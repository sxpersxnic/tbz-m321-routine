/**
 * The friendly schedule picker and cron, both ways. Most people want "every
 * weekday at 07:30", not five space-separated fields – so the common shapes get
 * a form, and anything else stays an expression under "Cron & time zone".
 */

export type Frequency = 'daily' | 'weekdays' | 'weekly' | 'hourly' | 'interval' | 'custom';

export interface SimpleSchedule {
  frequency: Exclude<Frequency, 'custom'>;
  /** "07:30" */
  time: string;
  /** 0 = Sunday … 6 = Saturday, like cron */
  days: number[];
  every: number;
  unit: 'minutes' | 'seconds';
}

const pad = (value: number | string) => String(value).padStart(2, '0');
const DEFAULT: SimpleSchedule = { frequency: 'daily', time: '07:30', days: [1], every: 15, unit: 'minutes' };

export function parseSchedule(cron: string): SimpleSchedule | null {
  const text = cron.trim().replace(/\s+/g, ' ');
  let match: RegExpExecArray | null;
  const at = (minute: string, hour: string) => `${pad(hour)}:${pad(minute)}`;
  if ((match = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(text))) return { ...DEFAULT, frequency: 'daily', time: at(match[1], match[2]) };
  if ((match = /^(\d{1,2}) (\d{1,2}) \* \* 1-5$/.exec(text))) return { ...DEFAULT, frequency: 'weekdays', time: at(match[1], match[2]) };
  if ((match = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6](?:,[0-6])*)$/.exec(text))) {
    return { ...DEFAULT, frequency: 'weekly', time: at(match[1], match[2]), days: match[3].split(',').map(Number) };
  }
  if (text === '0 * * * *') return { ...DEFAULT, frequency: 'hourly' };
  if ((match = /^\*\/(\d+) \* \* \* \*$/.exec(text))) return { ...DEFAULT, frequency: 'interval', every: Number(match[1]), unit: 'minutes' };
  if ((match = /^\*\/(\d+) \* \* \* \* \*$/.exec(text))) return { ...DEFAULT, frequency: 'interval', every: Number(match[1]), unit: 'seconds' };
  return null;
}

export function toCron(schedule: SimpleSchedule): string {
  const [hour = '7', minute = '30'] = schedule.time.split(':');
  const hm = `${Number(minute)} ${Number(hour)}`;
  switch (schedule.frequency) {
    case 'daily':
      return `${hm} * * *`;
    case 'weekdays':
      return `${hm} * * 1-5`;
    case 'weekly': {
      const days = [...new Set(schedule.days)].sort((a, b) => a - b);
      return `${hm} * * ${days.length ? days.join(',') : '1'}`;
    }
    case 'hourly':
      return '0 * * * *';
    case 'interval':
      return schedule.unit === 'seconds' ? `*/${schedule.every} * * * * *` : `*/${schedule.every} * * * *`;
  }
}

/** Switching the frequency keeps what still applies – the clock time survives "daily → weekdays". */
export function withFrequency(cron: string, frequency: Exclude<Frequency, 'custom'>): string {
  const current = parseSchedule(cron) ?? DEFAULT;
  return toCron({ ...current, frequency });
}

export const FREQUENCIES: Array<{ key: Frequency; label: string }> = [
  { key: 'daily', label: 'Daily' },
  { key: 'weekdays', label: 'Weekdays' },
  { key: 'weekly', label: 'Specific days' },
  { key: 'hourly', label: 'Hourly' },
  { key: 'interval', label: 'Interval' },
];

/** Monday first, the way a European calendar reads. */
export const WEEKDAYS: Array<{ day: number; short: string; long: string }> = [
  { day: 1, short: 'Mo', long: 'Monday' },
  { day: 2, short: 'Tu', long: 'Tuesday' },
  { day: 3, short: 'We', long: 'Wednesday' },
  { day: 4, short: 'Th', long: 'Thursday' },
  { day: 5, short: 'Fr', long: 'Friday' },
  { day: 6, short: 'Sa', long: 'Saturday' },
  { day: 0, short: 'Su', long: 'Sunday' },
];
