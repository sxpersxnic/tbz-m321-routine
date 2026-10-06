/**
 * trigger-service (docs/v2/services/trigger-service.md): starts event-triggered routines. It keeps
 * a projection of the subscriptions (RoutineSaved / RoutineDeleted), matches every domain event
 * against them and sends StartRoutineRequested through its outbox – it never creates executions.
 */
import { join } from 'node:path';
import {
  Broker,
  createHttpServer,
  createLogger,
  createPool,
  createServiceTokenVerifier,
  createTokenVerifier,
  env,
  envFloat,
  envInt,
  envList,
  installAuth,
  installServiceAuth,
  onShutdown,
  OutboxRelay,
  runKitMigrations,
  runMigrations,
  serviceTokenProvider,
  startLoop,
  waitForDatabase,
} from '@routine/service-kit';
import { listDecisions, matchEvent, purgeDecisions, readEvent } from './matching.ts';
import { parseRoutineMessage } from './messages.ts';
import { applyRoutineMessage, projectionEmpty, resync } from './projection.ts';
import { routineClient } from './routine-client.ts';
import { registerRoutes } from './routes.ts';

const SERVICE = 'trigger-service';
const logger = createLogger(SERVICE);

const pool = createPool(env('DATABASE_URL'));
await waitForDatabase(pool, logger);
await runMigrations(pool, join(import.meta.dirname, '..', 'migrations'), logger);
await runKitMigrations(pool, ['outbox'], logger);
const broker = new Broker(env('AMQP_URL'), logger);
const routines = routineClient(env('ROUTINE_URL', 'http://routine-service:3000'), serviceTokenProvider(SERVICE, env('SERVICE_TOKEN_SECRET')));
const resyncNow = () => resync(pool, () => routines.eventRoutines());

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
// /internal/** only for these service accounts; admins resync through /api/v1/triggers/resync
installServiceAuth(app, createServiceTokenVerifier(env('JWKS_URL')), envList('INTERNAL_CALLERS', []));
registerRoutes(app, { resync: resyncNow, decisions: (ownerId, routineId) => listDecisions(pool, ownerId, routineId) });

// ------------------------------------------------------------ projection (trigger-service.md §4)

broker.consume({ queue: 'trigger-service.routines', retryDelaysMs: [1_000, 5_000] }, async (envelope) => {
  const message = parseRoutineMessage(envelope);
  const outcome = await applyRoutineMessage(pool, message);
  const routineId = message.kind === 'saved' ? message.routine.routineId : message.routineId;
  logger.debug({ routineId, event: envelope.type, outcome }, 'subscription projected');
});

// ------------------------------------------------------------ matching (trigger-service.md §4)

const maxDepth = envInt('MAX_EVENT_DEPTH', 5);
broker.consume({ queue: 'trigger-service.events', prefetch: 50, retryDelaysMs: [1_000, 5_000] }, async (envelope) => {
  const event = readEvent(envelope);
  if (!event) return; // no owner, or not a trigger type – no routine can start on it
  const counts = await matchEvent(pool, event, maxDepth);
  if (counts.started + counts.filtered + counts.loop + counts.inactive > 0) logger.info({ event: event.type, eventMessageId: event.messageId, ...counts }, 'event matched');
});

// an empty projection (first start, lost volume) is rebuilt from routine-service – retried until it works
let initialResync = await projectionEmpty(pool);
const initialResyncLoop = startLoop('initial-resync', 5_000, logger, async () => {
  if (!initialResync) return;
  const result = await resyncNow();
  initialResync = false;
  logger.info(result, 'empty projection rebuilt from routine-service');
});

const relay = new OutboxRelay(pool, broker, logger, {
  batchSize: 50,
  intervalMs: envInt('OUTBOX_POLL_INTERVAL_MS', 200),
  duplicateRate: envFloat('CHAOS_DUPLICATE_PUBLISH_RATE', 0),
});
const relayLoop = relay.start();
let housekeepingRuns = 0;
const housekeepingLoop = startLoop('housekeeping', 60_000, logger, async () => {
  if (housekeepingRuns++ % 30 === 0) await relay.purgePublished();
  const purged = await purgeDecisions(pool);
  if (purged > 0) logger.info({ purged }, 'decisions older than 7 days removed');
});

await app.listen({ host: '0.0.0.0', port: envInt('PORT', 3000) });
logger.info('trigger-service ready');

onShutdown(
  logger,
  () => app.close(),
  () => housekeepingLoop.stop(),
  () => initialResyncLoop.stop(),
  () => relayLoop.stop(),
  () => broker.close(),
  () => pool.end(),
);
