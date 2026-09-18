import proxy from '@fastify/http-proxy';
import {
  createHttpServer,
  createLogger,
  createTokenVerifier,
  env,
  envInt,
  installAuth,
  onShutdown,
} from '@routine/service-kit';

const SERVICE = 'gateway';
const logger = createLogger(SERVICE);

const upstreams = {
  identity: env('IDENTITY_URL', 'http://identity-service:3000'),
  routine: env('ROUTINE_URL', 'http://routine-service:3000'),
  task: env('TASK_URL', 'http://task-service:3000'),
  notification: env('NOTIFICATION_URL', 'http://notification-service:3000'),
  web: env('WEB_URL', 'http://web:80'),
};

/** Path prefix → upstream service. The gateway knows routes, not business logic. */
const routes: Array<{ prefix: string; upstream: string }> = [
  { prefix: '/api/v1/auth', upstream: upstreams.identity },
  { prefix: '/api/v1/routines', upstream: upstreams.routine },
  { prefix: '/api/v1/executions', upstream: upstreams.routine },
  { prefix: '/api/v1/action-types', upstream: upstreams.routine },
  // public: the secret token in the path is the credential, checked by the routine service
  { prefix: '/api/v1/hooks', upstream: upstreams.routine },
  { prefix: '/api/v1/tasks', upstream: upstreams.task },
  { prefix: '/api/v1/task-lists', upstream: upstreams.task },
  { prefix: '/api/v1/notifications', upstream: upstreams.notification },
];

/** Everything except login/register and webhook calls requires a valid token. */
const PUBLIC_PREFIXES = new Set(['/api/v1/auth', '/api/v1/hooks']);
const PROTECTED_PREFIXES = [
  '/api/v1/auth/me',
  ...routes.map((route) => route.prefix).filter((prefix) => !PUBLIC_PREFIXES.has(prefix)),
  '/api/v1/system',
];

const app = createHttpServer({ service: SERVICE, logger });

// Reject unauthenticated calls at the edge; services still verify the token themselves (defense in depth).
installAuth(app, createTokenVerifier(env('JWKS_URL', `${upstreams.identity}/.well-known/jwks.json`)), PROTECTED_PREFIXES);

for (const route of routes) {
  await app.register(proxy, {
    upstream: route.upstream,
    prefix: route.prefix,
    rewritePrefix: route.prefix,
    logLevel: 'warn', // one access-log line per request comes from the service-kit hook
    replyOptions: {
      // propagate the correlation id so all services log the same id for this request
      rewriteRequestHeaders: (request, headers) => ({ ...headers, 'x-correlation-id': request.id }),
    },
  });
}

// ---------------------------------------------------------------- system status (for the demo UI)

const rabbit = {
  url: env('RABBITMQ_MANAGEMENT_URL', 'http://rabbitmq:15672'),
  auth: `Basic ${Buffer.from(`${env('RABBITMQ_USER', 'routine')}:${env('RABBITMQ_PASSWORD', 'routine')}`).toString('base64')}`,
};

const probes: Record<string, string> = {
  gateway: 'http://127.0.0.1:3000',
  web: upstreams.web,
  'identity-service': upstreams.identity,
  'routine-service': upstreams.routine,
  'task-service': upstreams.task,
  'notification-service': upstreams.notification,
  'integration-worker': env('INTEGRATION_WORKER_URL', 'http://integration-worker:3000'),
  'mock-external': env('EXTERNAL_API_URL', 'http://mock-external:8090'),
};

async function probe(url: string): Promise<{ status: 'up' | 'down'; instance?: string }> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) });
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
}

app.get('/api/v1/system/status', async () => {
  const services = Object.fromEntries(
    await Promise.all(Object.entries(probes).map(async ([name, url]) => [name, await probe(url)] as const)),
  );
  let queues: Array<{ name: string; ready: number; unacked: number; consumers: number }> | null = null;
  try {
    const response = await fetch(`${rabbit.url}/api/queues/%2F?columns=name,messages,messages_ready,messages_unacknowledged,consumers`, {
      headers: { authorization: rabbit.auth },
      signal: AbortSignal.timeout(1_500),
    });
    if (response.ok) {
      queues = ((await response.json()) as RabbitQueue[])
        .map((queue) => ({
          name: queue.name,
          ready: queue.messages_ready ?? 0,
          unacked: queue.messages_unacknowledged ?? 0,
          consumers: queue.consumers ?? 0,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
  } catch {
    queues = null; // broker unreachable
  }
  return { services, broker: queues ? 'up' : 'down', queues: queues ?? [] };
});

// ---------------------------------------------------------------- web UI
// Everything that is not an API route is served by the independent `web` service
// (single origin for the browser → no CORS, one entry point).

await app.register(proxy, {
  upstream: upstreams.web,
  prefix: '/',
  logLevel: 'warn',
  replyOptions: { rewriteRequestHeaders: (request, headers) => ({ ...headers, 'x-correlation-id': request.id }) },
});

await app.listen({ host: '0.0.0.0', port: envInt('PORT', 3000) });
logger.info({ upstreams }, 'gateway ready');

onShutdown(logger, () => app.close());
