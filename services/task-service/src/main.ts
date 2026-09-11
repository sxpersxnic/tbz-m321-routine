import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  Broker,
  createHttpServer,
  createLogger,
  createPool,
  createTokenVerifier,
  env,
  envFloat,
  envInt,
  installAuth,
  instanceId,
  notFound,
  onShutdown,
  requireUser,
  runMigrations,
  waitForDatabase,
  withContext,
  type Envelope,
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

const taskDto = (row: TaskRow) => ({
  id: row.id,
  title: row.title,
  description: row.description,
  priority: row.priority,
  status: row.status,
  dueDate: row.due_date,
  sourceExecutionId: row.source_execution_id,
  createdAt: row.created_at,
  completedAt: row.completed_at,
});

/** Idempotent: the unique source_action_id turns a duplicate delivery into a no-op. */
async function createTaskFromAction(command: CreateTaskCommand): Promise<{ task: TaskRow; created: boolean }> {
  const inserted = await pool.query<TaskRow>(
    `INSERT INTO tasks (id, owner_id, title, description, priority, due_date, source_action_id, source_execution_id)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::int IS NULL THEN NULL ELSE current_date + $6::int END, $7, $8)
     ON CONFLICT (source_action_id) DO NOTHING
     RETURNING *`,
    [randomUUID(), command.ownerId, command.title, command.description, command.priority, command.dueInDays, command.actionId, command.executionId],
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
        actionCompleted(command, { taskId: task.id, title: task.title, dueDate: task.due_date, priority: task.priority }, PROCESSED_BY, !created),
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

app.get<{ Querystring: { status?: 'OPEN' | 'DONE' } }>(
  '/api/v1/tasks',
  { schema: { querystring: { type: 'object', properties: { status: { type: 'string', enum: ['OPEN', 'DONE'] } } } } },
  async (request) => {
    const user = requireUser(request);
    const { rows } = await pool.query<TaskRow>(
      `SELECT * FROM tasks
        WHERE owner_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC LIMIT 200`,
      [user.id, request.query.status ?? null],
    );
    return { items: rows.map(taskDto) };
  },
);

app.post<{ Body: { title: string; description?: string; priority?: string; dueDate?: string } }>(
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
        },
      },
    },
  },
  async (request, reply) => {
    const user = requireUser(request);
    const { title, description = '', priority = 'normal', dueDate = null } = request.body;
    const { rows } = await pool.query<TaskRow>(
      `INSERT INTO tasks (id, owner_id, title, description, priority, due_date) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [randomUUID(), user.id, title, description, priority, dueDate],
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

await app.listen({ host: '0.0.0.0', port: envInt('PORT', 3000) });
logger.info('task-service ready');

onShutdown(logger, () => app.close(), () => broker.close(), () => pool.end());
