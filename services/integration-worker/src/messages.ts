/** Translation between the message contracts and the worker's own model. */
import { createEnvelope, PermanentError, type Envelope } from '@routine/service-kit';

export const SOURCE = 'integration-worker';
export const RESULTS_EXCHANGE = 'routine.action-results';

export interface ActionRef {
  actionId: string;
  executionId: string;
  actionType: string;
}

export interface ActionCommand extends ActionRef {
  params: Record<string, unknown>;
}

export function actionRef(envelope: Envelope): ActionRef | null {
  const { actionId, executionId, actionType } = envelope.data;
  if (typeof actionId !== 'string' || typeof executionId !== 'string') return null;
  return { actionId, executionId, actionType: typeof actionType === 'string' ? actionType : 'unknown' };
}

export function parseActionRequested(envelope: Envelope): ActionCommand {
  if (envelope.type !== 'ActionRequested') throw new PermanentError(`unsupported message type ${envelope.type}`);
  const ref = actionRef(envelope);
  if (!ref) throw new PermanentError('ActionRequested is missing ids');
  const params = envelope.data.params;
  return { ...ref, params: params && typeof params === 'object' ? (params as Record<string, unknown>) : {} };
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
