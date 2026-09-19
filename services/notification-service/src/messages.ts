/** Translation between the message contracts and the notification service's own model. */
import { createEnvelope, PermanentError, type Envelope } from '@routine/service-kit';

export const SOURCE = 'notification-service';
export const RESULTS_EXCHANGE = 'routine.action-results';

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
}

export interface ActionRef {
  actionId: string;
  executionId: string;
  actionType: string;
}

function asPriority(value: unknown): Priority {
  return value === 'low' || value === 'high' ? value : 'normal';
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

// ---------------------------------------------------------------- ActionRequested (notification.send)

export function actionRef(envelope: Envelope): ActionRef | null {
  const { actionId, executionId, actionType } = envelope.data;
  if (typeof actionId !== 'string' || typeof executionId !== 'string') return null;
  return { actionId, executionId, actionType: typeof actionType === 'string' ? actionType : 'unknown' };
}

export function parseSendNotification(envelope: Envelope): { ref: ActionRef; draft: NotificationDraft } {
  if (envelope.type !== 'ActionRequested') throw new PermanentError(`unsupported message type ${envelope.type}`);
  const ref = actionRef(envelope);
  const { ownerId, actionType, params } = envelope.data as { ownerId?: unknown; actionType?: unknown; params?: Record<string, unknown> };
  if (!ref || typeof ownerId !== 'string') throw new PermanentError('ActionRequested is missing ids');
  if (actionType !== 'notification.send') throw new PermanentError(`notification-service cannot handle action type ${String(actionType)}`);
  const title = text(params?.title);
  if (!title) throw new PermanentError('param "title" is required');
  return {
    ref,
    draft: {
      ownerId,
      title: title.slice(0, 200),
      body: typeof params?.body === 'string' ? params.body : params?.body === undefined ? '' : JSON.stringify(params.body),
      priority: asPriority(params?.priority),
      category: 'action',
      sourceKey: `action:${ref.actionId}`,
      executionId: ref.executionId,
    },
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

  if (envelope.type === 'ExecutionFailed') {
    return {
      ownerId,
      executionId,
      title: `Routine "${routineName}" failed`,
      body: text(data.reason) ?? '',
      priority: 'high',
      category: 'execution',
      sourceKey: `execution:${executionId}:failed`,
    };
  }
  if (envelope.type !== 'ExecutionCompleted') throw new PermanentError(`unsupported event type ${envelope.type}`);

  const base = { ownerId, executionId, category: 'execution' as const, sourceKey: `execution:${executionId}:completed` };
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

// ---------------------------------------------------------------- results

export function actionCompleted(ref: ActionRef, output: Record<string, unknown>, processedBy: string, duplicate: boolean) {
  return createEnvelope({
    type: 'ActionCompleted',
    version: 1,
    source: SOURCE,
    data: { ...ref, output, processedBy, completedAt: new Date().toISOString(), duplicate },
  });
}

export function actionFailed(ref: ActionRef, error: Error, attempts: number, processedBy: string) {
  return createEnvelope({
    type: 'ActionFailed',
    version: 1,
    source: SOURCE,
    data: { ...ref, error: { code: error.name, message: error.message }, attempts, processedBy },
  });
}

export function actionRetryScheduled(ref: ActionRef, error: Error, attempt: number, nextAttemptInMs: number, processedBy: string) {
  return createEnvelope({
    type: 'ActionRetryScheduled',
    version: 1,
    source: SOURCE,
    data: { ...ref, error: { code: error.name, message: error.message }, attempt, nextAttemptInMs, processedBy },
  });
}
