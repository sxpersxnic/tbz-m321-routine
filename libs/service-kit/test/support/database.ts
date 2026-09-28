/** A throwaway database with the kit's tables, for kit tests that need Postgres (TEST_DATABASE_URL). */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import pino from 'pino';
import { createPool, runKitMigrations, type Pool } from '../../src/db.ts';

export const needsDatabase = process.env.TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL not set';

export async function kitDatabase(): Promise<{ pool: Pool; close(): Promise<void> }> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL not set');
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  const name = `kit_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const target = new URL(url);
  target.pathname = `/${name}`;
  const pool = createPool(target.toString());
  pool.on('error', () => undefined); // DROP … WITH (FORCE) below ends backends that are still closing
  await runKitMigrations(pool, ['outbox', 'processed_actions'], pino({ level: 'silent' }));
  return {
    pool,
    async close() {
      await pool.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
