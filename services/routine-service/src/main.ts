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
  runMigrations,
  startLoop,
  waitForDatabase,
  withContext,
} from '@routine/service-kit';
import { ExecutionEngine } from './engine.ts';
import { parseActionResult, parseRoutineTriggered, type CompletionEventFormat } from './messages.ts';
import { OutboxRelay } from './outbox.ts';
import { registerRoutes } from './api.ts';
import { Scheduler } from './scheduler.ts';

const SERVICE = 'routine-service';
const logger = createLogger(SERVICE);

const completionEventFormat = env('EXECUTION_COMPLETED_FORMAT', 'v2') as CompletionEventFormat;
if (!['v1', 'expand', 'v2'].includes(completionEventFormat)) throw new Error(`invalid EXECUTION_COMPLETED_FORMAT ${completionEventFormat}`);

const pool = createPool(env('DATABASE_URL'));
await waitForDatabase(pool, logger);
await runMigrations(pool, join(import.meta.dirname, '..', 'migrations'), logger);

const broker = new Broker(env('AMQP_URL'), logger);
const engine = new ExecutionEngine(pool, logger, {
  completionEventFormat,
  waitingAfterMs: envInt('WAITING_AFTER_MS', 10_000),
});

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
registerRoutes(app, { pool, engine });

// The routine service consumes its own RoutineTriggered events: triggering
// (API/scheduler) stays fast and works even while the broker is unavailable.
broker.consume({ queue: 'routine-service.triggers', retryDelaysMs: [1_000, 5_000] }, async (envelope) => {
  const { executionId } = parseRoutineTriggered(envelope);
  await withContext({ executionId }, () => engine.start(executionId));
});

broker.consume(
  { queue: 'routine-service.action-results', prefetch: 20, retryDelaysMs: [1_000, 5_000, 15_000] },
  async (envelope) => {
    const result = parseActionResult(envelope);
    await withContext({ executionId: result.executionId, actionId: result.actionId }, () => engine.applyResult(result));
  },
);

const relay = new OutboxRelay(pool, broker, logger, {
  batchSize: 50,
  intervalMs: envInt('OUTBOX_POLL_INTERVAL_MS', 200),
  duplicateRate: envFloat('CHAOS_DUPLICATE_PUBLISH_RATE', 0),
});
const relayLoop = relay.start();
const scheduler = new Scheduler(pool, engine, logger);
const schedulerLoop = startLoop('scheduler', envInt('SCHEDULER_INTERVAL_MS', 1_000), logger, () => scheduler.tick());
let housekeepingRuns = 0;
const housekeepingLoop = startLoop('housekeeping', 2_000, logger, async () => {
  await engine.markStaleExecutions();
  if (housekeepingRuns++ % 1_800 === 0) await relay.purgePublished();
});

await app.listen({ host: '0.0.0.0', port: envInt('PORT', 3000) });
logger.info({ completionEventFormat }, 'routine-service ready');

onShutdown(
  logger,
  () => app.close(),
  () => schedulerLoop.stop(),
  () => housekeepingLoop.stop(),
  () => relayLoop.stop(),
  () => broker.close(),
  () => pool.end(),
);
