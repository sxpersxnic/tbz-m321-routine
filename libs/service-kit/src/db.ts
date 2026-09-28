import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import type { Logger } from './logger.ts';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
/** Anything that can run a query: the pool itself or a client inside a transaction. */
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

const MIGRATION_LOCK_ID = 7_274_663;
const KIT_MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

// Calendar dates stay 'YYYY-MM-DD' strings instead of becoming local-midnight Date objects.
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
}

export async function waitForDatabase(pool: pg.Pool, logger: Logger, attempts = 60): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      logger.warn({ attempt, err: error }, 'database not reachable yet, retrying');
      await sleep(1_000);
    }
  }
}

/**
 * Runs `fn` while holding the migration advisory lock, with `schema_migrations` in place.
 * The lock makes migrations safe when several replicas of a service start at the same time.
 */
async function withMigrationLock(pool: pg.Pool, fn: (client: pg.PoolClient, applied: Set<string>) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const applied = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((row) => row.name),
    );
    await fn(client, applied);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

/** Runs one migration and records it as `name`, atomically. `sql` undefined records it without running anything. */
async function applyMigration(client: pg.PoolClient, name: string, sql: string | undefined): Promise<void> {
  await client.query('BEGIN');
  try {
    if (sql !== undefined) await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** Applies `migrations/*.sql` in lexical order exactly once. */
export async function runMigrations(pool: pg.Pool, directory: string, logger: Logger): Promise<void> {
  await withMigrationLock(pool, async (client, applied) => {
    const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      await applyMigration(client, file, await readFile(join(directory, file), 'utf8'));
      logger.info({ migration: file }, 'migration applied');
    }
  });
}

/** Tables the kit's own modules need, and the table each migration creates. */
const KIT_MIGRATIONS = {
  outbox: { table: 'outbox' },
} as const;

export type KitMigration = keyof typeof KIT_MIGRATIONS;

/**
 * Applies the kit's migrations (`libs/service-kit/migrations/<name>.sql`) exactly once, tracked in
 * `schema_migrations` as `kit:<name>`. A service whose own migrations already created the table
 * (routine-service's `001_init.sql` has the outbox) gets the migration recorded without running it.
 */
export async function runKitMigrations(pool: pg.Pool, names: KitMigration[], logger: Logger): Promise<void> {
  await withMigrationLock(pool, async (client, applied) => {
    for (const name of names) {
      const record = `kit:${name}`;
      if (applied.has(record)) continue;
      const { rows } = await client.query<{ exists: boolean }>('SELECT to_regclass($1) IS NOT NULL AS exists', [KIT_MIGRATIONS[name].table]);
      if (rows[0]?.exists) {
        await applyMigration(client, record, undefined);
        logger.info({ migration: record }, 'kit migration recorded, table already present');
        continue;
      }
      await applyMigration(client, record, await readFile(join(KIT_MIGRATIONS_DIR, `${name}.sql`), 'utf8'));
      logger.info({ migration: record }, 'kit migration applied');
    }
  });
}

export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
