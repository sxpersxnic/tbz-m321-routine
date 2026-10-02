import { randomUUID } from 'node:crypto';
import { currentContext } from './context.ts';
import type { Queryable } from './db.ts';
import { createEnvelope } from './envelope.ts';
import { enqueue } from './outbox.ts';

/** Where a change came from when a routine step caused it – loop protection (04 §3.5). */
export interface EventOrigin {
  executionId: string;
  routineId: string;
  actionId: string;
  /** The causing step's `context.depth` + 1. */
  depth: number;
}

export const DOMAIN_EVENTS_EXCHANGE = 'domain.events';

/** `task.completed` → `TaskCompleted`, `budget.incomeRecorded` → `BudgetIncomeRecorded` (05 §4.4). */
export function eventTypeName(routingKey: string): string {
  return routingKey
    .split('.')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * Publishes a domain event through the outbox – call it with the transaction of the change, so the
 * event exists if and only if the change does (ADR-10). `type` is the trigger type and the routing
 * key; `data` carries the manifest's trigger fields.
 */
export async function emitEvent(
  tx: Queryable,
  source: string,
  type: string,
  data: { ownerId: string; areaId?: string | null } & Record<string, unknown>,
  origin?: EventOrigin,
): Promise<void> {
  await enqueue(tx, {
    exchange: DOMAIN_EVENTS_EXCHANGE,
    routingKey: type,
    envelope: createEnvelope({
      type: eventTypeName(type),
      version: 1,
      source,
      correlationId: currentContext().correlationId ?? randomUUID(),
      data: { ...data, occurredAt: new Date().toISOString(), ...(origin && { origin }) },
    }),
  });
}
