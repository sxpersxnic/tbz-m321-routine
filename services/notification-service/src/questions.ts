/** "Ask me" (notification.ask): questions in the inbox that a routine step waits for. */
import { randomUUID } from 'node:crypto';
import { completeAwaiting, conflict, emitEvent, HttpError, notFound, PermanentError, type CapabilityHandler, type DomainCommand, type HandlerTools, type Logger, type PoolClient } from '@routine/service-kit';
import type { NotificationRow } from './inbox.ts';
import { SOURCE } from './messages.ts';

export interface QuestionOption {
  value: string;
  label: string;
}

const INVALID_PARAMS = { code: 'INVALID_PARAMS' } as const;

/** notification.ask params: a question and 2–4 options (`{ value, label }`, or plain text used as both). */
export function parseAskParams(params: Record<string, unknown>): { question: string; body: string; options: QuestionOption[] } {
  const question = typeof params.question === 'string' ? params.question.trim() : '';
  if (question === '') throw new PermanentError('param "question" is required', INVALID_PARAMS);
  if (!Array.isArray(params.options)) throw new PermanentError('param "options" must be a list of 2 to 4 answers', INVALID_PARAMS);
  const options = params.options.map((option): QuestionOption => {
    if (typeof option === 'string' || typeof option === 'number') return { value: String(option), label: String(option) };
    const { value, label } = (option ?? {}) as Record<string, unknown>;
    if (typeof value !== 'string' || value === '') throw new PermanentError('every answer needs a value', INVALID_PARAMS);
    return { value, label: typeof label === 'string' && label !== '' ? label : value };
  });
  if (options.length < 2 || options.length > 4) throw new PermanentError('param "options" must be a list of 2 to 4 answers', INVALID_PARAMS);
  if (new Set(options.map((option) => option.value)).size !== options.length) throw new PermanentError('the answers must be different', INVALID_PARAMS);
  return { question: question.slice(0, 200), body: typeof params.body === 'string' ? params.body : '', options };
}

export function questionHandlers(): Record<string, CapabilityHandler> {
  return {
    'notification.ask': async (command, { tx, emit }) => {
      const { question, body, options } = parseAskParams(command.params);
      // asked again after its run was resumed: the same question, open again
      const { rows } = await tx.query<NotificationRow & { inserted: boolean }>(
        `INSERT INTO notifications (id, owner_id, title, body, priority, category, source_key, execution_id, kind, options, awaiting_action_id, routine_id)
         VALUES ($1, $2, $3, $4, 'normal', 'action', $5, $6, 'question', $7, $8, $9)
         ON CONFLICT (awaiting_action_id) DO UPDATE SET state = 'open', answer = NULL, read_at = NULL
         RETURNING *, (xmax = 0) AS inserted`,
        [randomUUID(), command.ownerId, question, body, `action:${command.actionId}`, command.executionId, JSON.stringify(options), command.actionId, command.routineId],
      );
      const { inserted, ...row } = rows[0];
      if (inserted) {
        await emit('notification.created', {
          ownerId: row.owner_id,
          notificationId: row.id,
          title: row.title,
          body: row.body,
          priority: row.priority,
          kind: 'question',
          options,
          routineId: row.routine_id,
          executionId: row.execution_id,
        });
      }
      return { kind: 'awaiting', awaiting: { kind: 'question', refId: row.id, title: row.title } };
    },
  };
}

/** The step doesn't need an answer any more: an open question expires; an answered one stays answered. */
export async function expireQuestion(command: DomainCommand & { reason: string }, { tx }: Pick<HandlerTools, 'tx'>, logger: Logger): Promise<void> {
  const { rowCount } = await tx.query(`UPDATE notifications SET state = 'expired' WHERE awaiting_action_id = $1 AND state = 'open'`, [command.actionId]);
  logger.info({ actionId: command.actionId, reason: command.reason, expired: rowCount }, rowCount ? 'question expired' : 'cancel of a question ignored');
}

/**
 * The person answers (notification-service.md §3): the answer is stored, the question read, the
 * event emitted and the waiting step completed – all in one transaction, once. 409 if the question
 * isn't open (answered, expired, or no question at all), 422 for an answer it doesn't offer.
 */
export async function answerQuestion(tx: PoolClient, ownerId: string, notificationId: string, value: string): Promise<NotificationRow> {
  const { rows } = await tx.query<NotificationRow>('SELECT * FROM notifications WHERE id = $1 AND owner_id = $2 FOR UPDATE', [notificationId, ownerId]);
  const question = rows[0];
  if (!question) throw notFound('Notification');
  if (question.kind !== 'question') throw conflict('This notification is not a question');
  if (question.state !== 'open') throw conflict(question.state === 'answered' ? 'This question was answered already' : 'This question has expired');
  const option = (question.options ?? []).find((candidate) => candidate.value === value);
  if (!option) throw new HttpError(422, 'unknown_answer', 'This is not one of the answers');
  const answer = { value: option.value, label: option.label, answeredAt: new Date().toISOString() };
  const { rows: updated } = await tx.query<NotificationRow>(
    `UPDATE notifications SET state = 'answered', answer = $2, read_at = COALESCE(read_at, now()) WHERE id = $1 RETURNING *`,
    [question.id, JSON.stringify(answer)],
  );
  await emitEvent(tx, SOURCE, 'notification.answered', { ownerId, notificationId: question.id, value: option.value, label: option.label, routineId: question.routine_id });
  if (question.awaiting_action_id) await completeAwaiting(tx, SOURCE, question.awaiting_action_id, answer);
  return updated[0];
}
