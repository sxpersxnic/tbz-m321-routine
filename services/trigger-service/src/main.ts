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
  createTokenVerifier,
  env,
  envFloat,
  envInt,
  installAuth,
  onShutdown,
  OutboxRelay,
  runKitMigrations,
  runMigrations,
  startLoop,
  waitForDatabase,
} from '@routine/service-kit';

const SERVICE = 'trigger-service';
const logger = createLogger(SERVICE);

const pool = createPool(env('DATABASE_URL'));
await waitForDatabase(pool, logger);
await runMigrations(pool, join(import.meta.dirname, '..', 'migrations'), logger);
await runKitMigrations(pool, ['outbox'], logger);
const broker = new Broker(env('AMQP_URL'), logger);

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

const relay = new OutboxRelay(pool, broker, logger, {
  batchSize: 50,
  intervalMs: envInt('OUTBOX_POLL_INTERVAL_MS', 200),
  duplicateRate: envFloat('CHAOS_DUPLICATE_PUBLISH_RATE', 0),
});
const relayLoop = relay.start();
let housekeepingRuns = 0;
const housekeepingLoop = startLoop('housekeeping', 60_000, logger, async () => {
  if (housekeepingRuns++ % 30 === 0) await relay.purgePublished();
});

await app.listen({ host: '0.0.0.0', port: envInt('PORT', 3000) });
logger.info('trigger-service ready');

onShutdown(
  logger,
  () => app.close(),
  () => housekeepingLoop.stop(),
  () => relayLoop.stop(),
  () => broker.close(),
  () => pool.end(),
);
