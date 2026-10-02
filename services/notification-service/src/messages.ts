/** Translation between the message contracts and the notification service's own model. */
import { PermanentError, type Envelope } from '@routine/service-kit';

export const SOURCE = 'notification-service';

export type Priority = 'low' | 'normal' | 'high';

/** The service's internal model of "something the user should be told". */
export interface NotificationDraft {
  ownerId: string;
  title: string;
  body: string;
  priority: Priority;
  category: 'action' | 'execution';
  sourceKey: string;
  executionId: string | null;
  /** The routine it is about (stored from M3). */
  routineId?: string | null;
}


function asPriority(value: unknown): Priority {
  return value === 'low' || value === 'high' ? value : 'normal';
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

// ---------------------------------------------------------------- notification.send

/** notification.send – a routine step's notification, once per actionId (source key). */
export function sendDraft(command: { actionId: string; executionId: string; routineId: string | null; ownerId: string; params: Record<string, unknown> }): NotificationDraft {
  const { params } = command;
  const title = text(params.title);
  if (!title) throw new PermanentError('param "title" is required', { code: 'INVALID_PARAMS' });
  return {
    ownerId: command.ownerId,
    title: title.slice(0, 200),
    body: typeof params.body === 'string' ? params.body : params.body === undefined ? '' : JSON.stringify(params.body),
    priority: asPriority(params.priority),
    category: 'action',
    sourceKey: `action:${command.actionId}`,
    executionId: command.executionId,
    routineId: command.routineId,
  };
}

// ---------------------------------------------------------------- execution events (schema evolution)

/**
 * `legacy`   – behaves like the originally deployed consumer: understands only
 *              ExecutionCompleted v1 (`message`). Receiving the contracted v2
 *              payload is the breaking change shown in the demo.
 * `tolerant` – updated consumer: prefers the v2 fields `notification`/`priority`
 *              and falls back to the v1 field `message`. Works in every phase.
 */
export type CompletionReaderMode = 'legacy' | 'tolerant';

export function readExecutionEvent(envelope: Envelope, mode: CompletionReaderMode): NotificationDraft {
  const data = envelope.data;
  const executionId = text(data.executionId);
  const ownerId = text(data.ownerId);
  if (!executionId || !ownerId) throw new PermanentError(`${envelope.type} is missing executionId/ownerId`);
  const routineName = text(data.routineName) ?? 'Routine';
  const routineId = text(data.routineId) ?? null;

  if (envelope.type === 'RoutineUnhealthy') {
    // one per streak. Not a run outcome but news about the routine: category `action`, so it shows on
    // the Notifications page (services/notification-service.md §4) – outcomes stay off it (c854565)
    const failures = typeof data.consecutiveFailures === 'number' ? data.consecutiveFailures : 2;
    return {
      ownerId,
      executionId,
      routineId,
      title: `"${routineName}" failed ${failures} times in a row`,
      body: '',
      priority: 'high',
      category: 'action',
      sourceKey: `routine:${text(data.routineId) ?? 'unknown'}:unhealthy:${executionId}`,
    };
  }

  if (envelope.type === 'ExecutionFailed') {
    // one notification per failure: a resumed run that fails again is news again
    const resumes = typeof data.resumeCount === 'number' && data.resumeCount > 0 ? data.resumeCount : 0;
    return {
      ownerId,
      executionId,
      routineId,
      title: `Routine "${routineName}" failed`,
      body: text(data.reason) ?? '',
      priority: 'high',
      category: 'execution',
      sourceKey: resumes ? `execution:${executionId}:failed:${resumes}` : `execution:${executionId}:failed`,
    };
  }
  if (envelope.type !== 'ExecutionCompleted') throw new PermanentError(`unsupported event type ${envelope.type}`);

  const base = { ownerId, executionId, routineId, category: 'execution' as const, sourceKey: `execution:${executionId}:completed` };
  const legacyMessage = text(data.message);

  if (mode === 'legacy') {
    if (!legacyMessage) {
      throw new PermanentError(`ExecutionCompleted v${envelope.version} has no "message" field – this consumer only understands v1`);
    }
    return { ...base, title: legacyMessage, body: '', priority: 'normal' };
  }

  const notification = data.notification as { title?: unknown; body?: unknown } | undefined;
  const title = text(notification?.title);
  if (title) return { ...base, title, body: text(notification?.body) ?? '', priority: asPriority(data.priority) };
  if (legacyMessage) return { ...base, title: legacyMessage, body: '', priority: 'normal' };
  throw new PermanentError('ExecutionCompleted has neither "notification" nor "message"');
}

/** The routine events this service turns into notifications; others it receives are acknowledged and ignored. */
export const NOTIFYING_EVENTS = new Set(['ExecutionCompleted', 'ExecutionFailed', 'RoutineUnhealthy']);

/** ExecutionResumed: whose failure notifications are resolved now. */
export function readExecutionResumed(envelope: Envelope): { executionId: string; ownerId: string } {
  const executionId = text(envelope.data.executionId);
  const ownerId = text(envelope.data.ownerId);
  if (!executionId || !ownerId) throw new PermanentError('ExecutionResumed is missing executionId/ownerId');
  return { executionId, ownerId };
}

