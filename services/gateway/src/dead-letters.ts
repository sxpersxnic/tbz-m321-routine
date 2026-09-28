/**
 * Dead letters for the Infrastructure page (services/gateway.md, admin only): list the DLQs with a
 * peek at their messages, replay them into their work queue, or discard chosen ones. A port of
 * scripts/replay-dlq.sh: one message at a time, peek → publish a copy → remove the original, and
 * stop when the DLQ changed in between. A crash leaves a duplicate (the consumers are idempotent),
 * never a lost message.
 */

/** The bits of the RabbitMQ management HTTP API this module uses. */
export interface Management {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

/** A message as the management API's `get` returns it (base64 payload). */
export interface RawMessage {
  routing_key: string;
  payload: string;
  payload_encoding: 'base64' | 'string';
  properties: { message_id?: string; headers?: Record<string, unknown>; [key: string]: unknown };
}

export interface DeadLetter {
  messageId: string | null;
  type: string | null;
  error: string | null;
  failedAt: string | null;
  attempts: number | null;
  routingKey: string;
  /** The message body (usually the JSON envelope). */
  body: unknown;
}

export interface DeadLetterQueue {
  queue: string;
  workQueue: string;
  count: number;
  sample: DeadLetter[];
}

export class DeadLetterError extends Error {
  status: number;
  moved: number;

  constructor(status: number, message: string, moved = 0) {
    super(message);
    this.name = 'DeadLetterError';
    this.status = status;
    this.moved = moved;
  }
}

const VHOST = '%2F';
const SAMPLE_SIZE = 20;
/** Headers the consumers add when they give up – a replayed message starts afresh. */
const FAILURE_HEADERS = ['x-error', 'x-attempts', 'x-failed-at', 'x-attempt'];
const QUEUE_NAME = /^[a-z0-9][a-z0-9.-]*\.dlq$/;

export function assertDeadLetterQueue(queue: string): void {
  if (!QUEUE_NAME.test(queue)) throw new DeadLetterError(400, `"${queue}" is not a dead letter queue`);
}

function decode(message: RawMessage): unknown {
  const text = message.payload_encoding === 'base64' ? Buffer.from(message.payload, 'base64').toString('utf8') : message.payload;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function deadLetter(message: RawMessage): DeadLetter {
  const body = decode(message);
  const headers = message.properties.headers ?? {};
  const header = (name: string) => (typeof headers[name] === 'string' || typeof headers[name] === 'number' ? String(headers[name]) : null);
  const attempts = header('x-attempts');
  return {
    messageId: message.properties.message_id ?? (body && typeof body === 'object' && 'messageId' in body ? String((body as { messageId: unknown }).messageId) : null),
    type: body && typeof body === 'object' && 'type' in body ? String((body as { type: unknown }).type) : null,
    error: header('x-error'),
    failedAt: header('x-failed-at'),
    attempts: attempts === null ? null : Number(attempts),
    routingKey: message.routing_key,
    body,
  };
}

const idOf = (message: RawMessage | undefined) => message?.properties.message_id ?? message?.payload;

async function getOne(api: Management, queue: string, ackmode: 'reject_requeue_true' | 'ack_requeue_false'): Promise<RawMessage | undefined> {
  const messages = await api.post<RawMessage[]>(`/api/queues/${VHOST}/${encodeURIComponent(queue)}/get`, { count: 1, ackmode, encoding: 'base64' });
  return messages[0];
}

/** Publishes a copy through the default exchange (routing key = queue). Returns whether a queue took it. */
async function publish(api: Management, queue: string, message: RawMessage, stripFailure: boolean): Promise<boolean> {
  const headers = { ...(message.properties.headers ?? {}) };
  if (stripFailure) for (const name of FAILURE_HEADERS) delete headers[name];
  const { routed } = await api.post<{ routed: boolean }>(`/api/exchanges/${VHOST}/amq.default/publish`, {
    properties: { ...message.properties, headers },
    routing_key: queue,
    payload: message.payload,
    payload_encoding: message.payload_encoding,
  });
  return routed;
}

async function depth(api: Management, queue: string): Promise<number> {
  const info = await api.get<{ messages?: number }>(`/api/queues/${VHOST}/${encodeURIComponent(queue)}`);
  return info.messages ?? 0;
}

/**
 * Removes the head of `queue`, which must be `expected` – otherwise someone else changed the queue:
 * the removed message goes back (to the tail) and the caller stops.
 */
async function removeHead(api: Management, queue: string, expected: RawMessage, done: number): Promise<void> {
  const removed = await getOne(api, queue, 'ack_requeue_false');
  if (idOf(removed) === idOf(expected)) return;
  if (removed) await publish(api, queue, removed, false);
  throw new DeadLetterError(409, `${queue} was changed concurrently – ${done} message(s) handled`, done);
}

/** Every DLQ with its depth and (for non-empty ones) a peek at up to 20 messages. */
export async function listDeadLetters(api: Management): Promise<DeadLetterQueue[]> {
  const queues = await api.get<Array<{ name: string; messages?: number }>>(`/api/queues/${VHOST}?columns=name,messages`);
  const dlqs = queues.filter((queue) => queue.name.endsWith('.dlq')).sort((a, b) => a.name.localeCompare(b.name));
  return Promise.all(
    dlqs.map(async (queue) => {
      const count = queue.messages ?? 0;
      // a peek: requeued messages return to the head in their order
      const sample =
        count > 0
          ? (await api.post<RawMessage[]>(`/api/queues/${VHOST}/${encodeURIComponent(queue.name)}/get`, { count: SAMPLE_SIZE, ackmode: 'reject_requeue_true', encoding: 'base64' })).map(deadLetter)
          : [];
      return { queue: queue.name, workQueue: queue.name.slice(0, -'.dlq'.length), count, sample };
    }),
  );
}

/** Moves the messages present at the start from `<queue>` (a DLQ) back into its work queue. */
export async function replayDeadLetters(api: Management, queue: string): Promise<{ moved: number }> {
  assertDeadLetterQueue(queue);
  const workQueue = queue.slice(0, -'.dlq'.length);
  const total = await depth(api, queue);
  let moved = 0;
  // only the messages there at the start: a consumer that still fails can't cause an endless loop
  for (; moved < total; moved++) {
    const message = await getOne(api, queue, 'reject_requeue_true');
    if (!message) break;
    if (!(await publish(api, workQueue, message, true))) throw new DeadLetterError(409, `${workQueue} does not accept messages (not routed) – ${moved} moved`, moved);
    await removeHead(api, queue, message, moved);
  }
  return { moved };
}

/**
 * Removes the chosen messages from a DLQ. The management API only sees the head, so the queue is
 * walked once: a message to keep is copied to the tail before its original is removed, a chosen
 * one is just removed – the order stays, and nothing is lost if this stops half-way.
 */
export async function discardDeadLetters(api: Management, queue: string, messageIds: string[]): Promise<{ discarded: number }> {
  assertDeadLetterQueue(queue);
  const chosen = new Set(messageIds);
  const total = await depth(api, queue);
  let discarded = 0;
  // always the whole cycle: stopping early would leave the kept messages rotated out of order
  for (let seen = 0; seen < total; seen++) {
    const message = await getOne(api, queue, 'reject_requeue_true');
    if (!message) break;
    const id = deadLetter(message).messageId;
    if (!(id && chosen.has(id)) && !(await publish(api, queue, message, false))) {
      throw new DeadLetterError(409, `${queue} does not accept messages – ${discarded} discarded`, discarded);
    }
    try {
      await removeHead(api, queue, message, discarded);
    } catch (error) {
      if (error instanceof DeadLetterError) error.moved = discarded;
      throw error;
    }
    if (id && chosen.has(id)) discarded++;
  }
  return { discarded };
}
