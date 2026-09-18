import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  Broker,
  conflict,
  createHttpServer,
  createLogger,
  createPool,
  createTokenVerifier,
  env,
  envFloat,
  envInt,
  HttpError,
  installAuth,
  instanceId,
  notFound,
  onShutdown,
  requireUser,
  runMigrations,
  waitForDatabase,
  withContext,
  type Envelope,
  type Queryable,
} from '@routine/service-kit';
import {
  actionCompleted,
  actionFailed,
  actionRef,
  actionRetryScheduled,
  parseCreateTask,
  RESULTS_EXCHANGE,
  type CreateTaskCommand,
} from './messages.ts';

const SERVICE = 'task-service';
const PROCESSED_BY = `${SERVICE}@${instanceId}`;
const logger = createLogger(SERVICE);

const pool = createPool(env('DATABASE_URL'));
await waitForDatabase(pool, logger);
await runMigrations(pool, join(import.meta.dirname, '..', 'migrations'), logger);
const broker = new Broker(env('AMQP_URL'), logger);

interface TaskRow {
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

interface TaskListRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  color: string;
  is_default: boolean;
  created_at: Date;
}

/** Colour names the web client knows (same palette as routines). */
const LIST_COLORS = ['sky', 'indigo', 'violet', 'pink', 'orange', 'green', 'teal', 'grey'];
const DEFAULT_LIST_NAME = 'Todo';

const taskListDto = (row: TaskListRow) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  color: row.color,
  isDefault: row.is_default,
  createdAt: row.created_at,
});

/** The owner's default list, created on first use – concurrent callers end up with the same one. */
async function defaultListId(db: Queryable, ownerId: string): Promise<string> {
  await db.query(
    `INSERT INTO task_lists (id, owner_id, name, is_default) VALUES ($1, $2, $3, true)
     ON CONFLICT (owner_id) WHERE is_default DO NOTHING`,
    [randomUUID(), ownerId, DEFAULT_LIST_NAME],
  );
  const { rows } = await db.query<{ id: string }>('SELECT id FROM task_lists WHERE owner_id = $1 AND is_default', [ownerId]);
  return rows[0].id;
}

async function ownedListId(db: Queryable, ownerId: string, listId: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>('SELECT id FROM task_lists WHERE id = $1 AND owner_id = $2', [listId, ownerId]);
  return rows[0]?.id ?? null;
}

const taskDto = (row: TaskRow) => ({
  id: row.id,
  listId: row.list_id,
  title: row.title,
  description: row.description,
  priority: row.priority,
  status: row.status,
  dueDate: row.due_date,
  sourceExecutionId: row.source_execution_id,
  createdAt: row.created_at,
  completedAt: row.completed_at,
});

/**
 * Idempotent: the unique source_action_id turns a duplicate delivery into a no-op.
 * A list that was deleted after the routine was set up is no reason to lose the
 * task – it lands in the default list instead.
 */
async function createTaskFromAction(command: CreateTaskCommand): Promise<{ task: TaskRow; created: boolean }> {
  const chosen = command.listId ? await ownedListId(pool, command.ownerId, command.listId) : null;
  if (command.listId && !chosen) logger.warn({ listId: command.listId }, 'task list not found – using the default list');
  const listId = chosen ?? (await defaultListId(pool, command.ownerId));
  const inserted = await pool.query<TaskRow>(
    `INSERT INTO tasks (id, owner_id, list_id, title, description, priority, due_date, source_action_id, source_execution_id)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::int IS NULL THEN NULL ELSE current_date + $7::int END, $8, $9)
     ON CONFLICT (source_action_id) DO NOTHING
     RETURNING *`,
    [randomUUID(), command.ownerId, listId, command.title, command.description, command.priority, command.dueInDays, command.actionId, command.executionId],
  );
  if (inserted.rows[0]) return { task: inserted.rows[0], created: true };
  const existing = await pool.query<TaskRow>(
    `SELECT * FROM tasks WHERE source_action_id = $1`,
    [command.actionId],
  );
  return { task: existing.rows[0], created: false };
}

const RESULT_ROUTING_KEYS: Record<string, string> = {
  ActionCompleted: 'action.completed',
  ActionFailed: 'action.failed',
  ActionRetryScheduled: 'action.retry-scheduled',
};

async function publishResult(envelope: Envelope<unknown>) {
  await broker.publish(RESULTS_EXCHANGE, RESULT_ROUTING_KEYS[envelope.type], envelope);
}

broker.consume(
  {
    queue: 'task-service.actions',
    retryDelaysMs: [1_000, 5_000, 15_000],
    chaosFailureRate: envFloat('CHAOS_FAILURE_RATE', 0),
    onRetry: async (envelope, { attempt, delayMs, error }) => {
      const ref = actionRef(envelope);
      if (ref) await publishResult(actionRetryScheduled(ref, error, attempt, delayMs, PROCESSED_BY));
    },
    onGiveUp: async (envelope, { attempt, error }) => {
      const ref = actionRef(envelope);
      if (ref) await publishResult(actionFailed(ref, error, attempt, PROCESSED_BY));
    },
  },
  async (envelope) => {
    const command = parseCreateTask(envelope);
    await withContext({ executionId: command.executionId, actionId: command.actionId }, async () => {
      const { task, created } = await createTaskFromAction(command);
      if (created) logger.info({ taskId: task.id, title: task.title }, 'task created');
      else logger.info({ taskId: task.id }, 'duplicate ActionRequested – task already exists, result re-sent');
      await publishResult(
        actionCompleted(command, { taskId: task.id, listId: task.list_id, title: task.title, dueDate: task.due_date, priority: task.priority }, PROCESSED_BY, !created),
      );
    });
  },
);

// ---------------------------------------------------------------- HTTP API

const app = createHttpServer({
  service: SERVICE,
  logger,
  readiness: {
    database: async () => void (await pool.query('SELECT 1')),
    broker: () => {
      if (!broker.isConnected()) throw new Error('not connected');
    },
  },
});
installAuth(app, createTokenVerifier(env('JWKS_URL')), ['/api/']);

const taskParams = { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string', format: 'uuid' } } } as const;

app.get<{ Querystring: { status?: 'OPEN' | 'DONE'; listId?: string } }>(
  '/api/v1/tasks',
  {
    schema: {
      querystring: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['OPEN', 'DONE'] }, listId: { type: 'string', format: 'uuid' } },
      },
    },
  },
  async (request) => {
    const user = requireUser(request);
    const { rows } = await pool.query<TaskRow>(
      `SELECT * FROM tasks
        WHERE owner_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::uuid IS NULL OR list_id = $3)
        ORDER BY created_at DESC LIMIT 200`,
      [user.id, request.query.status ?? null, request.query.listId ?? null],
    );
    return { items: rows.map(taskDto) };
  },
);

app.post<{ Body: { title: string; description?: string; priority?: string; dueDate?: string; listId?: string } }>(
  '/api/v1/tasks',
  {
    schema: {
      body: {
        type: 'object',
        required: ['title'],
        additionalProperties: false,
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: 'string', maxLength: 2000 },
          priority: { type: 'string', enum: ['low', 'normal', 'high'] },
          dueDate: { type: 'string', format: 'date' },
          listId: { type: 'string', format: 'uuid' },
        },
      },
    },
  },
  async (request, reply) => {
    const user = requireUser(request);
    const { title, description = '', priority = 'normal', dueDate = null } = request.body;
    let listId: string;
    if (request.body.listId) {
      const owned = await ownedListId(pool, user.id, request.body.listId);
      if (!owned) throw new HttpError(422, 'unknown_list', 'This list does not exist');
      listId = owned;
    } else {
      listId = await defaultListId(pool, user.id);
    }
    const { rows } = await pool.query<TaskRow>(
      `INSERT INTO tasks (id, owner_id, list_id, title, description, priority, due_date) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [randomUUID(), user.id, listId, title, description, priority, dueDate],
    );
    return reply.status(201).header('location', `/api/v1/tasks/${rows[0].id}`).send(taskDto(rows[0]));
  },
);

app.patch<{ Params: { taskId: string }; Body: { status: 'OPEN' | 'DONE' } }>(
  '/api/v1/tasks/:taskId',
  {
    schema: {
      params: taskParams,
      body: { type: 'object', required: ['status'], additionalProperties: false, properties: { status: { type: 'string', enum: ['OPEN', 'DONE'] } } },
    },
  },
  async (request) => {
    const user = requireUser(request);
    const { rows } = await pool.query<TaskRow>(
      `UPDATE tasks SET status = $3, completed_at = CASE WHEN $3 = 'DONE' THEN now() ELSE NULL END
        WHERE id = $1 AND owner_id = $2
        RETURNING *`,
      [request.params.taskId, user.id, request.body.status],
    );
    if (!rows[0]) throw notFound('Task');
    return taskDto(rows[0]);
  },
);

// ------------------------------------------------------------ lists

const listParams = { type: 'object', required: ['listId'], properties: { listId: { type: 'string', format: 'uuid' } } } as const;
const listProperties = {
  name: { type: 'string', minLength: 1, maxLength: 60, pattern: '\\S' },
  description: { type: 'string', maxLength: 500 },
  color: { type: 'string', enum: LIST_COLORS },
} as const;

type ListBody = { name: string; description?: string; color?: string };

app.get('/api/v1/task-lists', async (request) => {
  const user = requireUser(request);
  await defaultListId(pool, user.id);
  const { rows } = await pool.query<TaskListRow>(
    'SELECT * FROM task_lists WHERE owner_id = $1 ORDER BY is_default DESC, created_at',
    [user.id],
  );
  return { items: rows.map(taskListDto) };
});

app.post<{ Body: ListBody }>(
  '/api/v1/task-lists',
  { schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: listProperties } } },
  async (request, reply) => {
    const user = requireUser(request);
    const { name, description = '', color = 'sky' } = request.body;
    const { rows } = await pool.query<TaskListRow>(
      'INSERT INTO task_lists (id, owner_id, name, description, color) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [randomUUID(), user.id, name.trim(), description.trim(), color],
    );
    return reply.status(201).header('location', `/api/v1/task-lists/${rows[0].id}`).send(taskListDto(rows[0]));
  },
);

app.patch<{ Params: { listId: string }; Body: Partial<ListBody> }>(
  '/api/v1/task-lists/:listId',
  { schema: { params: listParams, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: listProperties } } },
  async (request) => {
    const user = requireUser(request);
    const { name, description, color } = request.body;
    const { rows } = await pool.query<TaskListRow>(
      `UPDATE task_lists
          SET name = COALESCE($3, name), description = COALESCE($4, description), color = COALESCE($5, color)
        WHERE id = $1 AND owner_id = $2 RETURNING *`,
      [request.params.listId, user.id, name?.trim() ?? null, description?.trim() ?? null, color ?? null],
    );
    if (!rows[0]) throw notFound('Task list');
    return taskListDto(rows[0]);
  },
);

/** Deletes the list with its tasks. The default list stays – it is where tasks without a list go. */
app.delete<{ Params: { listId: string } }>(
  '/api/v1/task-lists/:listId',
  { schema: { params: listParams } },
  async (request, reply) => {
    const user = requireUser(request);
    const { rows } = await pool.query<TaskListRow>('SELECT * FROM task_lists WHERE id = $1 AND owner_id = $2', [request.params.listId, user.id]);
    if (!rows[0]) throw notFound('Task list');
    if (rows[0].is_default) throw conflict('The default list cannot be deleted');
    await pool.query('DELETE FROM task_lists WHERE id = $1', [rows[0].id]);
    return reply.status(204).send();
  },
);

await app.listen({ host: '0.0.0.0', port: envInt('PORT', 3000) });
logger.info('task-service ready');

onShutdown(logger, () => app.close(), () => broker.close(), () => pool.end());
