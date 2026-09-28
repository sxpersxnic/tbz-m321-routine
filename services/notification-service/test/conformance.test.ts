/** The `notifications` domain against the conformance checklist (04 §7), with a real database. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createEnvelope, createPool, handleCommand, runKitMigrations, runMigrations, validateManifest, type Envelope, type Pool } from '@routine/service-kit';
import pg from 'pg';
import pino from 'pino';
import { contractErrors } from '../../../contracts/validate.ts';
import { notificationHandlers } from '../src/inbox.ts';
import { NOTIFICATIONS_MANIFEST } from '../src/manifest.ts';

const logger = pino({ level: 'silent' });
const needsDatabase = process.env.TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL not set';

describe('notifications manifest', () => {
  it('validates, and every capability has a handler', () => {
    const result = validateManifest(NOTIFICATIONS_MANIFEST);
    assert.equal(result.valid, true, result.valid ? '' : result.errors.join('; '));
    assert.deepEqual(Object.keys(notificationHandlers(logger)), NOTIFICATIONS_MANIFEST.capabilities.map((capability) => capability.type));
  });
});

describe('notifications domain (04 §7)', { skip: needsDatabase }, () => {
  let admin: pg.Pool;
  let pool: Pool;
  let name: string;

  before(async () => {
    admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    name = `notifications_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.TEST_DATABASE_URL as string);
    url.pathname = `/${name}`;
    pool = createPool(url.toString());
    pool.on('error', () => undefined);
    await runMigrations(pool, join(import.meta.dirname, '..', 'migrations'), logger);
    await runKitMigrations(pool, ['outbox', 'processed_actions'], logger);
  });
  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin?.end();
  });

  it('delivers once per action, answers by contract, and emits notification.created in the same transaction', async () => {
    const envelope = createEnvelope({
      type: 'ActionRequested',
      version: 1,
      source: 'routine-service',
      data: { actionId: randomUUID(), executionId: randomUUID(), routineId: randomUUID(), ownerId: randomUUID(), actionKey: 'n', actionType: 'notification.send', params: { title: 'Good morning' }, context: { mode: 'live', depth: 0 } },
    });
    const run = () => handleCommand(pool, { handlers: notificationHandlers(logger), logger, service: 'notification-service' }, envelope);
    await run();
    await run();
    const { rows } = await pool.query('SELECT id FROM notifications WHERE source_key = $1', [`action:${envelope.data.actionId}`]);
    assert.equal(rows.length, 1, 'one effect');

    const outbox = (await pool.query<{ routing_key: string; payload: Envelope<Record<string, unknown>> }>('SELECT routing_key, payload FROM outbox ORDER BY id')).rows;
    const results = outbox.filter((row) => row.routing_key === 'action.completed');
    assert.equal(results.length, 2);
    assert.deepEqual(results[0].payload.data.output, results[1].payload.data.output);
    assert.deepEqual(contractErrors('action-completed.v1.schema.json', results[0].payload), []);

    const created = outbox.filter((row) => row.routing_key === 'notification.created');
    assert.equal(created.length, 1, 'one event for one notification');
    assert.equal(created[0].payload.type, 'NotificationCreated');
    assert.equal(created[0].payload.data.notificationId, rows[0].id);
    assert.equal(created[0].payload.data.routineId, envelope.data.routineId);
    assert.deepEqual(created[0].payload.data.origin, { executionId: envelope.data.executionId, routineId: envelope.data.routineId, actionId: envelope.data.actionId, depth: 1 }, 'caused by a routine step');
  });
});
