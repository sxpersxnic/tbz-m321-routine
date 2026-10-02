import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  Broker,
  conflict,
  createHttpServer,
  createLogger,
  createPool,
  createTokenVerifier,
  emitEvent,
  env,
  envFloat,
  envInt,
  HttpError,
  installAuth,
  notFound,
  onShutdown,
  requireUser,
  runKitMigrations,
  runMigrations,
  startDomain,
  waitForDatabase,
  withTransaction,
} from '@routine/service-kit';
import { cancelStepTask, taskHandlers } from './capabilities.ts';
import { changeStatus } from './status.ts';
import { TASKS_MANIFEST } from './manifest.ts';
import { SOURCE } from './messages.ts';
import { defaultListId, eventFields, insertTask, ownedListId, type TaskListRow, type TaskRow } from './tasks.ts';

const SERVICE = SOURCE;
const logger = createLogger(SERVICE);

const pool = createPool(env('DATABASE_URL'));
await waitForDatabase(pool, logger);
await runMigrations(pool, join(import.meta.dirname, '..', 'migrations'), logger);
await runKitMigrations(pool, ['outbox', 'processed_actions'], logger);
const broker = new Broker(env('AMQP_URL'), logger);

/** Colour names the web client knows (same palette as routines). */
const LIST_COLORS = ['sky', 'indigo', 'violet', 'pink', 'orange', 'green', 'teal', 'grey'];

const taskListDto = (row: TaskListRow) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  color: row.color,
  icon: row.icon,
  isDefault: row.is_default,
  createdAt: row.created_at,
});

const taskDto = (row: TaskRow) => ({
  id: row.id,
  listId: row.list_id,
  title: row.title,
  description: row.description,
  priority: row.priority,
  status: row.status,
  dueDate: row.due_date,
  sourceExecutionId: row.source_execution_id,
  kind: row.kind,
  sourceRoutineId: row.source_routine_id,
  sourceRoutineName: row.source_routine_name,
  awaitingActionId: row.awaiting_action_id,
  createdAt: row.created_at,
  completedAt: row.completed_at,
});

// the `tasks` domain: registration, its capabilities (on the v1 queue), results and events through the outbox
const domain = startDomain({
  manifest: TASKS_MANIFEST,
  broker,
  pool,
  logger,
  queue: 'task-service.actions',
  handlers: taskHandlers(logger),
  cancel: { 'task.await': async (command, tools) => void (await cancelStepTask(command, tools, logger)) },
  chaosFailureRate: envFloat('CHAOS_FAILURE_RATE', 0),
});

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

app.get<{ Querystring: { status?: 'OPEN' | 'DONE' | 'CANCELLED'; listId?: string } }>(
  '/api/v1/tasks',
  {
    schema: {
      querystring: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['OPEN', 'DONE', 'CANCELLED'] }, listId: { type: 'string', format: 'uuid' } },
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
    // the task and its task.created event commit together (outbox) – no event without a task, or vice versa
    const task = await withTransaction(pool, async (tx) => {
      let listId: string;
      if (request.body.listId) {
        const owned = await ownedListId(tx, user.id, request.body.listId);
        if (!owned) throw new HttpError(422, 'unknown_list', 'This list does not exist');
        listId = owned;
      } else {
        listId = await defaultListId(tx, user.id);
      }
      const { row } = await insertTask(tx, { ownerId: user.id, listId, title, description, priority, dueDate });
      await emitEvent(tx, SERVICE, 'task.created', await eventFields(tx, row));
      return row;
    });
    return reply.status(201).header('location', `/api/v1/tasks/${task.id}`).send(taskDto(task));
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
    const updated = await withTransaction(pool, (tx) => changeStatus(tx, user.id, request.params.taskId, request.body.status));
    return taskDto(updated);
  },
);

// ------------------------------------------------------------ lists

const listParams = { type: 'object', required: ['listId'], properties: { listId: { type: 'string', format: 'uuid' } } } as const;
const listProperties = {
  name: { type: 'string', minLength: 1, maxLength: 60, pattern: '\\S' },
  description: { type: 'string', maxLength: 500 },
  color: { type: 'string', enum: LIST_COLORS },
  icon: { type: ['string', 'null'], pattern: '^[a-z][a-z0-9-]{0,39}$' },
} as const;

type ListBody = { name: string; description?: string; color?: string; icon?: string | null };

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
    const { name, description = '', color = 'sky', icon = null } = request.body;
    const { rows } = await pool.query<TaskListRow>(
      'INSERT INTO task_lists (id, owner_id, name, description, color, icon) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [randomUUID(), user.id, name.trim(), description.trim(), color, icon],
    );
    return reply.status(201).header('location', `/api/v1/task-lists/${rows[0].id}`).send(taskListDto(rows[0]));
  },
);

app.patch<{ Params: { listId: string }; Body: Partial<ListBody> }>(
  '/api/v1/task-lists/:listId',
  { schema: { params: listParams, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: listProperties } } },
  async (request) => {
    const user = requireUser(request);
    const { name, description, color, icon } = request.body;
    // icon: omitted = unchanged, null = back to the default symbol
    const { rows } = await pool.query<TaskListRow>(
      `UPDATE task_lists
          SET name = COALESCE($3, name), description = COALESCE($4, description), color = COALESCE($5, color),
              icon = CASE WHEN $6 THEN $7 ELSE icon END
        WHERE id = $1 AND owner_id = $2 RETURNING *`,
      [request.params.listId, user.id, name?.trim() ?? null, description?.trim() ?? null, color ?? null, icon !== undefined, icon ?? null],
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
    await withTransaction(pool, async (tx) => {
      // open steps of running routines must not vanish with their list – they move to the default list
      await tx.query(`UPDATE tasks SET list_id = $2 WHERE list_id = $1 AND kind = 'step' AND status = 'OPEN'`, [rows[0].id, await defaultListId(tx, user.id)]);
      await tx.query('DELETE FROM task_lists WHERE id = $1', [rows[0].id]);
    });
    return reply.status(204).send();
  },
);

await app.listen({ host: '0.0.0.0', port: envInt('PORT', 3000) });
logger.info('task-service ready');

onShutdown(logger, () => app.close(), () => domain.stop(), () => broker.close(), () => pool.end());
