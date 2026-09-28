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
import { createPool, runKitMigrations, runMigrations, withTransaction, type ErrorCode, type Pool } from '@routine/service-kit';
import pg from 'pg';
import pino from 'pino';
import { validateRoutine, type RoutineInput } from '../../src/domain/definition.ts';
import { ExecutionEngine, type TriggerRequest } from '../../src/engine.ts';
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
  await runMigrations(pool, join(import.meta.dirname, '..', '..', 'migrations'), logger);
  await runKitMigrations(pool, ['outbox'], logger);

  const engine = new ExecutionEngine(pool, logger, { completionEventFormat: 'v2', waitingAfterMs: 10_000 });
  const ownerId = randomUUID();

  const harness = {
    pool,
    engine,
    ownerId,

    /** Creates an active routine from a (v1-style) input. */
    async routine(input: Partial<RoutineInput> & Pick<RoutineInput, 'actions'>): Promise<RoutineRow> {
      const definition = validateRoutine({ name: 'Test', trigger: { type: 'manual' }, ...input });
      const routine = await insertRoutine(pool, randomUUID(), ownerId, definition);
      return setRoutineActive(pool, routine.id, true, null);
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

    complete: (executionId: string, actionId: string, output: Record<string, unknown> = {}) =>
      engine.applyResult({ kind: 'completed', actionId, executionId, output, processedBy: 'test-worker', duplicate: false }),

    fail: (executionId: string, actionId: string, error: string, code: ErrorCode = 'INTERNAL') =>
      engine.applyResult({ kind: 'failed', actionId, executionId, error, code, attempts: 1, processedBy: 'test-worker' }),

    async close(): Promise<void> {
      await pool.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
  return harness;
}

export type EngineHarness = Awaited<ReturnType<typeof engineHarness>>;
