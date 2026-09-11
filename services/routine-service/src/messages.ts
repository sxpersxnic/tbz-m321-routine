/**
 * Translation between this service's internal model and the message contracts
 * in contracts/schemas. Nothing outside this file knows the wire format.
 */
import { createEnvelope, PermanentError, type Envelope } from '@routine/service-kit';

export const SOURCE = 'routine-service';

export const EXCHANGES = {
  actions: 'routine.actions',
  events: 'routine.events',
} as const;

export interface OutgoingMessage {
  exchange: string;
  routingKey: string;
  envelope: Envelope<unknown>;
}

// ---------------------------------------------------------------- outgoing

export function routineTriggered(input: {
  executionId: string;
  routineId: string;
  ownerId: string;
  trigger: 'manual' | 'schedule';
  scheduledFor: Date | null;
  correlationId: string;
}): OutgoingMessage {
  return {
    exchange: EXCHANGES.events,
    routingKey: 'routine.triggered',
    envelope: createEnvelope({
      type: 'RoutineTriggered',
      version: 1,
      source: SOURCE,
      correlationId: input.correlationId,
      data: {
        executionId: input.executionId,
        routineId: input.routineId,
        ownerId: input.ownerId,
        trigger: input.trigger,
        scheduledFor: input.scheduledFor?.toISOString() ?? null,
      },
    }),
  };
}

export function actionRequested(input: {
  actionId: string;
  executionId: string;
  routineId: string;
  ownerId: string;
  actionKey: string;
  actionType: string;
  params: Record<string, unknown>;
  correlationId: string;
  causationId?: string;
}): OutgoingMessage {
  return {
    exchange: EXCHANGES.actions,
    routingKey: `action.${input.actionType}`,
    envelope: createEnvelope({
      type: 'ActionRequested',
      version: 1,
      source: SOURCE,
      correlationId: input.correlationId,
      causationId: input.causationId,
      data: {
        actionId: input.actionId,
        executionId: input.executionId,
        routineId: input.routineId,
        ownerId: input.ownerId,
        actionKey: input.actionKey,
        actionType: input.actionType,
        params: input.params,
      },
    }),
  };
}

/**
 * Expand-and-contract for ExecutionCompleted:
 *   v1     – original payload with `message`
 *   expand – v2 payload that still carries the v1 field `message` (old and new consumers work)
 *   v2     – contracted payload; `message` removed (requires consumers that read v2)
 */
export type CompletionEventFormat = 'v1' | 'expand' | 'v2';

export function executionCompleted(
  input: { executionId: string; routineId: string; ownerId: string; routineName: string; correlationId: string; durationMs: number },
  format: CompletionEventFormat,
): OutgoingMessage {
  const common = {
    executionId: input.executionId,
    routineId: input.routineId,
    ownerId: input.ownerId,
    routineName: input.routineName,
  };
  const legacyMessage = `Routine "${input.routineName}" completed`;
  const v2Fields = {
    notification: {
      title: `Routine "${input.routineName}" abgeschlossen`,
      body: `Alle Aktionen wurden erfolgreich ausgeführt (Dauer ${(input.durationMs / 1000).toFixed(1)} s).`,
    },
    priority: 'normal',
  };
  const data =
    format === 'v1'
      ? { ...common, message: legacyMessage }
      : format === 'expand'
        ? { ...common, message: legacyMessage, ...v2Fields }
        : { ...common, ...v2Fields };

  return {
    exchange: EXCHANGES.events,
    routingKey: 'execution.completed',
    envelope: createEnvelope({
      type: 'ExecutionCompleted',
      version: format === 'v1' ? 1 : 2,
      source: SOURCE,
      correlationId: input.correlationId,
      data,
    }),
  };
}

export function executionFailed(input: {
  executionId: string;
  routineId: string;
  ownerId: string;
  routineName: string;
  reason: string;
  failedActionKey: string | null;
  correlationId: string;
}): OutgoingMessage {
  return {
    exchange: EXCHANGES.events,
    routingKey: 'execution.failed',
    envelope: createEnvelope({
      type: 'ExecutionFailed',
      version: 1,
      source: SOURCE,
      correlationId: input.correlationId,
      data: {
        executionId: input.executionId,
        routineId: input.routineId,
        ownerId: input.ownerId,
        routineName: input.routineName,
        reason: input.reason,
        failedActionKey: input.failedActionKey,
      },
    }),
  };
}

// ---------------------------------------------------------------- incoming (tolerant reader)

export type ActionResult =
  | { kind: 'completed'; actionId: string; executionId: string; output: Record<string, unknown>; processedBy: string; duplicate: boolean }
  | { kind: 'failed'; actionId: string; executionId: string; error: string; attempts: number; processedBy: string }
  | { kind: 'retry'; actionId: string; executionId: string; attempt: number; nextAttemptInMs: number; error: string; processedBy: string };

function requireString(data: Record<string, unknown>, field: string): string {
  const value = data[field];
  if (typeof value !== 'string' || value === '') throw new PermanentError(`field "${field}" missing or not a string`);
  return value;
}

function errorText(value: unknown): string {
  if (value && typeof value === 'object' && 'message' in value) return String((value as { message: unknown }).message);
  return 'unknown error';
}

/** Reads only the fields this service needs and ignores everything else. */
export function parseActionResult(envelope: Envelope): ActionResult {
  const data = envelope.data;
  const actionId = requireString(data, 'actionId');
  const executionId = requireString(data, 'executionId');
  const processedBy = typeof data.processedBy === 'string' ? data.processedBy : 'unknown';
  switch (envelope.type) {
    case 'ActionCompleted':
      return {
        kind: 'completed',
        actionId,
        executionId,
        processedBy,
        output: data.output && typeof data.output === 'object' ? (data.output as Record<string, unknown>) : {},
        duplicate: data.duplicate === true,
      };
    case 'ActionFailed':
      return { kind: 'failed', actionId, executionId, processedBy, error: errorText(data.error), attempts: Number(data.attempts ?? 1) };
    case 'ActionRetryScheduled':
      return {
        kind: 'retry',
        actionId,
        executionId,
        processedBy,
        error: errorText(data.error),
        attempt: Number(data.attempt ?? 1),
        nextAttemptInMs: Number(data.nextAttemptInMs ?? 0),
      };
    default:
      throw new PermanentError(`unsupported message type ${envelope.type}`);
  }
}

export function parseRoutineTriggered(envelope: Envelope): { executionId: string } {
  if (envelope.type !== 'RoutineTriggered') throw new PermanentError(`unsupported message type ${envelope.type}`);
  return { executionId: requireString(envelope.data, 'executionId') };
}
