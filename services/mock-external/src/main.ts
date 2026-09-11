/**
 * A fake "external world". Not part of the Routine platform itself – it only
 * simulates third-party services with latency, failures and idempotency keys.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyRequest } from 'fastify';
import { createHttpServer, createLogger, envInt, onShutdown } from '@routine/service-kit';

const logger = createLogger('mock-external');
const latency = { min: envInt('LATENCY_MIN_MS', 200), max: envInt('LATENCY_MAX_MS', 800) };
const app = createHttpServer({ service: 'mock-external', logger });

const CONDITIONS = ['sonnig', 'leicht bewölkt', 'bewölkt', 'Regenschauer', 'Gewitter', 'Nebel'];

function hash(text: string): number {
  let value = 0;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  return value;
}

const randomLatency = () => sleep(latency.min + Math.random() * (latency.max - latency.min));
const idempotencyKey = (request: FastifyRequest) => String(request.headers['idempotency-key'] ?? 'anonymous');

app.get<{ Querystring: { city?: string } }>('/weather', async (request) => {
  await randomLatency();
  const city = request.query.city ?? 'Zürich';
  const seed = hash(`${city.toLowerCase()}-${new Date().toISOString().slice(0, 13)}`);
  return { city, temperatureC: 8 + (seed % 20), condition: CONDITIONS[seed % CONDITIONS.length], observedAt: new Date().toISOString() };
});

// ---- webhooks: idempotent receiver (same Idempotency-Key → same response, no second effect)
const webhooks = new Map<string, Array<{ id: number; receivedAt: string; idempotencyKey: string; body: unknown }>>();
const responses = new Map<string, { id: number; receivedAt: string }>();
let nextId = 1;

app.post<{ Params: { name: string } }>('/webhooks/:name', async (request, reply) => {
  await randomLatency();
  const key = `${request.params.name}:${idempotencyKey(request)}`;
  const previous = responses.get(key);
  if (previous) {
    request.log.info({ key }, 'webhook replay detected – returning stored response');
    return reply.header('idempotent-replay', 'true').send({ received: true, ...previous });
  }
  const entry = { id: nextId++, receivedAt: new Date().toISOString(), idempotencyKey: idempotencyKey(request), body: request.body };
  webhooks.set(request.params.name, [...(webhooks.get(request.params.name) ?? []), entry]);
  responses.set(key, { id: entry.id, receivedAt: entry.receivedAt });
  request.log.info({ webhook: request.params.name, id: entry.id }, 'webhook received');
  return { received: true, id: entry.id, receivedAt: entry.receivedAt };
});

app.get<{ Params: { name: string } }>('/webhooks/:name', async (request) => ({ items: webhooks.get(request.params.name) ?? [] }));

// ---- flaky: fails the first N attempts per Idempotency-Key with 503, then succeeds
const attempts = new Map<string, number>();

app.route<{ Querystring: { failTimes?: string } }>({
  method: ['GET', 'POST'],
  url: '/flaky',
  handler: async (request, reply) => {
    await randomLatency();
    const failTimes = Number(request.query.failTimes ?? 2);
    const key = idempotencyKey(request);
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    if (attempt <= failTimes) {
      request.log.warn({ key, attempt, failTimes }, 'flaky endpoint: simulated outage');
      return reply.status(503).send({ error: 'temporarily unavailable', attempt });
    }
    return { ok: true, attempt, message: `succeeded after ${attempt} attempt(s)` };
  },
});

// ---- status: always answers with the given HTTP status (e.g. 404 → permanent failure)
app.route<{ Params: { code: string } }>({
  method: ['GET', 'POST'],
  url: '/status/:code',
  handler: async (request, reply) => reply.status(Number(request.params.code) || 500).send({ status: Number(request.params.code) }),
});

await app.listen({ host: '0.0.0.0', port: envInt('PORT', 8090) });
logger.info('mock-external ready');
onShutdown(logger, () => app.close());
