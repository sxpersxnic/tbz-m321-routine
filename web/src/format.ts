import type { Trigger } from './types.ts';

const locale = 'de-CH';

export const dateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'medium' }) : '–';

export const time = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '–';

export const date = (iso: string | null | undefined) =>
  iso ? new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString(locale, { dateStyle: 'medium' }) : '–';

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
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
  { label: 'Jeden Werktag um 07:30', cron: '30 7 * * 1-5' },
  { label: 'Jeden Montag um 08:00', cron: '0 8 * * 1' },
  { label: 'Täglich um 18:00', cron: '0 18 * * *' },
  { label: 'Stündlich', cron: '0 * * * *' },
  { label: 'Alle 5 Minuten', cron: '*/5 * * * *' },
  { label: 'Alle 30 Sekunden (Demo)', cron: '*/30 * * * * *' },
];

export function describeTrigger(trigger: Trigger): string {
  if (trigger.type === 'manual') return 'Manuell';
  const preset = CRON_PRESETS.find((candidate) => candidate.cron === trigger.cron);
  return preset ? preset.label : `Cron ${trigger.cron}`;
}

export const shortId = (id: string | null | undefined) => (id ? id.slice(0, 8) : '–');

/** "integration-worker@3f2a9b1c0d4e" → { service: "integration-worker", instance: "3f2a9b" } */
export function splitInstance(processedBy: string | null): { service: string; instance: string } | null {
  if (!processedBy) return null;
  const [service, instance = ''] = processedBy.split('@');
  return { service, instance: instance.slice(0, 6) };
}

export const JAEGER_URL = 'http://localhost:16686';
export const RABBITMQ_URL = 'http://localhost:15672';
