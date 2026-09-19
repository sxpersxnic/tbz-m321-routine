/** Translation between the message contracts and the task service's own model. */
import { createEnvelope, PermanentError, type Envelope } from '@routine/service-kit';

export const SOURCE = 'task-service';
export const RESULTS_EXCHANGE = 'routine.action-results';

export type Priority = 'low' | 'normal' | 'high';

export interface CreateTaskCommand {
  actionId: string;
  executionId: string;
  ownerId: string;
  actionType: string;
  title: string;
  description: string;
  priority: Priority;
  dueInDays: number | null;
  /** Target list; null = the owner's default list. */
  listId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ActionRef {
  actionId: string;
  executionId: string;
  actionType: string;
}

/** Reads the fields needed to answer an ActionRequested, even if the params are unusable. */
export function actionRef(envelope: Envelope): ActionRef | null {
  const { actionId, executionId, actionType } = envelope.data;
  if (typeof actionId !== 'string' || typeof executionId !== 'string') return null;
  return { actionId, executionId, actionType: typeof actionType === 'string' ? actionType : 'unknown' };
}

export function parseCreateTask(envelope: Envelope): CreateTaskCommand {
  if (envelope.type !== 'ActionRequested') throw new PermanentError(`unsupported message type ${envelope.type}`);
  const ref = actionRef(envelope);
  const { ownerId, actionType, params } = envelope.data as { ownerId?: unknown; actionType?: unknown; params?: Record<string, unknown> };
  if (!ref || typeof ownerId !== 'string') throw new PermanentError('ActionRequested is missing ids');
  if (actionType !== 'task.create') throw new PermanentError(`task-service cannot handle action type ${String(actionType)}`);

  const title = params?.title;
  if (typeof title !== 'string' || title.trim() === '') throw new PermanentError('param "title" is required');
  const priority = params?.priority ?? 'normal';
  if (priority !== 'low' && priority !== 'normal' && priority !== 'high') throw new PermanentError('param "priority" must be low, normal or high');
  const dueInDays = params?.dueInDays;
  if (dueInDays !== undefined && (!Number.isInteger(dueInDays) || (dueInDays as number) < 0)) {
    throw new PermanentError('param "dueInDays" must be a non-negative integer');
  }

  const listId = params?.listId;
  if (listId !== undefined && listId !== '' && (typeof listId !== 'string' || !UUID.test(listId))) {
    throw new PermanentError('param "listId" must be a list id');
  }

  return {
    ...ref,
    ownerId,
    listId: typeof listId === 'string' && listId !== '' ? listId : null,
    title: title.trim().slice(0, 200),
    description: typeof params?.description === 'string' ? params.description : '',
    priority,
    dueInDays: (dueInDays as number | undefined) ?? null,
  };
}

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
