/**
 * The domain kit (docs/v2/04-domain-platform.md §6): what makes a service a domain. It declares the
 * domain's queue and bindings, registers its manifest (on start and every reconnect) and sends
 * heartbeats, and runs its capability handlers exactly once per action: idempotency via
 * `processed_actions`, the handler's writes, the stored result and the outgoing result message in
 * one transaction (the result through the outbox).
 */
import type { ConfirmChannel } from 'amqplib';
import type { ConsumeOptions, MessageHandler, TopologySetup } from './broker.ts';
import { withContext } from './context.ts';
import { type Pool, type PoolClient, type Queryable, withTransaction } from './db.ts';
import { createEnvelope, type Envelope } from './envelope.ts';
import { errorCodeOf, PermanentError } from './errors.ts';
import { emitEvent, type EventOrigin } from './events.ts';
import type { Logger } from './logger.ts';
import { instanceId } from './logger.ts';
import { manifestDigest, type DomainManifest } from './manifest.ts';
import { enqueue, OutboxRelay } from './outbox.ts';
import { removeCard, upsertCard, type TodayCard } from './today.ts';
import type { Loop } from './lifecycle.ts';

export const ACTIONS_EXCHANGE = 'routine.actions';
export const RESULTS_EXCHANGE = 'routine.action-results';
export const REGISTRY_EXCHANGE = 'platform.registry';

/** What the kit needs from the broker – the real `Broker` fits; tests pass an in-memory fake. */
export interface DomainBroker {
  publish(exchange: string, routingKey: string, envelope: Envelope<unknown>): Promise<void>;
  consume(options: ConsumeOptions, handler: MessageHandler): void;
  declare(name: string, setup: TopologySetup): void;
}

/** An ActionRequested as a handler sees it (04 §3.1). */
export interface DomainCommand {
  actionId: string;
  executionId: string;
  routineId: string | null;
  ownerId: string;
  actionKey: string;
  actionType: string;
  params: Record<string, unknown>;
  context: {
    /** `test`: a "Try this step" run – change nothing, emit nothing (04 §3.4). */
    mode: 'live' | 'test';
    timezone?: string;
    currency?: string;
    routineName?: string;
    stepIndex?: number;
    stepCount?: number;
    depth: number;
    areaId?: string | null;
  };
}

/** A human step's item, waiting for a person (sent as ActionAwaitingUser, M3). */
export interface Awaiting {
  kind: 'task' | 'question' | 'checkIn';
  refId: string;
  title: string;
  dueAt?: string;
}

export type HandlerResult = { kind: 'completed'; output: Record<string, unknown> } | { kind: 'awaiting'; awaiting: Awaiting };

export interface HandlerTools {
  tx: PoolClient;
  /** A domain event of this change, with `origin` set – nothing in test mode. */
  emit(type: string, data: { ownerId: string; areaId?: string | null } & Record<string, unknown>): Promise<void>;
  /** Today cards – nothing in test mode. */
  card: { upsert(card: TodayCard): Promise<void>; remove(ownerId: string, cardId: string, version: number): Promise<void> };
}

export type CapabilityHandler = (command: DomainCommand, tools: HandlerTools) => Promise<HandlerResult>;

export interface DomainOptions {
  manifest: DomainManifest;
  broker: DomainBroker;
  pool: Pool;
  logger: Logger;
  /** Work queue (default `<service>.actions`; a v1 service passes its existing one). */
  queue?: string;
  retryDelaysMs?: number[];
  prefetch?: number;
  chaosFailureRate?: number;
  handlers?: Record<string, CapabilityHandler>;
  /** Human capabilities: close the item when its step expires or the run is cancelled (M3). */
  cancel?: Record<string, (command: DomainCommand & { reason: string }, tools: HandlerTools) => Promise<void>>;
  /**
   * false: declare topology, register and heartbeat, but don't consume – the service consumes its
   * queue itself (integration-worker: external calls can't run inside a database transaction).
   */
  dispatch?: boolean;
  /** false when the service runs its own outbox relay. */
  relay?: boolean;
  heartbeatMs?: number;
}

export interface DomainHandle {
  /** Publishes DomainRegistered again (the kit does it on every connect). */
  register(): Promise<void>;
  stop(): Promise<void>;
}

const processedBy = (service: string) => `${service}@${instanceId}`;

function results(service: string) {
  const envelope = (type: string, data: Record<string, unknown>, correlationId?: string) =>
    createEnvelope({ type, version: 1, source: service, ...(correlationId && { correlationId }), data });
  return {
    completed: (command: Pick<DomainCommand, 'actionId' | 'executionId' | 'actionType'>, output: Record<string, unknown>, duplicate = false) => ({
      routingKey: 'action.completed',
      type: 'ActionCompleted',
      data: { actionId: command.actionId, executionId: command.executionId, actionType: command.actionType, output, processedBy: processedBy(service), completedAt: new Date().toISOString(), duplicate },
    }),
    awaiting: (command: Pick<DomainCommand, 'actionId' | 'executionId' | 'actionType'>, awaiting: Awaiting) => ({
      routingKey: 'action.awaiting-user',
      type: 'ActionAwaitingUser',
      data: { actionId: command.actionId, executionId: command.executionId, actionType: command.actionType, awaiting, processedBy: processedBy(service) },
    }),
    envelope,
  };
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** ActionRequested / ActionCancelRequested → a command (tolerant reader; context defaults to live). */
export function parseCommand(envelope: Envelope): DomainCommand & { cancel?: { reason: string } } {
  if (envelope.type !== 'ActionRequested' && envelope.type !== 'ActionCancelRequested') throw new PermanentError(`unsupported message type ${envelope.type}`);
  const data = envelope.data;
  const actionId = text(data.actionId);
  const executionId = text(data.executionId);
  const ownerId = text(data.ownerId);
  const actionType = text(data.actionType);
  if (!actionId || !executionId || !ownerId || !actionType) throw new PermanentError(`${envelope.type} is missing ids`);
  const context = (data.context && typeof data.context === 'object' ? data.context : {}) as Partial<DomainCommand['context']>;
  return {
    actionId,
    executionId,
    ownerId,
    actionType,
    routineId: text(data.routineId) ?? null,
    actionKey: text(data.actionKey) ?? actionType,
    params: data.params && typeof data.params === 'object' ? (data.params as Record<string, unknown>) : {},
    context: { ...context, mode: context.mode === 'test' ? 'test' : 'live', depth: typeof context.depth === 'number' ? context.depth : 0 },
    ...(envelope.type === 'ActionCancelRequested' && { cancel: { reason: text(data.reason) ?? 'runCancelled' } }),
  };
}

/** The work queue, its DLQ and an exact binding per capability (04 §6.2). */
export function domainTopology(queue: string, manifest: DomainManifest): TopologySetup {
  return async (channel: ConfirmChannel) => {
    await channel.assertQueue(`${queue}.dlq`, { durable: true, arguments: { 'x-queue-type': 'quorum', 'x-delivery-limit': -1 } });
    await channel.assertQueue(queue, {
      durable: true,
      arguments: { 'x-queue-type': 'quorum', 'x-delivery-limit': 10, 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': `${queue}.dlq` },
    });
    for (const capability of manifest.capabilities) await channel.bindQueue(queue, ACTIONS_EXCHANGE, `action.${capability.type}`);
  };
}

function toolsFor(tx: PoolClient, service: string, command: DomainCommand): HandlerTools {
  const test = command.context.mode === 'test';
  const origin: EventOrigin | undefined = command.routineId
    ? { executionId: command.executionId, routineId: command.routineId, actionId: command.actionId, depth: command.context.depth + 1 }
    : undefined;
  return {
    tx,
    emit: async (type, data) => {
      if (!test) await emitEvent(tx, service, type, data, origin);
    },
    card: {
      upsert: async (card) => {
        if (!test) await upsertCard(tx, service, card);
      },
      remove: async (ownerId, cardId, version) => {
        if (!test) await removeCard(tx, service, ownerId, cardId, version);
      },
    },
  };
}

/** One ActionRequested, exactly once (04 §6.1 steps 2–4). Exported for tests. */
export async function handleCommand(pool: Pool, options: Pick<DomainOptions, 'handlers' | 'cancel' | 'logger'> & { service: string }, envelope: Envelope): Promise<void> {
  const command = parseCommand(envelope);
  const build = results(options.service);
  await withContext({ actionId: command.actionId, executionId: command.executionId }, () =>
    withTransaction(pool, async (tx) => {
      // two replicas holding the same (redelivered) command: the second waits and finds the result
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [command.actionId]);

      if (command.cancel) {
        const cancel = options.cancel?.[command.actionType];
        if (cancel) await cancel({ ...command, reason: command.cancel.reason }, toolsFor(tx, options.service, command));
        else options.logger.warn({ actionType: command.actionType }, 'cancel request for a capability without a cancel handler ignored');
        return;
      }

      const { rows } = await tx.query<{ result: { type: string; routingKey: string; data: Record<string, unknown> } }>('SELECT result FROM processed_actions WHERE action_id = $1', [command.actionId]);
      if (rows[0]) {
        // a duplicate: the same answer again, marked as such – the handler does not run twice
        const stored = rows[0].result;
        await enqueue(tx, { exchange: RESULTS_EXCHANGE, routingKey: stored.routingKey, envelope: build.envelope(stored.type, { ...stored.data, duplicate: true }, envelope.correlationId) });
        options.logger.info({ actionType: command.actionType }, 'duplicate command – result sent again');
        return;
      }

      const handler = options.handlers?.[command.actionType];
      if (!handler) {
        const failed = {
          actionId: command.actionId,
          executionId: command.executionId,
          actionType: command.actionType,
          error: { code: 'NOT_AVAILABLE', message: `${options.service} does not offer ${command.actionType}` },
          attempts: 1,
          processedBy: processedBy(options.service),
        };
        await enqueue(tx, { exchange: RESULTS_EXCHANGE, routingKey: 'action.failed', envelope: build.envelope('ActionFailed', failed, envelope.correlationId) });
        return;
      }

      const outcome = await handler(command, toolsFor(tx, options.service, command));
      const result = outcome.kind === 'completed' ? build.completed(command, outcome.output) : build.awaiting(command, outcome.awaiting);
      await tx.query('INSERT INTO processed_actions (action_id, result) VALUES ($1, $2)', [command.actionId, JSON.stringify(result)]);
      await enqueue(tx, { exchange: RESULTS_EXCHANGE, routingKey: result.routingKey, envelope: build.envelope(result.type, result.data, envelope.correlationId) });
    }),
  );
}

/**
 * Completes a human step (M3): the waiting result becomes ActionCompleted with `output`, once.
 * Call it in the transaction of the change that completed the item. False if the action isn't
 * waiting (unknown, or completed already).
 */
export async function completeAwaiting(tx: Queryable, service: string, actionId: string, output: Record<string, unknown>): Promise<boolean> {
  const { rows } = await tx.query<{ result: { type: string; data: { executionId: string; actionType: string } } }>('SELECT result FROM processed_actions WHERE action_id = $1 FOR UPDATE', [actionId]);
  const stored = rows[0]?.result;
  if (stored?.type !== 'ActionAwaitingUser') return false;
  const build = results(service);
  const completed = build.completed({ actionId, executionId: stored.data.executionId, actionType: stored.data.actionType }, output);
  await tx.query('UPDATE processed_actions SET result = $2 WHERE action_id = $1', [actionId, JSON.stringify(completed)]);
  await enqueue(tx, { exchange: RESULTS_EXCHANGE, routingKey: completed.routingKey, envelope: build.envelope(completed.type, completed.data) });
  return true;
}

/** Makes this service a domain: topology, registration, heartbeat, and (unless `dispatch: false`) its handlers. */
export function startDomain(options: DomainOptions): DomainHandle {
  const { manifest, broker, pool, logger } = options;
  const service = manifest.service;
  const queue = options.queue ?? `${service}.actions`;
  const digest = manifestDigest(manifest);
  const instance = processedBy(service);
  const build = results(service);

  const register = async () => {
    await broker.publish(REGISTRY_EXCHANGE, 'domain.registered', build.envelope('DomainRegistered', { manifest, digest, instance }));
    logger.info({ domain: manifest.domain, version: manifest.manifestVersion }, 'domain manifest registered');
  };
  // topology first, then the registration – a capability is never announced before it is bound
  const topology = domainTopology(queue, manifest);
  const declareAndRegister: TopologySetup = async (channel) => {
    await topology(channel);
    void register().catch((error: unknown) => logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'domain registration not sent – next reconnect retries'));
  };

  const failure = (envelope: Envelope, error: Error, extra: Record<string, unknown>, type: 'ActionFailed' | 'ActionRetryScheduled') => {
    const data = envelope.data;
    if (typeof data.actionId !== 'string' || typeof data.executionId !== 'string') return Promise.resolve();
    return broker.publish(
      RESULTS_EXCHANGE,
      type === 'ActionFailed' ? 'action.failed' : 'action.retry-scheduled',
      build.envelope(type, { actionId: data.actionId, executionId: data.executionId, actionType: data.actionType, error: { code: errorCodeOf(error), message: error.message }, processedBy: instance, ...extra }, envelope.correlationId),
    );
  };

  if (options.dispatch === false) broker.declare(queue, declareAndRegister);
  else {
    broker.consume(
      {
        queue,
        declare: declareAndRegister,
        prefetch: options.prefetch ?? 10,
        retryDelaysMs: options.retryDelaysMs ?? [1_000, 5_000, 15_000],
        chaosFailureRate: options.chaosFailureRate,
        onRetry: (envelope, { attempt, delayMs, error }) => failure(envelope, error, { attempt, nextAttemptInMs: delayMs }, 'ActionRetryScheduled'),
        onGiveUp: (envelope, { attempt, error }) => failure(envelope, error, { attempts: attempt }, 'ActionFailed'),
      },
      (envelope) => handleCommand(pool, { handlers: options.handlers, cancel: options.cancel, logger, service }, envelope),
    );
  }

  const heartbeat = setInterval(() => {
    broker
      .publish(REGISTRY_EXCHANGE, 'domain.heartbeat', build.envelope('DomainHeartbeat', { domain: manifest.domain, manifestVersion: manifest.manifestVersion, digest, instance }))
      .catch((error: unknown) => logger.debug({ err: error instanceof Error ? error.message : String(error) }, 'heartbeat not sent'));
  }, options.heartbeatMs ?? 30_000);
  heartbeat.unref();

  let relayLoop: Loop | undefined;
  if (options.relay !== false) relayLoop = new OutboxRelay(pool, broker, logger, { batchSize: 50, intervalMs: 200, duplicateRate: 0 }).start();

  return {
    register,
    async stop() {
      clearInterval(heartbeat);
      await relayLoop?.stop();
    },
  };
}
