/** The `tasks` capabilities (services/task-service.md §5) as domain-kit handlers. */
import { PermanentError, type CapabilityHandler, type DomainCommand, type HandlerTools, type Logger } from '@routine/service-kit';
import { localDate, parseAwaitParams, parseCreateParams, parseDate, parseId, parseLimit } from './messages.ts';
import { countOpen, defaultListId, doneTasks, eventFields, getTask, insertTask, moveTask, openTasks, ownedListId, setStatus, taskItem, upsertStepTask, type TaskRow } from './tasks.ts';

const DEFAULT_TIMEZONE = 'Europe/Zurich';

export function taskHandlers(logger: Logger): Record<string, CapabilityHandler> {
  return {
    /** A deleted list is no reason to lose the task – it lands in the default list (v1 behaviour). */
    'task.create': async (command, { tx, emit }) => {
      const params = parseCreateParams(command.params, command.context.timezone ?? DEFAULT_TIMEZONE);
      const chosen = params.listId ? await ownedListId(tx, command.ownerId, params.listId) : null;
      if (params.listId && !chosen) logger.warn({ listId: params.listId }, 'task list not found – using the default list');
      const { row, created } = await insertTask(tx, {
        ownerId: command.ownerId,
        listId: chosen ?? (await defaultListId(tx, command.ownerId)),
        title: params.title,
        description: params.description,
        priority: params.priority,
        dueDate: params.dueDate,
        sourceActionId: command.actionId,
        sourceExecutionId: command.executionId,
      });
      if (created) await emit('task.created', await eventFields(tx, row, command.routineId));
      return { kind: 'completed', output: { taskId: row.id, listId: row.list_id, title: row.title, dueDate: row.due_date, priority: row.priority } };
    },

    'task.complete': async (command, { tx, emit }) => {
      const taskId = parseId(command.params.taskId, 'taskId', 'task', true);
      const task = await getTask(tx, command.ownerId, taskId, true);
      if (!task) throw new PermanentError('the task was deleted', { code: 'REFERENCE_GONE' });
      if (task.status === 'DONE') throw new PermanentError('the task is done already', { code: 'CONFLICT' });
      const done = await setStatus(tx, task.id, 'DONE');
      await emit('task.completed', { ...(await eventFields(tx, done, command.routineId)), completedAt: done.completed_at?.toISOString() });
      return { kind: 'completed', output: { taskId: done.id, completedAt: done.completed_at?.toISOString() } };
    },

    'task.move': async (command, { tx, emit }) => {
      const timezone = command.context.timezone ?? DEFAULT_TIMEZONE;
      const taskId = parseId(command.params.taskId, 'taskId', 'task', true);
      const listId = parseId(command.params.listId, 'listId', 'list');
      const task = await getTask(tx, command.ownerId, taskId, true);
      if (!task) throw new PermanentError('the task was deleted', { code: 'REFERENCE_GONE' });
      if (listId && !(await ownedListId(tx, command.ownerId, listId))) throw new PermanentError('the list was deleted', { code: 'REFERENCE_GONE' });
      const moved = await moveTask(tx, task.id, {
        ...(listId && { listId }),
        ...(command.params.dueDate !== undefined && { dueDate: parseDate(command.params.dueDate, 'dueDate', timezone) }),
      });
      if (moved.list_id !== task.list_id || moved.due_date !== task.due_date) {
        await emit('task.moved', { ...(await eventFields(tx, moved, command.routineId)), fromListId: task.list_id });
      }
      return { kind: 'completed', output: { taskId: moved.id } };
    },

    /** "Do yourself": a task for the person; the step completes when they tick it (PATCH, see completeStep). */
    'task.await': async (command, { tx, emit }) => {
      const params = parseAwaitParams(command.params);
      const chosen = params.listId ? await ownedListId(tx, command.ownerId, params.listId) : null;
      if (params.listId && !chosen) logger.warn({ listId: params.listId }, 'task list not found – using the default list');
      const { row, created } = await upsertStepTask(tx, {
        ownerId: command.ownerId,
        listId: chosen ?? (await defaultListId(tx, command.ownerId)),
        title: params.title,
        description: params.description,
        actionId: command.actionId,
        executionId: command.executionId,
        routineId: command.routineId,
        routineName: command.context.routineName ?? null,
      });
      // asked again after its run was resumed: the same task, open again
      await emit(created ? 'task.created' : 'task.reopened', await eventFields(tx, row, command.routineId));
      return { kind: 'awaiting', awaiting: { kind: 'task', refId: row.id, title: row.title } };
    },

    'task.openTasks': async (command, { tx }) => {
      const timezone = command.context.timezone ?? DEFAULT_TIMEZONE;
      const { rows, count } = await openTasks(tx, command.ownerId, {
        listId: parseId(command.params.listId, 'listId', 'list'),
        dueBy: parseDate(command.params.dueBy, 'dueBy', timezone),
        limit: parseLimit(command.params.limit),
      });
      return { kind: 'completed', output: { items: rows.map(taskItem), count } };
    },

    'task.doneTasks': async (command, { tx }) => {
      const timezone = command.context.timezone ?? DEFAULT_TIMEZONE;
      const { rows, count } = await doneTasks(tx, command.ownerId, {
        since: parseDate(command.params.since, 'since', timezone) ?? localDate(timezone),
        limit: parseLimit(command.params.limit),
      });
      return { kind: 'completed', output: { items: rows.map(taskItem), count } };
    },

    'task.count': async (command, { tx }) => {
      const timezone = command.context.timezone ?? DEFAULT_TIMEZONE;
      const count = await countOpen(tx, command.ownerId, {
        listId: parseId(command.params.listId, 'listId', 'list'),
        overdueBefore: command.params.overdueOnly === true ? localDate(timezone) : null,
      });
      return { kind: 'completed', output: { count } };
    },
  };
}

/**
 * Closes a step task whose step is not needed any more (expired, skipped, run cancelled). A task the
 * person ticked first stays done – their tick won (05-messaging §5 rule 4).
 */
export async function cancelStepTask(command: DomainCommand & { reason: string }, { tx }: Pick<HandlerTools, 'tx'>, logger: Logger): Promise<TaskRow | null> {
  const { rows } = await tx.query<TaskRow>('SELECT * FROM tasks WHERE awaiting_action_id = $1 FOR UPDATE', [command.actionId]);
  const task = rows[0];
  if (task?.status !== 'OPEN') {
    logger.info({ actionId: command.actionId, status: task?.status ?? 'none', reason: command.reason }, 'cancel of a step task ignored');
    return task ?? null;
  }
  const cancelled = await setStatus(tx, task.id, 'CANCELLED');
  logger.info({ taskId: task.id, reason: command.reason }, 'step task cancelled');
  return cancelled;
}
