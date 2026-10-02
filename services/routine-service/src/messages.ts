/**
 * Translation between this service's internal model and the message contracts
 * in contracts/schemas. Nothing outside this file knows the wire format.
 */
import { createEnvelope, PermanentError, toErrorCode, type Envelope, type ErrorCode } from '@routine/service-kit';
import type { ExecutionTrigger } from './domain/definition.ts';

export const SOURCE = 'routine-service';

export const EXCHANGES = {
  actions: 'routine.actions',
  events: 'routine.events',
  results: 'routine.action-results',
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
  trigger: ExecutionTrigger;
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

/**
 * The result of a `routine.run` step, once the routine it called has finished. The engine
 * answers like any worker would – through the results exchange – so the calling step is
 * completed by the same, idempotent path as every other action.
 */
export function subRoutineResult(input: {
  actionId: string;
  executionId: string;
  correlationId: string;
  outcome: { ok: true; output: Record<string, unknown> } | { ok: false; error: string };
}): OutgoingMessage {
  const ref = { actionId: input.actionId, executionId: input.executionId, actionType: 'routine.run', processedBy: 'routine-engine' };
  return input.outcome.ok
    ? {
        exchange: EXCHANGES.results,
        routingKey: 'action.completed',
        envelope: createEnvelope({
          type: 'ActionCompleted',
          version: 1,
          source: SOURCE,
          correlationId: input.correlationId,
          data: { ...ref, output: input.outcome.output, completedAt: new Date().toISOString(), duplicate: false },
        }),
      }
    : {
        exchange: EXCHANGES.results,
        routingKey: 'action.failed',
        envelope: createEnvelope({
          type: 'ActionFailed',
          version: 1,
          source: SOURCE,
          correlationId: input.correlationId,
          data: { ...ref, error: { code: 'SUBROUTINE_FAILED', message: input.outcome.error }, attempts: 1 },
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
  /** How the step runs (04-domain-platform §3.1): mode live | test, routine name, position, event depth. */
  context?: { mode: 'live' | 'test'; routineName: string; stepIndex: number; stepCount: number; depth: number };
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
        ...(input.context && { context: input.context }),
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
      title: `Routine "${input.routineName}" completed`,
      body: `All actions succeeded (took ${(input.durationMs / 1000).toFixed(1)} s).`,
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
  failedActionType?: string | null;
  errorCode?: ErrorCode | null;
  /** How often the run was resumed before this failure – consumers key their notification on it. */
  resumeCount?: number;
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
        failedActionType: input.failedActionType ?? null,
        errorCode: input.errorCode ?? null,
        resumeCount: input.resumeCount ?? 0,
      },
    }),
  };
}

/** A routine failed `consecutiveFailures` times in a row – its alert threshold (06-engine §10). */
export function routineUnhealthy(input: {
  routineId: string;
  ownerId: string;
  routineName: string;
  consecutiveFailures: number;
  lastErrorCode: ErrorCode | null;
  executionId: string;
  correlationId: string;
}): OutgoingMessage {
  return {
    exchange: EXCHANGES.events,
    routingKey: 'routine.unhealthy',
    envelope: createEnvelope({
      type: 'RoutineUnhealthy',
      version: 1,
      source: SOURCE,
      correlationId: input.correlationId,
      data: {
        routineId: input.routineId,
        ownerId: input.ownerId,
        routineName: input.routineName,
        consecutiveFailures: input.consecutiveFailures,
        lastErrorCode: input.lastErrorCode,
        executionId: input.executionId,
      },
    }),
  };
}

/** A failed run was resumed from its failed step (06-engine §6). */
export function executionResumed(input: {
  executionId: string;
  routineId: string;
  ownerId: string;
  fromActionKey: string;
  resumedBy: string;
  resumeCount: number;
  correlationId: string;
}): OutgoingMessage {
  return {
    exchange: EXCHANGES.events,
    routingKey: 'execution.resumed',
    envelope: createEnvelope({
      type: 'ExecutionResumed',
      version: 1,
      source: SOURCE,
      correlationId: input.correlationId,
      data: {
        executionId: input.executionId,
        routineId: input.routineId,
        ownerId: input.ownerId,
        fromActionKey: input.fromActionKey,
        resumedBy: input.resumedBy,
        resumeCount: input.resumeCount,
      },
    }),
  };
}

/** What a human step waits for (ActionAwaitingUser.awaiting, 05-messaging §4.1). */
export interface AwaitingItem {
  kind: 'task' | 'question' | 'checkIn';
  refId: string;
  title: string;
  dueAt?: string | null;
}

/**
 * A waiting human step is not needed any more (05-messaging §4.1): it expired, or its run was
 * cancelled. Routed like the step's ActionRequested, so the domain that holds the item gets it.
 */
export function actionCancelRequested(input: {
  actionId: string;
  executionId: string;
  routineId: string;
  ownerId: string;
  actionKey: string;
  actionType: string;
  reason: 'expired' | 'runCancelled';
  correlationId: string;
}): OutgoingMessage {
  return {
    exchange: EXCHANGES.actions,
    routingKey: `action.${input.actionType}`,
    envelope: createEnvelope({
      type: 'ActionCancelRequested',
      version: 1,
      source: SOURCE,
      correlationId: input.correlationId,
      data: {
        actionId: input.actionId,
        executionId: input.executionId,
        routineId: input.routineId,
        ownerId: input.ownerId,
        actionKey: input.actionKey,
        actionType: input.actionType,
        reason: input.reason,
      },
    }),
  };
}

/** A run entered WAITING_FOR_YOU: only human steps are in flight (06-engine §5). */
export function executionWaitingForYou(input: {
  executionId: string;
  routineId: string;
  ownerId: string;
  routineName: string;
  awaiting: Array<AwaitingItem & { actionKey: string }>;
  correlationId: string;
}): OutgoingMessage {
  return {
    exchange: EXCHANGES.events,
    routingKey: 'execution.waitingForYou',
    envelope: createEnvelope({
      type: 'ExecutionWaitingForYou',
      version: 1,
      source: SOURCE,
      correlationId: input.correlationId,
      data: {
        executionId: input.executionId,
        routineId: input.routineId,
        ownerId: input.ownerId,
        routineName: input.routineName,
        awaiting: input.awaiting.map((item) => ({ actionKey: item.actionKey, kind: item.kind, refId: item.refId, title: item.title, dueAt: item.dueAt ?? null })),
      },
    }),
  };
}

// ---------------------------------------------------------------- incoming (tolerant reader)

export type ActionResult =
  | { kind: 'completed'; actionId: string; executionId: string; output: Record<string, unknown>; processedBy: string; duplicate: boolean }
  | { kind: 'failed'; actionId: string; executionId: string; error: string; code: ErrorCode; attempts: number; processedBy: string }
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
      return {
        kind: 'failed',
        actionId,
        executionId,
        processedBy,
        error: errorText(data.error),
        code: toErrorCode(data.error && typeof data.error === 'object' ? (data.error as { code?: unknown }).code : undefined),
        attempts: Number(data.attempts ?? 1),
      };
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

export type RegistryMessage =
  | { kind: 'registered'; manifest: unknown; digest: string | undefined; instance: string }
  | { kind: 'heartbeat'; domain: string; manifestVersion: number; instance: string };

/** DomainRegistered / DomainHeartbeat (tolerant: the manifest itself is validated by the registry). */
export function parseRegistryMessage(envelope: Envelope): RegistryMessage {
  const data = envelope.data;
  const instance = typeof data.instance === 'string' ? data.instance : 'unknown';
  if (envelope.type === 'DomainRegistered') {
    return { kind: 'registered', manifest: data.manifest, digest: typeof data.digest === 'string' ? data.digest : undefined, instance };
  }
  if (envelope.type === 'DomainHeartbeat') {
    return { kind: 'heartbeat', domain: requireString(data, 'domain'), manifestVersion: Number(data.manifestVersion ?? 0), instance };
  }
  throw new PermanentError(`unsupported message type ${envelope.type}`);
}

export function parseRoutineTriggered(envelope: Envelope): { executionId: string } {
  if (envelope.type !== 'RoutineTriggered') throw new PermanentError(`unsupported message type ${envelope.type}`);
  return { executionId: requireString(envelope.data, 'executionId') };
}
