import {
  captureTraceHeaders,
  errorMessage,
  runWithTraceHeaders,
  startLoop,
  withContext,
  withTransaction,
  type Broker,
  type Logger,
  type Loop,
  type Pool,
  type Queryable,
} from '@routine/service-kit';
import type { OutgoingMessage } from './messages.ts';

/**
 * Transactional outbox. `enqueue` must be called with the same transaction
 * client as the state change, so a message is stored if and only if the
 * state change is committed – no lost or phantom messages ("dual write").
 */
export async function enqueue(db: Queryable, message: OutgoingMessage): Promise<void> {
  await db.query(
    `INSERT INTO outbox (message_id, exchange, routing_key, payload, trace_headers, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      message.envelope.messageId,
      message.exchange,
      message.routingKey,
      JSON.stringify(message.envelope),
      JSON.stringify(captureTraceHeaders()),
      message.envelope.correlationId,
    ],
  );
}

interface OutboxRow {
  id: string;
  exchange: string;
  routing_key: string;
  payload: OutgoingMessage['envelope'];
  trace_headers: Record<string, string>;
  correlation_id: string;
}

export interface OutboxRelayOptions {
  batchSize: number;
  intervalMs: number;
  /** Chaos switch: probability of publishing a message twice (demonstrates idempotent consumers). */
  duplicateRate: number;
}

/**
 * Publishes pending outbox rows. `FOR UPDATE SKIP LOCKED` lets several replicas
 * relay concurrently without publishing the same row twice. If the broker is
 * down, rows simply stay pending and are published once it is back.
 */
export class OutboxRelay {
  #pool: Pool;
  #broker: Broker;
  #logger: Logger;
  #options: OutboxRelayOptions;

  constructor(pool: Pool, broker: Broker, logger: Logger, options: OutboxRelayOptions) {
    this.#pool = pool;
    this.#broker = broker;
    this.#logger = logger;
    this.#options = options;
  }

  start(): Loop {
    return startLoop('outbox-relay', this.#options.intervalMs, this.#logger, () => this.relayBatch());
  }

  /** Returns true when a full batch was published (more work is likely waiting). */
  async relayBatch(): Promise<boolean> {
    return withTransaction(this.#pool, async (client) => {
      const { rows } = await client.query<OutboxRow>(
        `SELECT id, exchange, routing_key, payload, trace_headers, correlation_id
           FROM outbox
          WHERE published_at IS NULL
          ORDER BY id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [this.#options.batchSize],
      );
      if (rows.length === 0) return false;

      const published: string[] = [];
      for (const row of rows) {
        try {
          await withContext({ correlationId: row.correlation_id }, () =>
            runWithTraceHeaders(row.trace_headers, async () => {
              await this.#broker.publish(row.exchange, row.routing_key, row.payload);
              this.#logger.debug({ routingKey: row.routing_key, messageType: row.payload.type }, 'outbox message published');
              if (this.#options.duplicateRate > 0 && Math.random() < this.#options.duplicateRate) {
                await this.#broker.publish(row.exchange, row.routing_key, row.payload);
                this.#logger.warn({ routingKey: row.routing_key, messageId: row.payload.messageId }, 'chaos: published message twice');
              }
            }),
          );
          published.push(row.id);
        } catch (error) {
          await client.query('UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1', [row.id, errorMessage(error)]);
          this.#logger.warn({ err: errorMessage(error), pending: rows.length - published.length }, 'outbox publish failed, will retry');
          break;
        }
      }
      if (published.length > 0) {
        await client.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])', [published]);
      }
      return published.length === rows.length && rows.length === this.#options.batchSize;
    });
  }

  async purgePublished(olderThanHours = 24): Promise<void> {
    await this.#pool.query(`DELETE FROM outbox WHERE published_at < now() - make_interval(hours => $1)`, [olderThanHours]);
  }
}
