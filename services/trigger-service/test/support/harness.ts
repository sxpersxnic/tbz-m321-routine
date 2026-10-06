/**
 * trigger-service tests against a real Postgres: every harness gets its own throwaway database,
 * migrated like production. Needs TEST_DATABASE_URL (a role that may CREATE DATABASE); without it
 * the database tests are skipped.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createPool, runKitMigrations, runMigrations, type Pool } from '@routine/service-kit';
import pg from 'pg';
import pino from 'pino';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
/** For `describe(name, { skip }, …)`: skipped with a reason when there is no test database. */
export const needsDatabase = TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL not set';

export const silentLogger = pino({ level: 'silent' });

export interface Harness {
  pool: Pool;
  close(): Promise<void>;
}

/** A migrated database of its own. */
export async function harness(): Promise<Harness> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL not set');
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  const name = `trigger_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  pool.on('error', () => undefined);
  await runMigrations(pool, join(import.meta.dirname, '..', '..', 'migrations'), silentLogger);
  await runKitMigrations(pool, ['outbox'], silentLogger);
  return {
    pool,
    async close() {
      await pool.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
