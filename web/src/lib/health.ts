import type { RoutineHealth } from '../types.ts';

/**
 * A routine's health as one line (02-experience §4, §5): quiet while it works – "28 of 28 this
 * month" – and only in words that ask for attention once runs keep failing. Null before any run.
 */
export function healthLine(health: RoutineHealth | undefined): { text: string; failing: boolean } | null {
  if (!health) return null;
  if (health.consecutiveFailures >= 2) return { text: `Failed the last ${health.consecutiveFailures} runs`, failing: true };
  if (health.runs30d === 0) return null;
  return { text: `${health.runs30d - health.failures30d} of ${health.runs30d} this month`, failing: false };
}

/** The choices of "Tell me …" in the editor – after how many failures in a row, or never. */
export const ALERT_CHOICES: Array<{ value: number | null; label: string }> = [
  { value: 1, label: 'after 1 failure' },
  { value: 2, label: 'after 2 failures in a row' },
  { value: 3, label: 'after 3 failures in a row' },
  { value: 5, label: 'after 5 failures in a row' },
  { value: 10, label: 'after 10 failures in a row' },
  { value: null, label: 'never' },
];
