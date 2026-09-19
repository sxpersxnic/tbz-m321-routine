import { randomUUID } from 'node:crypto';
import { currentContext } from './context.ts';
import { PermanentError } from './errors.ts';

/**
 * Transport envelope shared by all messages (see contracts/schemas/envelope.schema.json).
 * Only metadata is standardised here – the `data` payload belongs to each
 * message contract and is interpreted by every service in its own model.
 */
export interface Envelope<T = Record<string, unknown>> {
  messageId: string;
  type: string;
  version: number;
  occurredAt: string;
  source: string;
  correlationId: string;
  causationId?: string;
  data: T;
}

export interface EnvelopeInput<T> {
  type: string;
  version: number;
  source: string;
  data: T;
  correlationId?: string;
  causationId?: string;
  messageId?: string;
}

export function createEnvelope<T>(input: EnvelopeInput<T>): Envelope<T> {
  const messageId = input.messageId ?? randomUUID();
  const envelope: Envelope<T> = {
    messageId,
    type: input.type,
    version: input.version,
    occurredAt: new Date().toISOString(),
    source: input.source,
    correlationId: input.correlationId ?? currentContext().correlationId ?? messageId,
    data: input.data,
  };
  if (input.causationId) envelope.causationId = input.causationId;
  return envelope;
}

export function parseEnvelope(content: Buffer): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString('utf8'));
  } catch {
    throw new PermanentError('message body is not valid JSON');
  }
  const candidate = parsed as Partial<Envelope>;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    typeof candidate.messageId !== 'string' ||
    typeof candidate.type !== 'string' ||
    typeof candidate.version !== 'number' ||
    typeof candidate.data !== 'object' ||
    candidate.data === null
  ) {
    throw new PermanentError('message does not match the envelope contract');
  }
  return {
    ...candidate,
    correlationId: candidate.correlationId ?? candidate.messageId,
  } as Envelope;
}
