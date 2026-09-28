/** The domain kit (04 §6) with an in-memory fake broker and a real database for processed_actions and the outbox. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import pino from 'pino';
import { contractErrors } from '../../../contracts/validate.ts';
import type { ConsumeOptions, MessageHandler } from '../src/broker.ts';
import type { Pool } from '../src/db.ts';
import { completeAwaiting, startDomain, type CapabilityHandler, type DomainBroker, type DomainHandle } from '../src/domain.ts';
import { createEnvelope, type Envelope } from '../src/envelope.ts';
import { PermanentError, TransientError } from '../src/errors.ts';
import { eventTypeName } from '../src/events.ts';
import type { CapabilitySpec, DomainManifest } from '../src/manifest.ts';
import { kitDatabase, needsDatabase } from './support/database.ts';

const logger = pino({ level: 'silent' });

const capability = (type: string, kind: CapabilitySpec['kind'] = 'action'): CapabilitySpec => ({
  type,
  kind,
  label: type,
  sentence: type,
  description: 'Fixture.',
  params: [],
  output: [],
  sideEffects: kind !== 'value',
  ...(kind === 'human' && { human: { awaits: 'task' as const } }),
  since: 1,
});

const manifest: DomainManifest = {
  contract: 1,
  domain: 'demo',
  manifestVersion: 1,
  service: 'demo-service',
  name: 'Demo',
  description: 'A fixture domain.',
  icon: 'bolt',
  tint: 'teal',
  order: 50,
  optional: true,
  prefixes: ['demo'],
  capabilities: [capability('demo.act'), capability('demo.read', 'value'), capability('demo.await', 'human'), capability('demo.flaky'), capability('demo.broken')],
};

/** A broker in memory: records declarations and publishes, delivers on demand like Broker.consume. */
function fakeBroker() {
  const published: Array<{ exchange: string; routingKey: string; envelope: Envelope<Record<string, unknown>> }> = [];
  const declared: string[] = [];
  const channel = {
    assertQueue: async (queue: string) => void declared.push(`queue ${queue}`),
    bindQueue: async (queue: string, exchange: string, key: string) => void declared.push(`bind ${queue} ${exchange} ${key}`),
  };
  let consumer: { options: ConsumeOptions; handler: MessageHandler } | undefined;
  const broker: DomainBroker = {
    publish: async (exchange, routingKey, envelope) => void published.push({ exchange, routingKey, envelope: envelope as Envelope<Record<string, unknown>> }),
    consume: (options, handler) => {
      consumer = { options, handler };
    },
    declare: (_name, setup) => void setup(channel as never),
  };
  return {
    broker,
    published,
    declared,
    /** A (re)connect: the consumer channel's setup runs again. */
    connect: async () => consumer?.options.declare?.(channel as never),
    /** One delivery, with Broker's failure handling: a permanent error gives up, anything else is retried. */
    async deliver(envelope: Envelope) {
      if (!consumer) throw new Error('not consuming');
      try {
        await consumer.handler(envelope, { attempt: 1, redelivered: false, routingKey: 'x' });
      } catch (caught) {
        const error = caught as Error;
        if (error instanceof PermanentError) await consumer.options.onGiveUp?.(envelope, { attempt: 1, error, permanent: true });
        else await consumer.options.onRetry?.(envelope, { attempt: 1, delayMs: 1_000, error });
      }
    },
  };
}

const command = (actionType: string, extra: Record<string, unknown> = {}) =>
  createEnvelope({
    type: 'ActionRequested',
    version: 1,
    source: 'routine-service',
    data: { actionId: randomUUID(), executionId: randomUUID(), routineId: randomUUID(), ownerId: randomUUID(), actionKey: 'a', actionType, params: {}, ...extra },
  });

describe('domain kit', { skip: needsDatabase }, () => {
  let db: { pool: Pool; close(): Promise<void> };
  let fake: ReturnType<typeof fakeBroker>;
  let domain: DomainHandle;
  const calls: Record<string, number> = {};
  const count = (type: string) => (calls[type] = (calls[type] ?? 0) + 1);

  const handlers: Record<string, CapabilityHandler> = {
    'demo.act': async (cmd, tools) => {
      count('demo.act');
      await tools.tx.query('SELECT 1');
      await tools.emit('demo.happened', { ownerId: cmd.ownerId, thing: 'x' });
      return { kind: 'completed', output: { n: calls['demo.act'] } };
    },
    'demo.read': async (cmd, tools) => {
      await tools.emit('demo.happened', { ownerId: cmd.ownerId });
      return { kind: 'completed', output: { mode: cmd.context.mode } };
    },
    'demo.await': async () => ({ kind: 'awaiting', awaiting: { kind: 'task', refId: 'task-1', title: 'Do it yourself' } }),
    'demo.flaky': async () => {
      throw new TransientError('provider down', { code: 'UNREACHABLE' });
    },
    'demo.broken': async () => {
      throw new PermanentError('param "x" is required', { code: 'INVALID_PARAMS' });
    },
  };

  /** Messages in the outbox, oldest first. */
  const outbox = async () =>
    (await db.pool.query<{ routing_key: string; payload: Envelope<Record<string, unknown>> }>('SELECT routing_key, payload FROM outbox ORDER BY id')).rows;
  const outboxFor = async (actionId: string) => (await outbox()).filter((row) => row.payload.data.actionId === actionId);

  before(async () => {
    db = await kitDatabase();
    fake = fakeBroker();
    domain = startDomain({
      manifest,
      broker: fake.broker,
      pool: db.pool,
      logger,
      handlers,
      cancel: { 'demo.await': async () => void count('cancel') },
      relay: false,
      heartbeatMs: 20,
    });
    await fake.connect();
  });
  after(async () => {
    await domain?.stop();
    await db?.close();
  });

  it('declares its queue, its DLQ and a binding per capability, then registers', async () => {
    assert.deepEqual(fake.declared.slice(0, 3), ['queue demo-service.actions.dlq', 'queue demo-service.actions', 'bind demo-service.actions routine.actions action.demo.act']);
    assert.equal(fake.declared.filter((line) => line.startsWith('bind')).length, manifest.capabilities.length);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const registered = fake.published.find((message) => message.routingKey === 'domain.registered');
    assert.ok(registered);
    assert.deepEqual(contractErrors('domain-registered.v1.schema.json', registered.envelope), []);
  });

  it('sends heartbeats', async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    const heartbeat = fake.published.find((message) => message.routingKey === 'domain.heartbeat');
    assert.ok(heartbeat);
    assert.deepEqual(contractErrors('domain-heartbeat.v1.schema.json', heartbeat.envelope), []);
  });

  it('runs a handler once per action; a duplicate delivery re-sends the same result, marked', async () => {
    const envelope = command('demo.act');
    const before = calls['demo.act'] ?? 0;
    await fake.deliver(envelope);
    await fake.deliver(envelope);
    assert.equal(calls['demo.act'], before + 1, 'the handler ran once');
    const results = (await outboxFor(String(envelope.data.actionId))).filter((row) => row.routing_key === 'action.completed');
    assert.equal(results.length, 2);
    assert.deepEqual(results[0].payload.data.output, results[1].payload.data.output);
    assert.equal(results[0].payload.data.duplicate, false);
    assert.equal(results[1].payload.data.duplicate, true);
    assert.deepEqual(contractErrors('action-completed.v1.schema.json', results[0].payload), []);
  });

  it('runs a handler once when two replicas get the same command at the same moment', async () => {
    const envelope = command('demo.act');
    const before = calls['demo.act'] ?? 0;
    await Promise.all([fake.deliver(envelope), fake.deliver(envelope)]);
    assert.equal(calls['demo.act'], before + 1);
    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM processed_actions WHERE action_id = $1', [envelope.data.actionId]);
    assert.equal(rows[0].n, 1);
  });

  it('emits domain events through the outbox with origin, one level deeper', async () => {
    const envelope = command('demo.act', { context: { mode: 'live', depth: 2 } });
    await fake.deliver(envelope);
    const event = (await outbox()).find((row) => row.routing_key === 'demo.happened' && (row.payload.data.origin as { actionId?: string })?.actionId === envelope.data.actionId);
    assert.ok(event);
    assert.equal(event.payload.type, 'DemoHappened');
    assert.deepEqual(event.payload.data.origin, { executionId: envelope.data.executionId, routineId: envelope.data.routineId, actionId: envelope.data.actionId, depth: 3 });
    assert.equal(eventTypeName('budget.incomeRecorded'), 'BudgetIncomeRecorded');
  });

  it('passes test mode to the handler and emits nothing then', async () => {
    const envelope = command('demo.read', { context: { mode: 'test' } });
    const events = (await outbox()).filter((row) => row.routing_key === 'demo.happened').length;
    await fake.deliver(envelope);
    const [result] = await outboxFor(String(envelope.data.actionId));
    assert.deepEqual(result.payload.data.output, { mode: 'test' });
    assert.equal((await outbox()).filter((row) => row.routing_key === 'demo.happened').length, events, 'no event in a test run');
  });

  it('answers an unknown type with NOT_AVAILABLE', async () => {
    const envelope = command('demo.nothing');
    await fake.deliver(envelope);
    const [failed] = await outboxFor(String(envelope.data.actionId));
    assert.equal(failed.routing_key, 'action.failed');
    assert.deepEqual((failed.payload.data.error as { code: string }).code, 'NOT_AVAILABLE');
    assert.deepEqual(contractErrors('action-failed.v1.schema.json', failed.payload), []);
  });

  it('reports retries and permanent failures with their error codes, and stores nothing for them', async () => {
    const flaky = command('demo.flaky');
    await fake.deliver(flaky);
    const retry = fake.published.find((message) => message.envelope.data.actionId === flaky.data.actionId);
    assert.ok(retry);
    assert.equal(retry.routingKey, 'action.retry-scheduled');
    assert.equal((retry.envelope.data.error as { code: string }).code, 'UNREACHABLE');
    assert.deepEqual(contractErrors('action-retry-scheduled.v1.schema.json', retry.envelope), []);

    const broken = command('demo.broken');
    await fake.deliver(broken);
    const failed = fake.published.find((message) => message.envelope.data.actionId === broken.data.actionId);
    assert.ok(failed);
    assert.equal(failed.routingKey, 'action.failed');
    assert.equal((failed.envelope.data.error as { code: string }).code, 'INVALID_PARAMS');
    assert.deepEqual(contractErrors('action-failed.v1.schema.json', failed.envelope), []);
    const { rows } = await db.pool.query('SELECT 1 FROM processed_actions WHERE action_id = ANY($1)', [[flaky.data.actionId, broken.data.actionId]]);
    assert.equal(rows.length, 0, 'a replay after the fix runs the handler again');
  });

  it('sends ActionAwaitingUser for a human step, completes it once, and runs cancel handlers', async () => {
    const envelope = command('demo.await');
    await fake.deliver(envelope);
    const [awaiting] = await outboxFor(String(envelope.data.actionId));
    assert.equal(awaiting.routing_key, 'action.awaiting-user');
    assert.deepEqual(contractErrors('action-awaiting-user.v1.schema.json', awaiting.payload), []);

    const actionId = String(envelope.data.actionId);
    assert.equal(await completeAwaiting(db.pool, 'demo-service', actionId, { completedAt: 'now' }), true);
    assert.equal(await completeAwaiting(db.pool, 'demo-service', actionId, { completedAt: 'again' }), false, 'only once');
    const completed = (await outboxFor(actionId)).filter((row) => row.routing_key === 'action.completed');
    assert.equal(completed.length, 1);
    assert.deepEqual(completed[0].payload.data.output, { completedAt: 'now' });

    await fake.deliver(createEnvelope({ type: 'ActionCancelRequested', version: 1, source: 'routine-service', data: { actionId, executionId: envelope.data.executionId, ownerId: envelope.data.ownerId, actionType: 'demo.await', reason: 'expired' } }));
    assert.equal(calls.cancel, 1);
  });

  it('registers again on a reconnect', async () => {
    const before = fake.published.filter((message) => message.routingKey === 'domain.registered').length;
    await fake.connect();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(fake.published.filter((message) => message.routingKey === 'domain.registered').length, before + 1);
  });
});
