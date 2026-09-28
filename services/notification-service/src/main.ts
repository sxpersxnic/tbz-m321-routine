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
  notFound,
  onShutdown,
  requireUser,
  runKitMigrations,
  runMigrations,
  startDomain,
  waitForDatabase,
  withContext,
  withTransaction,
} from '@routine/service-kit';
import { deliver, notificationHandlers, type NotificationRow } from './inbox.ts';
import { NOTIFICATIONS_MANIFEST } from './manifest.ts';
import {
  NOTIFYING_EVENTS,
  readExecutionEvent,
  readExecutionResumed,
  type CompletionReaderMode,
} from './messages.ts';

const SERVICE = 'notification-service';
const logger = createLogger(SERVICE);

const readerMode = env('COMPLETION_EVENT_READER', 'tolerant') as CompletionReaderMode;
if (readerMode !== 'legacy' && readerMode !== 'tolerant') throw new Error(`invalid COMPLETION_EVENT_READER ${readerMode}`);

const pool = createPool(env('DATABASE_URL'));
await waitForDatabase(pool, logger);
await runMigrations(pool, join(import.meta.dirname, '..', 'migrations'), logger);
await runKitMigrations(pool, ['outbox', 'processed_actions'], logger);
const broker = new Broker(env('AMQP_URL'), logger);

const notificationDto = (row: NotificationRow) => ({
  id: row.id,
  title: row.title,
  body: row.body,
  priority: row.priority,
  category: row.category,
  executionId: row.execution_id,
  createdAt: row.created_at,
  readAt: row.read_at,
  resolvedAt: row.resolved_at,
});

const chaosFailureRate = envFloat('CHAOS_FAILURE_RATE', 0);

// the `notifications` domain: notification.send on the v1 queue, results and events through the outbox
const domain = startDomain({
  manifest: NOTIFICATIONS_MANIFEST,
  broker,
  pool,
  logger,
  queue: 'notification-service.actions',
  chaosFailureRate,
  handlers: notificationHandlers(logger),
});

// Execution events (pub/sub – the producer does not know this consumer)
broker.consume(
  { queue: 'notification-service.execution-events', retryDelaysMs: [1_000, 5_000], chaosFailureRate },
  async (envelope) => {
    if (envelope.type === 'ExecutionResumed') {
      // "Retry from here": the failure it told the user about is being dealt with (idempotent)
      const { executionId, ownerId } = readExecutionResumed(envelope);
      const { rowCount } = await pool.query(
        `UPDATE notifications SET resolved_at = now()
          WHERE execution_id = $1 AND owner_id = $2 AND source_key LIKE 'execution:%:failed%' AND resolved_at IS NULL`,
        [executionId, ownerId],
      );
      logger.info({ executionId, resolved: rowCount }, 'failure notification resolved – run resumed');
      return;
    }
    // tolerant reader: new execution events (e.g. waiting for you) are not this service's business yet
    if (!NOTIFYING_EVENTS.has(envelope.type)) {
      logger.debug({ event: envelope.type }, 'execution event ignored');
      return;
    }
    const draft = readExecutionEvent(envelope, readerMode);
    await withContext({ executionId: draft.executionId ?? undefined }, async () => {
      const { row, created } = await withTransaction(pool, (tx) => deliver(tx, draft));
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

onShutdown(logger, () => app.close(), () => domain.stop(), () => broker.close(), () => pool.end());
