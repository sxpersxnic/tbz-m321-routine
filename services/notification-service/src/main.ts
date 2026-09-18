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
  parseSendNotification,
  readExecutionEvent,
  RESULTS_EXCHANGE,
  type CompletionReaderMode,
  type NotificationDraft,
} from './messages.ts';

const SERVICE = 'notification-service';
const PROCESSED_BY = `${SERVICE}@${instanceId}`;
const logger = createLogger(SERVICE);

const readerMode = env('COMPLETION_EVENT_READER', 'tolerant') as CompletionReaderMode;
if (readerMode !== 'legacy' && readerMode !== 'tolerant') throw new Error(`invalid COMPLETION_EVENT_READER ${readerMode}`);

const pool = createPool(env('DATABASE_URL'));
await waitForDatabase(pool, logger);
await runMigrations(pool, join(import.meta.dirname, '..', 'migrations'), logger);
const broker = new Broker(env('AMQP_URL'), logger);

interface NotificationRow {
  id: string;
  owner_id: string;
  title: string;
  body: string;
  priority: string;
  category: string;
  execution_id: string | null;
  created_at: Date;
  read_at: Date | null;
}

const notificationDto = (row: NotificationRow) => ({
  id: row.id,
  title: row.title,
  body: row.body,
  priority: row.priority,
  category: row.category,
  executionId: row.execution_id,
  createdAt: row.created_at,
  readAt: row.read_at,
});

/** Stores (= delivers to the inbox) exactly once per source message. */
async function deliver(draft: NotificationDraft): Promise<{ row: NotificationRow; created: boolean }> {
  const inserted = await pool.query<NotificationRow>(
    `INSERT INTO notifications (id, owner_id, title, body, priority, category, source_key, execution_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (source_key) DO NOTHING RETURNING *`,
    [randomUUID(), draft.ownerId, draft.title, draft.body, draft.priority, draft.category, draft.sourceKey, draft.executionId],
  );
  if (inserted.rows[0]) return { row: inserted.rows[0], created: true };
  const existing = await pool.query<NotificationRow>('SELECT * FROM notifications WHERE source_key = $1', [draft.sourceKey]);
  return { row: existing.rows[0], created: false };
}

const RESULT_ROUTING_KEYS: Record<string, string> = {
  ActionCompleted: 'action.completed',
  ActionFailed: 'action.failed',
  ActionRetryScheduled: 'action.retry-scheduled',
};

async function publishResult(envelope: Envelope<unknown>) {
  await broker.publish(RESULTS_EXCHANGE, RESULT_ROUTING_KEYS[envelope.type], envelope);
}

const chaosFailureRate = envFloat('CHAOS_FAILURE_RATE', 0);

// notification.send actions of a routine
broker.consume(
  {
    queue: 'notification-service.actions',
    retryDelaysMs: [1_000, 5_000, 15_000],
    chaosFailureRate,
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
    const { ref, draft } = parseSendNotification(envelope);
    await withContext({ executionId: ref.executionId, actionId: ref.actionId }, async () => {
      const { row, created } = await deliver(draft);
      if (created) logger.info({ notificationId: row.id, title: row.title }, 'notification delivered');
      else logger.info({ notificationId: row.id }, 'duplicate ActionRequested – notification already delivered, result re-sent');
      await publishResult(actionCompleted(ref, { notificationId: row.id, channel: 'inbox', deliveredAt: row.created_at }, PROCESSED_BY, !created));
    });
  },
);

// ExecutionCompleted / ExecutionFailed events (pub/sub – the producer does not know this consumer)
broker.consume(
  { queue: 'notification-service.execution-events', retryDelaysMs: [1_000, 5_000], chaosFailureRate },
  async (envelope) => {
    const draft = readExecutionEvent(envelope, readerMode);
    await withContext({ executionId: draft.executionId ?? undefined }, async () => {
      const { row, created } = await deliver(draft);
      if (created) logger.info({ notificationId: row.id, event: envelope.type, eventVersion: envelope.version, readerMode }, 'execution notification delivered');
      else logger.info({ notificationId: row.id, event: envelope.type }, 'duplicate event ignored');
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

app.get<{ Querystring: { unread?: boolean; category?: 'action' | 'execution' } }>(
  '/api/v1/notifications',
  {
    schema: {
      querystring: {
        type: 'object',
        properties: { unread: { type: 'boolean' }, category: { type: 'string', enum: ['action', 'execution'] } },
      },
    },
  },
  async (request) => {
    const user = requireUser(request);
    const { rows } = await pool.query<NotificationRow>(
      `SELECT * FROM notifications
        WHERE owner_id = $1 AND (NOT $2 OR read_at IS NULL) AND ($3::text IS NULL OR category = $3)
        ORDER BY created_at DESC LIMIT 200`,
      [user.id, request.query.unread === true, request.query.category ?? null],
    );
    return { items: rows.map(notificationDto) };
  },
);

app.post<{ Params: { notificationId: string } }>(
  '/api/v1/notifications/:notificationId/read',
  { schema: { params: { type: 'object', required: ['notificationId'], properties: { notificationId: { type: 'string', format: 'uuid' } } } } },
  async (request) => {
    const user = requireUser(request);
    const { rows } = await pool.query<NotificationRow>(
      'UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND owner_id = $2 RETURNING *',
      [request.params.notificationId, user.id],
    );
    if (!rows[0]) throw notFound('Notification');
    return notificationDto(rows[0]);
  },
);

app.delete<{ Params: { notificationId: string } }>(
  '/api/v1/notifications/:notificationId',
  { schema: { params: { type: 'object', required: ['notificationId'], properties: { notificationId: { type: 'string', format: 'uuid' } } } } },
  async (request, reply) => {
    const user = requireUser(request);
    // source_key stays unique only while the row exists – a redelivered message after a delete
    // would bring the notification back, which is the lesser evil than losing a first delivery
    const { rowCount } = await pool.query('DELETE FROM notifications WHERE id = $1 AND owner_id = $2', [request.params.notificationId, user.id]);
    if (!rowCount) throw notFound('Notification');
    return reply.status(204).send();
  },
);

await app.listen({ host: '0.0.0.0', port: envInt('PORT', 3000) });
logger.info({ readerMode }, 'notification-service ready');

onShutdown(logger, () => app.close(), () => broker.close(), () => pool.end());
