import amqp, { type AmqpConnectionManager, type ChannelWrapper } from 'amqp-connection-manager';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { withContext } from './context.ts';
import { parseEnvelope, type Envelope } from './envelope.ts';
import { errorMessage, PermanentError, TransientError } from './errors.ts';
import type { Logger } from './logger.ts';

export interface MessageContext {
  /** 1 for the first delivery attempt, incremented for every retry. */
  attempt: number;
  redelivered: boolean;
  routingKey: string;
}

export type MessageHandler = (envelope: Envelope, context: MessageContext) => Promise<void>;

export interface RetryInfo {
  attempt: number;
  delayMs: number;
  error: Error;
}

export interface GiveUpInfo {
  attempt: number;
  error: Error;
  permanent: boolean;
}

export interface ConsumeOptions {
  /** Pre-declared durable queue (see infra/rabbitmq/definitions.json). */
  queue: string;
  prefetch?: number;
  /**
   * Backoff schedule. Every entry becomes a dedicated retry queue whose TTL
   * dead-letters the message back into the work queue once the delay is over.
   */
  retryDelaysMs?: number[];
  /** Probability (0..1) of simulating a transient failure – used for demos. */
  chaosFailureRate?: number;
  onRetry?: (envelope: Envelope, info: RetryInfo) => Promise<void>;
  onGiveUp?: (envelope: Envelope, info: GiveUpInfo) => Promise<void>;
}

const ATTEMPT_HEADER = 'x-attempt';

export function retryQueueName(queue: string, delayMs: number): string {
  return `${queue}.retry.${delayMs}ms`;
}

export function deadLetterQueueName(queue: string): string {
  return `${queue}.dlq`;
}

/**
 * Thin wrapper around a self-healing AMQP connection.
 *
 * Delivery semantics: at-least-once. A message is acknowledged only after the
 * handler finished *and* any follow-up publish (retry, DLQ, result event) was
 * confirmed by the broker. Consumers must therefore be idempotent.
 */
export class Broker {
  #connection: AmqpConnectionManager;
  #publisher: ChannelWrapper;
  #consumers: ChannelWrapper[] = [];
  #logger: Logger;

  constructor(url: string, logger: Logger) {
    this.#logger = logger;
    this.#connection = amqp.connect([url], { heartbeatIntervalInSeconds: 10, reconnectTimeInSeconds: 2 });
    this.#connection.on('connect', () => logger.info('connected to message broker'));
    this.#connection.on('disconnect', ({ err }) => logger.warn({ err: err?.message }, 'disconnected from message broker'));
    this.#connection.on('connectFailed', ({ err }) => logger.warn({ err: err?.message }, 'message broker not reachable, retrying'));
    this.#publisher = this.#connection.createChannel({ name: 'publisher', confirm: true, publishTimeout: 10_000 });
  }

  isConnected(): boolean {
    return this.#connection.isConnected();
  }

  async waitForConnect(): Promise<void> {
    await this.#publisher.waitForConnect();
  }

  /** Publishes a persistent message and resolves once the broker confirmed it. */
  async publish(exchange: string, routingKey: string, envelope: Envelope<unknown>): Promise<void> {
    await this.#publisher.publish(exchange, routingKey, Buffer.from(JSON.stringify(envelope)), {
      persistent: true,
      contentType: 'application/json',
      messageId: envelope.messageId,
      type: envelope.type,
      appId: envelope.source,
      timestamp: Math.floor(Date.now() / 1000),
      headers: { 'x-correlation-id': envelope.correlationId, 'x-message-version': envelope.version },
    });
  }

  /**
   * Starts consuming in the background. Does not wait for the broker, so a
   * service still starts (and serves HTTP) while RabbitMQ is unavailable;
   * the consumer attaches as soon as the connection is (re-)established.
   */
  consume(options: ConsumeOptions, handler: MessageHandler): void {
    const { queue, retryDelaysMs = [] } = options;
    const prefetch = options.prefetch ?? 10;
    const channel = this.#connection.createChannel({
      name: `consumer:${queue}`,
      confirm: true,
      setup: async (ch: ConfirmChannel) => {
        await ch.checkQueue(queue); // work queue + DLQ are infrastructure, declared by the broker
        for (const delayMs of retryDelaysMs) {
          await ch.assertQueue(retryQueueName(queue, delayMs), {
            durable: true,
            arguments: {
              'x-queue-type': 'classic',
              'x-message-ttl': delayMs,
              'x-dead-letter-exchange': '',
              'x-dead-letter-routing-key': queue,
            },
          });
        }
      },
    });
    channel.on('error', (error: Error) => this.#logger.error({ queue, err: error.message }, 'consumer channel error'));
    this.#consumers.push(channel);
    channel.consume(queue, (message) => void this.#dispatch(channel, message, options, handler), { prefetch }).then(
      () => this.#logger.info({ queue, prefetch, retryDelaysMs }, 'consuming'),
      (error: Error) => this.#logger.error({ queue, err: error.message }, 'could not start consumer'),
    );
  }

  async #dispatch(channel: ChannelWrapper, message: ConsumeMessage, options: ConsumeOptions, handler: MessageHandler) {
    const attempt = Number(message.properties.headers?.[ATTEMPT_HEADER] ?? 1);
    let envelope: Envelope;
    try {
      envelope = parseEnvelope(message.content);
    } catch (error) {
      this.#logger.error({ queue: options.queue, err: errorMessage(error) }, 'unparseable message moved to DLQ');
      await this.#settle(channel, message, () => this.#toDeadLetter(options.queue, message, attempt, error as Error));
      return;
    }

    await withContext(
      { correlationId: envelope.correlationId, messageId: envelope.messageId, messageType: envelope.type },
      async () => {
        const context: MessageContext = {
          attempt,
          redelivered: message.fields.redelivered,
          routingKey: message.fields.routingKey,
        };
        try {
          if (options.chaosFailureRate && Math.random() < options.chaosFailureRate) {
            throw new TransientError('chaos: simulated transient failure');
          }
          await handler(envelope, context);
          channel.ack(message);
        } catch (caught) {
          const error = caught instanceof Error ? caught : new Error(String(caught));
          await this.#settle(channel, message, () => this.#handleFailure(message, envelope, attempt, error, options));
        }
      },
    );
  }

  async #handleFailure(message: ConsumeMessage, envelope: Envelope, attempt: number, error: Error, options: ConsumeOptions) {
    const delays = options.retryDelaysMs ?? [];
    const permanent = error instanceof PermanentError;
    if (!permanent && attempt <= delays.length) {
      const delayMs = delays[attempt - 1];
      await this.#publisher.sendToQueue(retryQueueName(options.queue, delayMs), message.content, {
        persistent: true,
        contentType: 'application/json',
        messageId: message.properties.messageId,
        type: message.properties.type,
        headers: { ...message.properties.headers, [ATTEMPT_HEADER]: attempt + 1, 'x-last-error': error.message },
      });
      this.#logger.warn({ queue: options.queue, attempt, nextAttemptInMs: delayMs, err: error.message }, 'processing failed, retry scheduled');
      await options.onRetry?.(envelope, { attempt, delayMs, error });
      return;
    }
    await this.#toDeadLetter(options.queue, message, attempt, error);
    this.#logger.error({ queue: options.queue, attempt, permanent, err: error.message }, 'processing failed permanently, message moved to DLQ');
    await options.onGiveUp?.(envelope, { attempt, error, permanent });
  }

  async #toDeadLetter(queue: string, message: ConsumeMessage, attempt: number, error: Error) {
    await this.#publisher.sendToQueue(deadLetterQueueName(queue), message.content, {
      persistent: true,
      contentType: 'application/json',
      messageId: message.properties.messageId,
      type: message.properties.type,
      headers: {
        ...message.properties.headers,
        'x-error': error.message,
        'x-attempts': attempt,
        'x-failed-at': new Date().toISOString(),
        'x-original-routing-key': message.fields.routingKey,
      },
    });
  }

  /** Acks only after the follow-up action succeeded; otherwise requeues so nothing is lost. */
  async #settle(channel: ChannelWrapper, message: ConsumeMessage, followUp: () => Promise<void>) {
    try {
      await followUp();
      channel.ack(message);
    } catch (error) {
      this.#logger.error({ err: errorMessage(error) }, 'could not settle message, requeueing');
      try {
        channel.nack(message, false, true);
      } catch {
        // channel already gone – the broker redelivers unacked messages automatically
      }
    }
  }

  async close(): Promise<void> {
    for (const consumer of this.#consumers) await consumer.cancelAll().catch(() => undefined);
    await this.#connection.close();
  }
}
