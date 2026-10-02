import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pino from 'pino';
import { runKitMigrations, type Pool } from '../src/db.ts';

const logger = pino({ level: 'silent' });

/** A fake database: knows which tables exist and which migrations are recorded, and logs every statement. */
function database(state: { tables: string[]; applied: string[] }) {
  const statements: string[] = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      statements.push(sql);
      if (sql.startsWith('SELECT name FROM schema_migrations')) return { rows: state.applied.map((name) => ({ name })) };
      if (sql.includes('to_regclass')) return { rows: [{ exists: state.tables.includes(String(params[0])) }] };
      if (sql.startsWith('INSERT INTO schema_migrations')) state.applied.push(String(params[0]));
      if (sql.includes('CREATE TABLE outbox')) state.tables.push('outbox');
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as unknown as Pool, statements };
}

describe('runKitMigrations', () => {
  it('creates the outbox table on a fresh database and records kit:outbox', async () => {
    const state = { tables: [], applied: [] };
    const { pool, statements } = database(state);
    await runKitMigrations(pool, ['outbox'], logger);
    assert.ok(statements.some((sql) => sql.includes('CREATE TABLE outbox')));
    assert.deepEqual(state.applied, ['kit:outbox']);
  });

  it('only records kit:outbox when the service already created the table (routine-service 001_init.sql)', async () => {
    const state = { tables: ['outbox'], applied: ['001_init.sql'] };
    const { pool, statements } = database(state);
    await runKitMigrations(pool, ['outbox'], logger);
    assert.ok(!statements.some((sql) => sql.includes('CREATE TABLE outbox')));
    assert.deepEqual(state.applied, ['001_init.sql', 'kit:outbox']);
  });

  it('does nothing once kit:outbox is recorded', async () => {
    const state = { tables: ['outbox'], applied: ['kit:outbox'] };
    const { pool, statements } = database(state);
    await runKitMigrations(pool, ['outbox'], logger);
    assert.ok(!statements.some((sql) => sql.includes('to_regclass') || sql.startsWith('INSERT')));
  });

  it('holds the migration lock shared with service migrations', async () => {
    const { pool, statements } = database({ tables: [], applied: [] });
    await runKitMigrations(pool, ['outbox'], logger);
    assert.match(statements[0], /pg_advisory_lock/);
    assert.match(statements.at(-1) ?? '', /pg_advisory_unlock/);
  });
});
