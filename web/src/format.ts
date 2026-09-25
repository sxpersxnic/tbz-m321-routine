import { previewCron } from './cron.ts';
import type { ExecutionTrigger, Trigger } from './types.ts';

const locale = 'en-GB';

export const dateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' }) : '–';

export const time = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '–';

export const date = (iso: string | null | undefined) =>
  iso ? new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString(locale, { dateStyle: 'medium' }) : '–';

/** One unit for people: "0.2 s", not "219 ms" next to "1.5 s". */
export function duration(ms: number): string {
  if (ms < 60_000) return `${(Math.max(ms, 100) / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function between(from: string | null, to: string | null, now = Date.now()): string {
  if (!from) return '–';
  return duration((to ? new Date(to).getTime() : now) - new Date(from).getTime());
}

export function relative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '–';
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(seconds, 'second');
  if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), 'hour');
  return format.format(Math.round(seconds / 86_400), 'day');
}

export interface CronPreset {
  label: string;
  cron: string;
}

export const CRON_PRESETS: CronPreset[] = [
  { label: 'Every weekday at 07:30', cron: '30 7 * * 1-5' },
  { label: 'Every Monday at 08:00', cron: '0 8 * * 1' },
  { label: 'Daily at 18:00', cron: '0 18 * * *' },
  { label: 'Hourly', cron: '0 * * * *' },
  { label: 'Every 5 minutes', cron: '*/5 * * * *' },
  { label: 'Every 30 seconds', cron: '*/30 * * * * *' },
];

export function describeTrigger(trigger: Trigger): string {
  if (trigger.type === 'manual') return 'Manual';
  if (trigger.type === 'webhook') return 'Webhook';
  const preset = CRON_PRESETS.find((candidate) => candidate.cron === trigger.cron);
  if (preset) return preset.label;
  // a cron expression is never the answer to "when does this run?" – say it in words if we can
  const preview = previewCron(trigger.cron, trigger.timezone, 1);
  return preview.ok && preview.text ? preview.text : 'Custom schedule';
}

export const TRIGGER_ICONS: Record<Trigger['type'], string> = { manual: 'play', schedule: 'clock', webhook: 'link' };
export const TRIGGER_WORDS: Record<ExecutionTrigger, string> = { manual: 'Manual', schedule: 'Scheduled', webhook: 'Webhook', routine: 'Called by a routine' };

/** The full URL an external system calls – the API is always served from the same origin as the UI. */
export const webhookUrl = (path: string) => `${window.location.origin}${path}`;

/** What a test event sends, so a routine can be tried without an external system. */
export const testPayload = () => ({ test: true, source: 'Routine web app', sentAt: new Date().toISOString() });

export const shortId = (id: string | null | undefined) => (id ? id.slice(0, 8) : '–');

/** "1 action" / "3 actions" – counts read as broken UI when the plural is wrong. */
export const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "integration-worker@3f2a9b1c0d4e" → { service: "integration-worker", instance: "3f2a9b" } */
export function splitInstance(processedBy: string | null): { service: string; instance: string } | null {
  if (!processedBy) return null;
  const [service, instance = ''] = processedBy.split('@');
  return { service, instance: instance.slice(0, 6) };
}

export const JAEGER_URL = 'http://localhost:16686';
export const RABBITMQ_URL = 'http://localhost:15672';

/** "Good morning" etc. – the first line of the home screen talks to a person. */
export function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 5) return 'Good night';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export const longDate = (now = new Date()) =>
  now.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });

/** Day buckets – "Today", "Yesterday", "Wednesday 9 September". */
export function groupByDay<T>(items: T[], at: (item: T) => string): Array<{ label: string; items: T[] }> {
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const today = startOfDay(new Date());
  const day = 86_400_000;
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const when = new Date(at(item));
    const start = startOfDay(when);
    const label = start === today ? 'Today' : start === today - day ? 'Yesterday'
      : when.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });
    groups.set(label, [...(groups.get(label) ?? []), item]);
  }
  return [...groups].map(([label, group]) => ({ label, items: group }));
}

/** "Fri 07:30" – a moment within the next days, without the year and seconds. */
export const dayClock = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '–';

/** Clock time for rows in a day group: "07:30". */
export const clock = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '–';
