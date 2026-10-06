/**
 * Matching (trigger-service.md §4): every event is checked against the owner's subscriptions for
 * its type. Each decision – started, filtered, loop, inactive – is logged once per event and
 * routine; a start goes out through the outbox in the same transaction as its log row.
 */
import { enqueue, withTransaction, type Envelope, type Pool, type Queryable } from '@routine/service-kit';
import { filterMatches } from './conditions.ts';
import { startRoutineRequested, type Condition } from './messages.ts';

/** Event chains stop here: a run started by an event a 5th-generation run caused does not start. */
export const MAX_EVENT_DEPTH = 5;

export type Outcome = 'started' | 'filtered' | 'loop' | 'inactive';

/** Where an event came from when a routine run caused it. */
export interface EventOrigin {
  routineId: string | null;
  depth: number;
}

/** A domain or execution event, as matching reads it. */
export interface IncomingEvent {
  /** Trigger type, e.g. `task.completed`. */
  type: string;
  messageId: string;
  correlationId: string;
  ownerId: string;
  data: Record<string, unknown>;
  origin: EventOrigin | null;
}

/** A subscription row: a routine that starts on this event type. */
export interface Subscription {
  routine_id: string;
  owner_id: string;
  event_type: string;
  filter: Condition[];
  routine_version: number;
  active: boolean;
}

/**
 * `TaskCompleted` → `task.completed`, `BudgetIncomeRecorded` → `budget.incomeRecorded` – the inverse
 * of the kit's `eventTypeName` (05 §4.4; every prefix is one word). The routing key cannot be used:
 * a retried message comes back with the queue's name as its routing key.
 *
 * @example eventTypeOf('HomeShoppingItemAdded') // → 'home.shoppingItemAdded'
 */
export function eventTypeOf(envelopeType: string): string | null {
  const match = /^([A-Z][a-z0-9]*)([A-Z][A-Za-z0-9]*)$/.exec(envelopeType);
  if (!match) return null;
  const [, prefix, rest] = match;
  return `${prefix.toLowerCase()}.${rest.charAt(0).toLowerCase()}${rest.slice(1)}`;
}

function originOf(type: string, data: Record<string, unknown>): EventOrigin | null {
  // execution events are always caused by a run: its routine, one level deeper than the run
  if (type.startsWith('execution.')) {
    const depth = Number.isInteger(data.depth) ? (data.depth as number) : 0;
    return { routineId: typeof data.routineId === 'string' ? data.routineId : null, depth: depth + 1 };
  }
  const origin = data.origin;
  if (!origin || typeof origin !== 'object') return null;
  const { routineId, depth } = origin as Record<string, unknown>;
  return { routineId: typeof routineId === 'string' ? routineId : null, depth: Number.isInteger(depth) ? (depth as number) : 1 };
}

/**
 * Reads an event (tolerant reader). Null for what no routine can start on: no owner, or a type
 * that is no trigger type.
 *
 * @example readEvent(envelope) // → { type: 'task.completed', ownerId, data, origin: { routineId, depth: 1 }, … }
 */
export function readEvent(envelope: Envelope): IncomingEvent | null {
  const type = eventTypeOf(envelope.type);
  const { data } = envelope;
  if (!type || typeof data?.ownerId !== 'string' || data.ownerId === '') return null;
  return { type, messageId: envelope.messageId, correlationId: envelope.correlationId, ownerId: data.ownerId, data, origin: originOf(type, data) };
}

/**
 * What to do with one subscription for one event.
 *
 * @example decide(subscription, event) // → 'loop' when the routine caused the event itself
 */
export function decide(subscription: Subscription, event: IncomingEvent, maxDepth = MAX_EVENT_DEPTH): Outcome {
  if (!subscription.active) return 'inactive';
  if (!filterMatches(subscription.filter, event.data)) return 'filtered';
  if (event.origin?.routineId === subscription.routine_id) return 'loop';
  if (event.origin && event.origin.depth >= maxDepth) return 'loop';
  return 'started';
}

/**
 * Matches one event against the owner's subscriptions. A redelivered event is not decided twice:
 * the log row is unique per event and routine, and a start goes out only with a new row.
 *
 * @example await matchEvent(pool, readEvent(envelope)) // → { started: 1, filtered: 0, loop: 0, inactive: 0 }
 */
export async function matchEvent(pool: Pool, event: IncomingEvent, maxDepth = MAX_EVENT_DEPTH): Promise<Record<Outcome, number>> {
  const counts: Record<Outcome, number> = { started: 0, filtered: 0, loop: 0, inactive: 0 };
  const { rows } = await pool.query<Subscription>(
    'SELECT routine_id, owner_id, event_type, filter, routine_version, active FROM subscriptions WHERE owner_id = $1 AND event_type = $2',
    [event.ownerId, event.type],
  );
  for (const subscription of rows) {
    const outcome = decide(subscription, event, maxDepth);
    const decided = await withTransaction(pool, async (tx) => {
      const logged = await tx.query(
        `INSERT INTO match_log (event_message_id, routine_id, owner_id, event_type, outcome) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (event_message_id, routine_id) DO NOTHING`,
        [event.messageId, subscription.routine_id, event.ownerId, event.type, outcome],
      );
      if (!logged.rowCount) return false;
      if (outcome === 'started') {
        await enqueue(
          tx,
          startRoutineRequested({
            routineId: subscription.routine_id,
            ownerId: event.ownerId,
            routineVersion: subscription.routine_version,
            event: { event: event.type, eventMessageId: event.messageId, data: event.data },
            depth: event.origin?.depth ?? 0,
            correlationId: event.correlationId,
          }),
        );
      }
      return true;
    });
    if (decided) counts[outcome]++;
  }
  return counts;
}

/** One logged decision, as the API returns it. */
export interface Decision {
  eventMessageId: string;
  event: string;
  outcome: Outcome;
  at: Date;
}

/**
 * The last 50 decisions for one of the owner's routines, newest first.
 *
 * @example await listDecisions(pool, user.id, routineId) // → [{ eventMessageId, event: 'task.completed', outcome: 'started', at }]
 */
export async function listDecisions(db: Queryable, ownerId: string, routineId: string): Promise<Decision[]> {
  const { rows } = await db.query<{ event_message_id: string; event_type: string; outcome: Outcome; at: Date }>(
    'SELECT event_message_id, event_type, outcome, at FROM match_log WHERE owner_id = $1 AND routine_id = $2 ORDER BY at DESC, id DESC LIMIT 50',
    [ownerId, routineId],
  );
  return rows.map((row) => ({ eventMessageId: row.event_message_id, event: row.event_type, outcome: row.outcome, at: row.at }));
}

/** Decisions are kept 7 days (trigger-service.md §2). */
export async function purgeDecisions(db: Queryable): Promise<number> {
  const { rowCount } = await db.query(`DELETE FROM match_log WHERE at < now() - interval '7 days'`);
  return rowCount ?? 0;
}
