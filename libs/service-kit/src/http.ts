import { randomUUID } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import { withContext } from './context.ts';
import { HttpError } from './errors.ts';
import { instanceId, type Logger } from './logger.ts';

export type ReadinessCheck = () => Promise<void> | void;

export interface HttpServerOptions {
  service: string;
  logger: Logger;
  /** Named dependency checks exposed via GET /ready (e.g. database, broker). */
  readiness?: Record<string, ReadinessCheck>;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first && first.length <= 128 ? first : undefined;
}

function problem(status: number, title: string, detail: string, extra: Record<string, unknown> = {}) {
  return { type: 'about:blank', title, status, detail, ...extra };
}

/**
 * Fastify instance with the conventions every service shares:
 * correlation-id propagation, problem+json errors, /health and /ready.
 */
export function createHttpServer(options: HttpServerOptions): FastifyInstance {
  const app: FastifyInstance = Fastify({
    loggerInstance: options.logger as FastifyBaseLogger,
    // request logging is done by the onResponse hook below (one concise line per request)
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: (req) => headerValue(req.headers['x-correlation-id']) ?? randomUUID(),
    ajv: { customOptions: { allErrors: true, coerceTypes: 'array', removeAdditional: false } },
  });

  // Run the complete request lifecycle inside a log context carrying the correlation id.
  app.addHook('onRequest', (request, reply, done) => {
    reply.header('x-correlation-id', request.id);
    const traceId = trace.getActiveSpan()?.spanContext().traceId;
    if (traceId) reply.header('x-trace-id', traceId); // → http://localhost:16686/trace/<id>
    withContext({ correlationId: request.id }, done);
  });

  app.addHook('onResponse', (request, reply, done) => {
    const path = request.url.split('?')[0];
    if (path === '/health' || path === '/ready') return done();
    const entry = {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    };
    if (request.method === 'GET') request.log.debug(entry, 'http request');
    else request.log.info(entry, 'http request');
    done();
  });

  app.setErrorHandler<FastifyError | HttpError>((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply
        .status(error.status)
        .type('application/problem+json')
        .send(problem(error.status, error.code, error.message, error.details ? { errors: error.details } : {}));
    }
    if (error.validation) {
      return reply
        .status(400)
        .type('application/problem+json')
        .send(problem(400, 'validation_failed', error.message, { errors: error.validation }));
    }
    const status = error.statusCode ?? 500;
    if (status < 500) {
      return reply.status(status).type('application/problem+json').send(problem(status, error.code ?? 'error', error.message));
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply
      .status(500)
      .type('application/problem+json')
      .send(problem(500, 'internal_error', 'An unexpected error occurred'));
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .status(404)
      .type('application/problem+json')
      .send(problem(404, 'not_found', `Route ${request.method} ${request.url} not found`));
  });

  app.get('/health', async () => ({ status: 'ok', service: options.service, instance: instanceId }));

  app.get('/ready', async (_request, reply) => {
    const results: Record<string, string> = {};
    let ready = true;
    for (const [name, check] of Object.entries(options.readiness ?? {})) {
      try {
        await check();
        results[name] = 'ok';
      } catch (error) {
        ready = false;
        results[name] = error instanceof Error ? error.message : 'failed';
      }
    }
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks: results });
  });

  return app;
}
