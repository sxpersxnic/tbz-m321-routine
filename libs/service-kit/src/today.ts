import { randomUUID } from 'node:crypto';
import { currentContext } from './context.ts';
import type { Queryable } from './db.ts';
import { createEnvelope } from './envelope.ts';
import type { Tint } from './manifest.ts';
import { enqueue } from './outbox.ts';

/**
 * Today cards (docs/v2/services/today-service.md §3): what a domain contributes to the Today screen.
 * Domains publish them through their outbox; today-service keeps the newest version per card.
 */

export interface CardAction {
  kind: 'complete' | 'snooze' | 'answer' | 'open' | 'skip' | 'custom';
  label: string;
  value?: string;
  /** A same-origin API call – the path must start with /api/v1/. */
  request?: { method: 'POST' | 'PATCH'; path: string; body?: Record<string, unknown> };
}

export interface TodayCard {
  ownerId: string;
  cardId: string;
  domain: string;
  kind: 'item' | 'checklist' | 'metric' | 'event' | 'question' | 'checkIn' | 'attention' | 'suggestion';
  section: 'now' | 'today' | 'later' | 'attention';
  sortKey: string;
  localDate?: string;
  areaId?: string | null;
  title: string;
  subtitle?: string;
  icon?: string;
  tint?: Tint;
  source?: { routineId?: string; routineName?: string; executionId?: string };
  focus?: boolean;
  items?: Array<{ id: string; title: string; subtitle?: string; done: boolean; action?: CardAction; choices?: CardAction[] }>;
  selectable?: { max: number };
  progress?: { done: number; total: number };
  metric?: { value: string; label: string; tone?: 'ok' | 'warn' | 'bad' };
  question?: { text: string; options: Array<{ value: string; label: string }>; action: CardAction };
  checkIn?: { prompt: string; scale: { min: number; max: number } | null; unit?: string; action: CardAction };
  actions?: CardAction[];
  href?: string;
  /** Monotonic per card (the source row's updated_at in ms): today-service keeps the highest. */
  version: number;
  expiresAt?: string;
}

export const TODAY_CARDS_EXCHANGE = 'today.cards';

const envelope = <T>(type: string, source: string, data: T) =>
  createEnvelope({ type, version: 1, source, correlationId: currentContext().correlationId ?? randomUUID(), data });

/** Adds or replaces a card, in the transaction of the change that caused it. */
export async function upsertCard(tx: Queryable, source: string, card: TodayCard): Promise<void> {
  await enqueue(tx, { exchange: TODAY_CARDS_EXCHANGE, routingKey: 'card.upserted', envelope: envelope('TodayCardUpserted', source, card) });
}

/** Removes a card – ignored by today-service if it already holds a newer version. */
export async function removeCard(tx: Queryable, source: string, ownerId: string, cardId: string, version: number): Promise<void> {
  await enqueue(tx, {
    exchange: TODAY_CARDS_EXCHANGE,
    routingKey: 'card.removed',
    envelope: envelope('TodayCardRemoved', source, { ownerId, cardId, version }),
  });
}
