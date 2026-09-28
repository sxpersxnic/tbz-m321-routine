/** The task service's data, as functions over a transaction – shared by the HTTP API and the capabilities. */
import { randomUUID } from 'node:crypto';
import type { Queryable } from '@routine/service-kit';

export interface TaskRow {
  id: string;
  owner_id: string;
  list_id: string;
  title: string;
  description: string;
  priority: string;
  status: 'OPEN' | 'DONE';
  due_date: string | null;
  source_action_id: string | null;
  source_execution_id: string | null;
  created_at: Date;
  completed_at: Date | null;
}

export interface TaskListRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  color: string;
  icon: string | null;
  is_default: boolean;
  created_at: Date;
}

export const DEFAULT_LIST_NAME = 'Todo';

/** The owner's default list, created on first use – concurrent callers end up with the same one. */
export async function defaultListId(db: Queryable, ownerId: string): Promise<string> {
  await db.query(
    `INSERT INTO task_lists (id, owner_id, name, is_default) VALUES ($1, $2, $3, true)
     ON CONFLICT (owner_id) WHERE is_default DO NOTHING`,
    [randomUUID(), ownerId, DEFAULT_LIST_NAME],
  );
  const { rows } = await db.query<{ id: string }>('SELECT id FROM task_lists WHERE owner_id = $1 AND is_default', [ownerId]);
  return rows[0].id;
}

export async function ownedListId(db: Queryable, ownerId: string, listId: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>('SELECT id FROM task_lists WHERE id = $1 AND owner_id = $2', [listId, ownerId]);
  return rows[0]?.id ?? null;
}

export async function getTask(db: Queryable, ownerId: string, taskId: string, forUpdate = false): Promise<TaskRow | null> {
  const { rows } = await db.query<TaskRow>(`SELECT * FROM tasks WHERE id = $1 AND owner_id = $2 ${forUpdate ? 'FOR UPDATE' : ''}`, [taskId, ownerId]);
  return rows[0] ?? null;
}

export interface NewTask {
  ownerId: string;
  listId: string;
  title: string;
  description: string;
  priority: string;
  dueDate: string | null;
  /** Set when a routine step created it: its actionId stays unique (v1 idempotency, kept). */
  sourceActionId?: string;
  sourceExecutionId?: string;
}

/** Inserts a task; with a source action that already created one, returns that one (`created: false`). */
export async function insertTask(db: Queryable, task: NewTask): Promise<{ row: TaskRow; created: boolean }> {
  const { rows } = await db.query<TaskRow>(
    `INSERT INTO tasks (id, owner_id, list_id, title, description, priority, due_date, source_action_id, source_execution_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (source_action_id) DO NOTHING RETURNING *`,
    [randomUUID(), task.ownerId, task.listId, task.title, task.description, task.priority, task.dueDate, task.sourceActionId ?? null, task.sourceExecutionId ?? null],
  );
  if (rows[0]) return { row: rows[0], created: true };
  const { rows: existing } = await db.query<TaskRow>('SELECT * FROM tasks WHERE source_action_id = $1', [task.sourceActionId]);
  return { row: existing[0], created: false };
}

export async function setStatus(db: Queryable, taskId: string, status: 'OPEN' | 'DONE'): Promise<TaskRow> {
  const { rows } = await db.query<TaskRow>(
    `UPDATE tasks SET status = $2, completed_at = CASE WHEN $2 = 'DONE' THEN now() ELSE NULL END WHERE id = $1 RETURNING *`,
    [taskId, status],
  );
  return rows[0];
}

export async function moveTask(db: Queryable, taskId: string, change: { listId?: string; dueDate?: string | null }): Promise<TaskRow> {
  const { rows } = await db.query<TaskRow>(
    `UPDATE tasks SET list_id = COALESCE($2, list_id), due_date = CASE WHEN $3 THEN $4::date ELSE due_date END WHERE id = $1 RETURNING *`,
    [taskId, change.listId ?? null, change.dueDate !== undefined, change.dueDate ?? null],
  );
  return rows[0];
}

/** Open tasks, soonest due first (undated last) – the `task.openTasks` value. */
export async function openTasks(db: Queryable, ownerId: string, filter: { listId: string | null; dueBy: string | null; limit: number }): Promise<{ rows: TaskRow[]; count: number }> {
  const where = `owner_id = $1 AND status = 'OPEN' AND ($2::uuid IS NULL OR list_id = $2) AND ($3::date IS NULL OR due_date <= $3)`;
  const params = [ownerId, filter.listId, filter.dueBy];
  const [{ rows }, { rows: counted }] = await Promise.all([
    db.query<TaskRow>(`SELECT * FROM tasks WHERE ${where} ORDER BY due_date ASC NULLS LAST, created_at LIMIT $4`, [...params, filter.limit]),
    db.query<{ count: number }>(`SELECT count(*)::int AS count FROM tasks WHERE ${where}`, params),
  ]);
  return { rows, count: counted[0]?.count ?? 0 };
}

/** Tasks done since a date (owner's local date, compared in UTC days – good enough for a review). */
export async function doneTasks(db: Queryable, ownerId: string, filter: { since: string; limit: number }): Promise<{ rows: TaskRow[]; count: number }> {
  const where = `owner_id = $1 AND status = 'DONE' AND completed_at >= $2::date`;
  const [{ rows }, { rows: counted }] = await Promise.all([
    db.query<TaskRow>(`SELECT * FROM tasks WHERE ${where} ORDER BY completed_at DESC LIMIT $3`, [ownerId, filter.since, filter.limit]),
    db.query<{ count: number }>(`SELECT count(*)::int AS count FROM tasks WHERE ${where}`, [ownerId, filter.since]),
  ]);
  return { rows, count: counted[0]?.count ?? 0 };
}

export async function countOpen(db: Queryable, ownerId: string, filter: { listId: string | null; overdueBefore: string | null }): Promise<number> {
  const { rows } = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM tasks
      WHERE owner_id = $1 AND status = 'OPEN' AND ($2::uuid IS NULL OR list_id = $2) AND ($3::date IS NULL OR due_date < $3)`,
    [ownerId, filter.listId, filter.overdueBefore],
  );
  return rows[0]?.count ?? 0;
}

/** A task as values and "Repeat for each" see it (04 §2.2). */
export const taskItem = (row: TaskRow) => ({ taskId: row.id, title: row.title, dueDate: row.due_date, priority: row.priority });

/** The fields of every task event (services/task-service.md §4). */
export async function eventFields(db: Queryable, row: TaskRow, sourceRoutineId: string | null = null) {
  const { rows } = await db.query<{ name: string }>('SELECT name FROM task_lists WHERE id = $1', [row.list_id]);
  return {
    ownerId: row.owner_id,
    taskId: row.id,
    title: row.title,
    listId: row.list_id,
    listName: rows[0]?.name ?? null,
    areaId: null,
    priority: row.priority,
    dueDate: row.due_date,
    kind: 'task',
    sourceRoutineId,
  };
}
