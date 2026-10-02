/** Ticking and reopening a task from the app – shared by the HTTP API and its tests. */
import { completeAwaiting, conflict, emitEvent, notFound, type PoolClient } from '@routine/service-kit';
import { SOURCE } from './messages.ts';
import { eventFields, getTask, setStatus, type TaskRow } from './tasks.ts';

/**
 * Sets a task OPEN or DONE with its event, in the caller's transaction. Ticking a step task also
 * completes the routine step waiting for it – once: a step task can't be reopened, and a cancelled
 * one can't be changed (409).
 */
export async function changeStatus(tx: PoolClient, ownerId: string, taskId: string, status: 'OPEN' | 'DONE'): Promise<TaskRow> {
  const task = await getTask(tx, ownerId, taskId, true);
  if (!task) throw notFound('Task');
  if (task.status === status) return task; // nothing changed – no event
  // a step task belongs to its run: ticking it is final, and a cancelled one is closed
  if (task.kind === 'step' && task.status !== 'OPEN') {
    throw conflict(task.status === 'DONE' ? 'This step is done – its routine has moved on' : 'This step is not needed any more');
  }
  const row = await setStatus(tx, task.id, status);
  const fields = await eventFields(tx, row);
  if (row.status === 'DONE') await emitEvent(tx, SOURCE, 'task.completed', { ...fields, completedAt: row.completed_at?.toISOString() });
  else await emitEvent(tx, SOURCE, 'task.reopened', fields);
  // the human step completes in the same transaction as the tick (04 §6.1)
  if (row.kind === 'step' && row.awaiting_action_id && row.status === 'DONE') {
    await completeAwaiting(tx, SOURCE, row.awaiting_action_id, { taskId: row.id, completedAt: row.completed_at?.toISOString() });
  }
  return row;
}
