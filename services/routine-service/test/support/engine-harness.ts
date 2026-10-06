/**
 * Engine tests against a real Postgres: every harness gets its own throwaway database, migrated like
 * production. Dispatched commands are read from the outbox and results are fed back through
 * `applyResult`, so no broker is involved – the engine's own transactions and locks are what's tested.
 *
 * Needs TEST_DATABASE_URL (a role that may CREATE DATABASE), e.g.
 *   docker run -d --rm -p 55432:5432 -e POSTGRES_PASSWORD=test postgres:17-alpine
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/postgres npm test
 * Without it the engine tests are skipped.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createHttpServer, createPool, manifestDigest, runKitMigrations, runMigrations, withTransaction, type DomainManifest, type ErrorCode, type Pool, type Role } from '@routine/service-kit';
import pg from 'pg';
import pino from 'pino';
import { registerRoutes } from '../../src/api.ts';
import { CatalogStore } from '../../src/catalog-store.ts';
import { validateRoutine, type RoutineInput } from '../../src/domain/definition.ts';
import { ExecutionEngine, type TriggerRequest } from '../../src/engine.ts';
import { applyRegistration } from '../../src/registry.ts';
import type { AwaitingItem } from '../../src/messages.ts';
import { getExecution, insertRoutine, listExecutionActions, listLog, setRoutineActive, type ExecutionActionRow, type RoutineRow } from '../../src/store.ts';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
/** For `describe(name, { skip }, …)`: skipped with a reason when there is no test database. */
export const needsDatabase = TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL not set';

const logger = pino({ level: 'silent' });

export interface Dispatched {
  actionId: string;
  actionKey: string;
  actionType: string;
  params: Record<string, unknown>;
  context?: Record<string, unknown>;
}

export async function engineHarness() {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL not set');
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  const name = `routine_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const pool: Pool = createPool(url.toString());
  // DROP … WITH (FORCE) at the end terminates backends whose sockets are still closing – not an error here
  pool.on('error', () => undefined);
  await runMigrations(pool, join(import.meta.dirname, '..', '..', 'migrations'), logger);
  await runKitMigrations(pool, ['outbox'], logger);

  const catalogStore = new CatalogStore(pool, 0);
  const engine = new ExecutionEngine(pool, logger, { completionEventFormat: 'v2', waitingAfterMs: 10_000, catalog: () => catalogStore.get() });
  const ownerId = randomUUID();

  const harness = {
    pool,
    engine,
    ownerId,

    /** Creates an active routine from a (v1-style) input. */
    async routine(input: Partial<RoutineInput> & Pick<RoutineInput, 'actions'>): Promise<RoutineRow> {
      const definition = validateRoutine({ name: 'Test', trigger: { type: 'manual' }, ...input }, await catalogStore.get());
      const routine = await insertRoutine(pool, randomUUID(), ownerId, definition);
      return setRoutineActive(pool, routine.id, true, null, ownerId);
    },

    /** Creates an execution and starts it, as RoutineTriggered would. Returns its id. */
    async run(routine: RoutineRow, trigger: TriggerRequest = { type: 'manual' }): Promise<string> {
      const created = await withTransaction(pool, (client) => engine.createExecution(client, routine, trigger));
      if (!created) throw new Error('no execution created');
      await engine.start(created.execution.id);
      return created.execution.id;
    },

    execution: (id: string) => getExecution(pool, ownerId, id),

    async actions(executionId: string): Promise<Record<string, ExecutionActionRow>> {
      return Object.fromEntries((await listExecutionActions(pool, executionId)).map((action) => [action.key, action]));
    },

    log: (executionId: string) => listLog(pool, executionId),

    /** ActionRequested commands of this execution in the outbox, oldest first. */
    async dispatched(executionId: string): Promise<Dispatched[]> {
      const { rows } = await pool.query<{ payload: { data: Dispatched } }>(
        `SELECT payload FROM outbox WHERE payload->>'type' = 'ActionRequested' AND payload->'data'->>'executionId' = $1 ORDER BY id`,
        [executionId],
      );
      return rows.map((row) => row.payload.data);
    },

    /** Envelopes of one message type in the outbox (all executions). */
    async published(type: string): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
      const { rows } = await pool.query<{ payload: { type: string; data: Record<string, unknown> } }>(
        `SELECT payload FROM outbox WHERE payload->>'type' = $1 ORDER BY id`,
        [type],
      );
      return rows.map((row) => row.payload);
    },

    /** Registers a (fixture) domain, as its DomainRegistered would; the catalog sees it at once. */
    async register(manifest: DomainManifest): Promise<void> {
      const outcome = await applyRegistration(pool, { manifest, digest: manifestDigest(manifest), instance: 'test' });
      if (outcome.kind === 'rejected') throw new Error(`fixture manifest rejected: ${outcome.reason}`);
      catalogStore.invalidate();
    },

    /** The domain created a human step's item (ActionAwaitingUser). */
    awaiting: (executionId: string, actionId: string, awaiting: AwaitingItem) =>
      engine.applyResult({ kind: 'awaiting', actionId, executionId, awaiting, processedBy: 'test-domain' }),

    complete: (executionId: string, actionId: string, output: Record<string, unknown> = {}) =>
      engine.applyResult({ kind: 'completed', actionId, executionId, output, processedBy: 'test-worker', duplicate: false }),

    fail: (executionId: string, actionId: string, error: string, code: ErrorCode = 'INTERNAL') =>
      engine.applyResult({ kind: 'failed', actionId, executionId, error, code, attempts: 1, processedBy: 'test-worker' }),

    /** The real HTTP routes, signed in as the harness owner – call with `app.inject(…)`. */
    async api({ roles = ['user'] }: { roles?: Role[] } = {}) {
      const app = createHttpServer({ service: 'routine-service-test', logger });
      app.decorateRequest('user', null);
      app.decorateRequest('caller', null);
      app.addHook('preHandler', async (request) => {
        request.user = { id: ownerId, email: 'test@routine.local', roles };
        // stands in for installServiceAuth: a request with x-test-service is that service's call
        const service = request.headers['x-test-service'];
        if (request.url.startsWith('/internal/') && typeof service === 'string') request.caller = { service };
      });
      registerRoutes(app, { pool, engine, catalog: catalogStore });
      await app.ready();
      return app;
    },

    async close(): Promise<void> {
      await pool.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
  return harness;
}

export type EngineHarness = Awaited<ReturnType<typeof engineHarness>>;
