/**
 * Translation between trigger-service's model and the message contracts in contracts/schemas.
 * Nothing outside this file knows the wire format.
 */
import { createEnvelope, type OutboxMessage } from '@routine/service-kit';

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
