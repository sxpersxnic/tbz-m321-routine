import proxy from '@fastify/http-proxy';
import {
  createHttpServer,
  createLogger,
  createTokenVerifier,
  env,
  envInt,
  envList,
  HttpError,
  installAdminOnly,
  installAuth,
  onShutdown,
} from '@routine/service-kit';
import { DeadLetterError, discardDeadLetters, listDeadLetters, replayDeadLetters, type Management } from './dead-letters.ts';

const SERVICE = 'gateway';
const logger = createLogger(SERVICE);

const upstreams = {
  routine: env('ROUTINE_URL', 'http://routine-service:3000'),
  task: env('TASK_URL', 'http://task-service:3000'),
  notification: env('NOTIFICATION_URL', 'http://notification-service:3000'),
  web: env('WEB_URL', 'http://web:80'),
};

/** Path prefix → upstream service. The gateway knows routes, not business logic. */
// Sign-in, registration and tokens are Keycloak's (/auth/…, routed by the edge) – not an API route.
const routes: Array<{ prefix: string; upstream: string }> = [
  { prefix: '/api/v1/routines', upstream: upstreams.routine },
  { prefix: '/api/v1/executions', upstream: upstreams.routine },
  { prefix: '/api/v1/action-types', upstream: upstreams.routine },
  { prefix: '/api/v1/catalog', upstream: upstreams.routine },
  // public: the secret token in the path is the credential, checked by the routine service
  { prefix: '/api/v1/hooks', upstream: upstreams.routine },
  { prefix: '/api/v1/tasks', upstream: upstreams.task },
  { prefix: '/api/v1/task-lists', upstream: upstreams.task },
  { prefix: '/api/v1/notifications', upstream: upstreams.notification },
];

/** Everything except webhook calls requires a valid token. */
const PUBLIC_PREFIXES = new Set(['/api/v1/hooks']);
const PROTECTED_PREFIXES = [
  ...routes.map((route) => route.prefix).filter((prefix) => !PUBLIC_PREFIXES.has(prefix)),
  '/api/v1/system',
];

const app = createHttpServer({ service: SERVICE, logger });

// Reject unauthenticated calls at the edge; services still verify the token themselves (defense in depth).
installAuth(app, createTokenVerifier(env('JWKS_URL')), PROTECTED_PREFIXES);
// System endpoints (DLQ, chaos, registry) are for admins. The status stays readable for every user:
// the Infrastructure page shows it read-only.
installAdminOnly(app, ['/api/v1/system'], ['/api/v1/system/status']);

// Upstreams run as several replicas behind one DNS name. A connection that breaks because a replica
// went away is retried on a fresh connection – only for GET/HEAD/OPTIONS without a body, never for writes.
const RETRIES_ON_BROKEN_CONNECTION = 2;

for (const route of routes) {
  await app.register(proxy, {
    upstream: route.upstream,
    prefix: route.prefix,
    rewritePrefix: route.prefix,
    logLevel: 'warn', // one access-log line per request comes from the service-kit hook
    replyOptions: {
      // propagate the correlation id so all services log the same id for this request
      rewriteRequestHeaders: (request, headers) => ({ ...headers, 'x-correlation-id': request.id }),
      retriesCount: RETRIES_ON_BROKEN_CONNECTION,
    },
  });
}

// ---------------------------------------------------------------- system status (for the demo UI)

const rabbit = {
  // any cluster node answers for the whole cluster – ask the next one when a node is down
  urls: envList('RABBITMQ_MANAGEMENT_URL', ['http://rabbitmq-1:15672']),
  auth: `Basic ${Buffer.from(`${env('RABBITMQ_USER', 'routine')}:${env('RABBITMQ_PASSWORD', 'routine')}`).toString('base64')}`,
};

/** Service → health URL. Keycloak reports readiness on its management port. */
const probes: Record<string, string> = {
  gateway: 'http://127.0.0.1:3000/health',
  web: `${upstreams.web}/health`,
  keycloak: env('KEYCLOAK_HEALTH_URL', 'http://keycloak:9000/auth/health/ready'),
  'routine-service': `${upstreams.routine}/health`,
  'task-service': `${upstreams.task}/health`,
  'notification-service': `${upstreams.notification}/health`,
  'integration-worker': `${env('INTEGRATION_WORKER_URL', 'http://integration-worker:3000')}/health`,
  'mock-external': `${env('EXTERNAL_API_URL', 'http://mock-external:8090')}/health`,
};

async function probe(url: string): Promise<{ status: 'up' | 'down'; instance?: string }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return { status: 'down' };
    const body = (await response.json()) as { instance?: string };
    return { status: 'up', instance: body.instance };
  } catch {
    return { status: 'down' };
  }
}

interface RabbitQueue {
  name: string;
  messages?: number;
  messages_ready?: number;
  messages_unacknowledged?: number;
  consumers?: number;
  message_stats?: { deliver_get_details?: { rate?: number } };
}

interface RabbitNode {
  name: string;
  running: boolean;
}

/**
 * A request to the management API of the first cluster node that answers. Only connection failures
 * move on to the next node – an HTTP error is the cluster's answer (a POST must not run twice).
 */
async function rabbitRequest<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let lastError: unknown;
  for (const url of rabbit.urls) {
    let response: Response;
    try {
      response = await fetch(`${url}${path}`, {
        method,
        headers: { authorization: rabbit.auth, ...(body !== undefined && { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(method === 'GET' ? 1_500 : 5_000),
      });
    } catch (error) {
      lastError = error;
      continue;
    }
    if (response.ok) return (await response.json()) as T;
    throw new Error(`RabbitMQ management API answered HTTP ${response.status} for ${method} ${path}`);
  }
  throw lastError;
}

const rabbitGet = <T>(path: string) => rabbitRequest<T>('GET', path);
const management: Management = { get: rabbitGet, post: (path, body) => rabbitRequest('POST', path, body) };

app.get('/api/v1/system/status', async () => {
  const services = Object.fromEntries(
    await Promise.all(Object.entries(probes).map(async ([name, url]) => [name, await probe(url)] as const)),
  );
  let queues: Array<{ name: string; ready: number; unacked: number; consumers: number; rate: number }> | null = null;
  let brokerNodes: Array<{ name: string; running: boolean }> = [];
  try {
    const [rawQueues, rawNodes] = await Promise.all([
      rabbitGet<RabbitQueue[]>('/api/queues/%2F?columns=name,messages,messages_ready,messages_unacknowledged,consumers,message_stats.deliver_get_details.rate'),
      rabbitGet<RabbitNode[]>('/api/nodes?columns=name,running'),
    ]);
    queues = rawQueues
      .map((queue) => ({
        name: queue.name,
        ready: queue.messages_ready ?? 0,
        unacked: queue.messages_unacknowledged ?? 0,
        consumers: queue.consumers ?? 0,
        rate: queue.message_stats?.deliver_get_details?.rate ?? 0, // deliveries per second
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    brokerNodes = rawNodes.map((node) => ({ name: node.name, running: node.running })).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    queues = null; // no broker node reachable
  }
  return { services, broker: queues ? 'up' : 'down', brokerNodes, queues: queues ?? [] };
});

// ---------------------------------------------------------------- dead letters (admin, services/gateway.md)

/** Turns the module's refusals into problem responses; everything else stays a 500. */
async function deadLetterCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof DeadLetterError) throw new HttpError(error.status, error.status === 400 ? 'bad_request' : 'conflict', error.message, { moved: error.moved });
    throw error;
  }
}

app.get('/api/v1/system/dead-letters', async () => ({ items: await listDeadLetters(management) }));

app.post<{ Params: { queue: string } }>('/api/v1/system/dead-letters/:queue/replay', async (request) => {
  const result = await deadLetterCall(() => replayDeadLetters(management, request.params.queue));
  request.log.info({ queue: request.params.queue, moved: result.moved, admin: request.user?.id }, 'dead letters replayed');
  return result;
});

app.post<{ Params: { queue: string }; Body: { messageIds: string[] } }>(
  '/api/v1/system/dead-letters/:queue/discard',
  {
    schema: {
      body: {
        type: 'object',
        required: ['messageIds'],
        additionalProperties: false,
        properties: { messageIds: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 200 } } },
      },
    },
  },
  async (request) => {
    const result = await deadLetterCall(() => discardDeadLetters(management, request.params.queue, request.body.messageIds));
    request.log.info({ queue: request.params.queue, discarded: result.discarded, admin: request.user?.id }, 'dead letters discarded');
    return result;
  },
);

// ---------------------------------------------------------------- web UI
// Everything that is not an API route is served by the independent `web` service
// (single origin for the browser → no CORS, one entry point).

await app.register(proxy, {
  upstream: upstreams.web,
  prefix: '/',
  logLevel: 'warn',
  replyOptions: {
    rewriteRequestHeaders: (request, headers) => ({ ...headers, 'x-correlation-id': request.id }),
    retriesCount: RETRIES_ON_BROKEN_CONNECTION,
  },
});

await app.listen({ host: '0.0.0.0', port: envInt('PORT', 3000) });
logger.info({ upstreams }, 'gateway ready');

onShutdown(logger, () => app.close());
