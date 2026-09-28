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
  manifestDigest,
  onShutdown,
  OutboxRelay,
  runKitMigrations,
  runMigrations,
  startLoop,
  waitForDatabase,
  withContext,
} from '@routine/service-kit';
import { ExecutionEngine } from './engine.ts';
import { parseActionResult, parseRegistryMessage, parseRoutineTriggered, type CompletionEventFormat } from './messages.ts';
import { registerRoutes } from './api.ts';
import { CatalogStore } from './catalog-store.ts';
import { Scheduler } from './scheduler.ts';
import { BUILTIN_MANIFESTS } from './domain/builtin-manifests.ts';
import { applyHeartbeat, applyRegistration, staleDomains, type Registration } from './registry.ts';
import { deleteExpiredTestRuns, refreshHealthIfDue } from './store.ts';

const SERVICE = 'routine-service';
const logger = createLogger(SERVICE);

const completionEventFormat = env('EXECUTION_COMPLETED_FORMAT', 'v2') as CompletionEventFormat;
if (!['v1', 'expand', 'v2'].includes(completionEventFormat)) throw new Error(`invalid EXECUTION_COMPLETED_FORMAT ${completionEventFormat}`);

const pool = createPool(env('DATABASE_URL'));
await waitForDatabase(pool, logger);
await runMigrations(pool, join(import.meta.dirname, '..', 'migrations'), logger);
await runKitMigrations(pool, ['outbox'], logger);

const broker = new Broker(env('AMQP_URL'), logger);
const catalog = new CatalogStore(pool);
const engine = new ExecutionEngine(pool, logger, {
  completionEventFormat,
  waitingAfterMs: envInt('WAITING_AFTER_MS', 10_000),
  catalog: () => catalog.get(),
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
// webhook calls carry their secret in the URL instead of a user token
installAuth(app, createTokenVerifier(env('JWKS_URL')), ['/api/'], ['/api/v1/hooks/']);
registerRoutes(app, { pool, engine, catalog });

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

// ------------------------------------------------------------ domain registry (04 §4)

/** Applies a registration and logs what became of it – rejections loudly, they need a person. */
async function register(registration: Registration) {
  const outcome = await applyRegistration(pool, registration);
  const domain = (registration.manifest as { domain?: unknown } | null)?.domain;
  if (outcome.kind === 'rejected') logger.warn({ domain, instance: registration.instance, reason: outcome.reason }, 'domain registration rejected');
  else if (outcome.kind === 'accepted') {
    logger.info({ domain, version: outcome.version, instance: registration.instance }, 'domain registered');
    catalog.invalidate();
  }
  else logger.debug({ domain, outcome: outcome.kind }, 'domain registration');
}

// routine-service's own domains go through the same code path, in-process
const builtinHeartbeat = async () => {
  for (const manifest of BUILTIN_MANIFESTS) await applyHeartbeat(pool, { domain: manifest.domain });
};
for (const manifest of BUILTIN_MANIFESTS) await register({ manifest, digest: manifestDigest(manifest), instance: `${SERVICE}@${instanceId}` });

broker.consume({ queue: 'routine-service.registry', retryDelaysMs: [1_000, 5_000] }, async (envelope) => {
  const message = parseRegistryMessage(envelope);
  if (message.kind === 'registered') await register(message);
  else if (!(await applyHeartbeat(pool, message))) logger.debug({ domain: message.domain }, 'heartbeat of an unregistered domain ignored');
});

const staleAfterMs = envInt('REGISTRY_STALE_AFTER_MS', 90_000);
let stale = '';
const registryLoop = startLoop('registry', 30_000, logger, async () => {
  await builtinHeartbeat();
  // said once per change, not every 30 s
  const now = (await staleDomains(pool, staleAfterMs)).join(',');
  if (now !== stale) logger.warn({ stale: now ? now.split(',') : [] }, now ? 'domains stale – no heartbeat' : 'all domains fresh again');
  stale = now;
});

const relay = new OutboxRelay(pool, broker, logger, {
  batchSize: 50,
  intervalMs: envInt('OUTBOX_POLL_INTERVAL_MS', 200),
  duplicateRate: envFloat('CHAOS_DUPLICATE_PUBLISH_RATE', 0),
});
const relayLoop = relay.start();
const scheduler = new Scheduler(pool, engine, logger);
const schedulerLoop = startLoop('scheduler', envInt('SCHEDULER_INTERVAL_MS', 1_000), logger, () => scheduler.tick());
let housekeepingRuns = 0;
const testRunTtlMs = envInt('TEST_RUN_TTL_MS', 3_600_000);
const housekeepingLoop = startLoop('housekeeping', 2_000, logger, async () => {
  await engine.markStaleExecutions();
  if (housekeepingRuns++ % 1_800 === 0) await relay.purgePublished();
  if (housekeepingRuns % 30 === 0) {
    // nightly 30-day health counts: tried every minute, done once a day by one replica
    if (await refreshHealthIfDue(pool)) logger.info('routine health refreshed');
    // test runs ("Try this step") are gone after an hour; deleting twice is harmless
    const deleted = await deleteExpiredTestRuns(pool, testRunTtlMs);
    if (deleted > 0) logger.info({ deleted }, 'expired test runs deleted');
  }
});

await app.listen({ host: '0.0.0.0', port: envInt('PORT', 3000) });
logger.info({ completionEventFormat }, 'routine-service ready');

onShutdown(
  logger,
  () => app.close(),
  () => schedulerLoop.stop(),
  () => housekeepingLoop.stop(),
  () => registryLoop.stop(),
  () => relayLoop.stop(),
  () => broker.close(),
  () => pool.end(),
);
