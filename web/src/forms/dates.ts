/**
 * A date param (07 §5.1): *Today · Tomorrow · In N days · Date* → `+0d`, `+1d`, `+Nd` or `YYYY-MM-DD`.
 * Relative dates count from the day the routine runs, so they are what a routine usually wants.
 */
export type DateMode = 'none' | 'today' | 'tomorrow' | 'days' | 'date' | 'custom';

export function dateMode(value: string): { mode: DateMode; days: number; date: string } {
  const relative = /^\+(\d+)d$/.exec(value);
  if (!value) return { mode: 'none', days: 2, date: '' };
  if (relative) {
    const days = Number(relative[1]);
    return { mode: days === 0 ? 'today' : days === 1 ? 'tomorrow' : 'days', days: Math.max(days, 2), date: '' };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { mode: 'date', days: 2, date: value };
  return { mode: 'custom', days: 2, date: '' }; // a {{reference}} – kept as text
}
