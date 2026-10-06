/**
 * Translation between trigger-service's model and the message contracts in contracts/schemas.
 * Nothing outside this file knows the wire format.
 */
import { createEnvelope, PermanentError, type Envelope, type OutboxMessage } from '@routine/service-kit';

export const SOURCE = 'trigger-service';

export const EXCHANGES = {
  commands: 'routine.commands',
} as const;

/** The event a routine is started for (StartRoutineRequested `trigger`). */
export interface MatchedEvent {
  /** Trigger type = routing key, e.g. `task.completed`. */
  event: string;
  eventMessageId: string;
  data: Record<string, unknown>;
}

/**
 * StartRoutineRequested v1 (05-messaging §4.3): asks routine-service to start an event-triggered
 * routine. The idempotency key is derived from the event's message id, so a redelivered event
 * never starts a second run.
 *
 * @example
 * await enqueue(tx, startRoutineRequested({
 *   routineId, ownerId, routineVersion: 7,
 *   event: { event: 'task.completed', eventMessageId: envelope.messageId, data: envelope.data },
 *   depth: 1, correlationId: envelope.correlationId,
 * }));
 */
export function startRoutineRequested(input: {
  routineId: string;
  ownerId: string;
  routineVersion: number;
  event: MatchedEvent;
  depth: number;
  correlationId: string;
}): OutboxMessage {
  return {
    exchange: EXCHANGES.commands,
    routingKey: 'routine.start',
    envelope: createEnvelope({
      type: 'StartRoutineRequested',
      version: 1,
      source: SOURCE,
      correlationId: input.correlationId,
      data: {
        routineId: input.routineId,
        ownerId: input.ownerId,
        routineVersion: input.routineVersion,
        trigger: { type: 'event', event: input.event.event, eventMessageId: input.event.eventMessageId, data: input.event.data },
        idempotencyKey: `event:${input.event.eventMessageId}`,
        depth: input.depth,
      },
    }),
  };
}

/** One filter condition of an event trigger (06-engine §2) – same operators as `condition.if`. */
export interface Condition {
  field: string;
  operator: string;
  value?: unknown;
}

/** What trigger-service keeps of a routine: RoutineSaved data, or an item of routine-service's internal list. */
export interface RoutineState {
  routineId: string;
  ownerId: string;
  version: number;
  active: boolean;
  /** Set when the routine starts on an event – null for every other trigger. */
  event: { type: string; filter: Condition[] } | null;
}

function requireString(data: Record<string, unknown>, field: string): string {
  const value = data[field];
  if (typeof value !== 'string' || value === '') throw new PermanentError(`field "${field}" missing or not a string`);
  return value;
}

function conditions(value: unknown): Condition[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && typeof item.field === 'string' && typeof item.operator === 'string')
    .map((item) => ({ field: item.field as string, operator: item.operator as string, ...('value' in item && { value: item.value }) }));
}

/**
 * Reads a routine's state (tolerant reader: extra fields, e.g. `name` or `areaId`, are ignored).
 *
 * @example routineState({ routineId, ownerId, version: 3, active: true, trigger: { type: 'event', event: 'task.completed' } })
 * // → { …, event: { type: 'task.completed', filter: [] } }
 */
export function routineState(data: Record<string, unknown>): RoutineState {
  const version = data.version;
  if (!Number.isInteger(version) || (version as number) < 1) throw new PermanentError('routine state without a version');
  const trigger = data.trigger && typeof data.trigger === 'object' ? (data.trigger as Record<string, unknown>) : {};
  return {
    routineId: requireString(data, 'routineId'),
    ownerId: requireString(data, 'ownerId'),
    version: version as number,
    active: data.active === true,
    event: trigger.type === 'event' && typeof trigger.event === 'string' ? { type: trigger.event, filter: conditions(trigger.filter) } : null,
  };
}

/** A message on `trigger-service.routines`: a routine saved (its full state) or deleted. */
export type RoutineMessage = { kind: 'saved'; routine: RoutineState } | { kind: 'deleted'; routineId: string; ownerId: string };

/**
 * Reads RoutineSaved / RoutineDeleted (05-messaging §4.2).
 *
 * @example parseRoutineMessage(envelope) // → { kind: 'deleted', routineId, ownerId }
 */
export function parseRoutineMessage(envelope: Envelope): RoutineMessage {
  if (envelope.type === 'RoutineSaved') return { kind: 'saved', routine: routineState(envelope.data) };
  if (envelope.type === 'RoutineDeleted') return { kind: 'deleted', routineId: requireString(envelope.data, 'routineId'), ownerId: requireString(envelope.data, 'ownerId') };
  throw new PermanentError(`unsupported message type ${envelope.type}`);
}
