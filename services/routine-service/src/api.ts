import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { conflict, HttpError, notFound, requireUser, withContext, withTransaction, type Pool } from '@routine/service-kit';
import { ACTION_TYPES } from './domain/action-catalog.ts';
import { DefinitionError, ROUTINE_COLORS, validateRoutine, type Appearance, type RoutineDefinition, type RoutineInput } from './domain/definition.ts';
import { nextRun } from './domain/schedule.ts';
import type { ExecutionEngine } from './engine.ts';
import {
  deleteRoutine,
  executionDto,
  executionStats,
  getExecution,
  getRoutine,
  getVersion,
  listVersions,
  versionDto,
  insertRoutine,
  listExecutionActions,
  listExecutions,
  listLog,
  getRoutineByWebhookToken,
  listRoutines,
  rotateWebhookToken,
  routineDto,
  setRoutineActive,
  updateAppearance,
  updateRoutine,
} from './store.ts';

// JSON schemas mirror contracts/openapi/routine-api.yaml
const actionSchema = {
  type: 'object',
  required: ['key', 'type'],
  additionalProperties: false,
  properties: {
    key: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,39}$' },
    type: { type: 'string', minLength: 1 },
    step: { type: 'integer', minimum: 1, maximum: 50 },
    params: { type: 'object' },
    runIf: {
      type: 'object',
      required: ['action', 'is'],
      additionalProperties: false,
      properties: { action: { type: 'string', minLength: 1 }, is: { type: 'boolean' } },
    },
    forEach: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const;

const triggerSchema = {
  type: 'object',
  required: ['type'],
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['manual', 'schedule', 'webhook'] },
    cron: { type: 'string', minLength: 1 },
    timezone: { type: 'string', minLength: 1 },
  },
  if: { properties: { type: { const: 'schedule' } } },
  // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then, not a thenable
  then: { required: ['type', 'cron'] },
} as const;

const appearanceProperties = {
  icon: { type: ['string', 'null'], pattern: '^[a-z][a-z0-9-]{0,39}$' },
  color: { anyOf: [{ type: 'string', enum: ROUTINE_COLORS }, { type: 'null' }] },
} as const;

const appearanceBodySchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: appearanceProperties,
} as const;

const routineBodySchema = {
  type: 'object',
  required: ['name', 'trigger', 'actions'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', maxLength: 2000 },
    trigger: triggerSchema,
    actions: { type: 'array', minItems: 1, maxItems: 20, items: actionSchema },
    ...appearanceProperties,
    alertAfterFailures: { type: ['integer', 'null'], minimum: 1, maximum: 10 },
    version: { type: 'integer', minimum: 1, description: 'Optimistic locking: expected current version' },
  },
} as const;

const routineParams = {
  type: 'object',
  required: ['routineId'],
  properties: { routineId: { type: 'string', format: 'uuid' } },
} as const;

const versionParams = {
  type: 'object',
  required: ['routineId', 'version'],
  properties: { routineId: { type: 'string', format: 'uuid' }, version: { type: 'integer', minimum: 1 } },
} as const;

const executionParams = {
  type: 'object',
  required: ['executionId'],
  properties: { executionId: { type: 'string', format: 'uuid' } },
} as const;

const executionQuery = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['PENDING', 'RUNNING', 'WAITING', 'COMPLETED', 'FAILED'] },
    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
  },
} as const;

const triggerHeaders = {
  type: 'object',
  properties: { 'idempotency-key': { type: 'string', maxLength: 200 } },
} as const;

const hookParams = {
  type: 'object',
  required: ['token'],
  properties: { token: { type: 'string', pattern: '^[A-Za-z0-9_-]{20,100}$' } },
} as const;

/** A webhook sends a JSON object (or nothing); anything else would not be addressable as {{trigger.body.x}}. */
const hookBody = { anyOf: [{ type: 'object' }, { type: 'null' }] } as const;

const WEBHOOK_BODY_LIMIT = 64 * 1024;

const statsQuery = {
  type: 'object',
  properties: { hours: { type: 'integer', minimum: 1, maximum: 720, default: 24 } },
} as const;

type RoutineBody = RoutineInput & { version?: number };

function validate(input: RoutineInput): RoutineDefinition {
  try {
    return validateRoutine(input);
  } catch (error) {
    if (error instanceof DefinitionError) throw new HttpError(422, 'invalid_routine', 'Routine definition is invalid', error.issues);
    throw error;
  }
}

function firstRun(definition: Pick<RoutineDefinition, 'trigger'>, active: boolean): Date | null {
  if (!active || definition.trigger.type !== 'schedule') return null;
  return nextRun(definition.trigger.cron, definition.trigger.timezone, new Date());
}

export function registerRoutes(app: FastifyInstance, deps: { pool: Pool; engine: ExecutionEngine }): void {
  const { pool, engine } = deps;

  app.get('/api/v1/action-types', async () => ({ items: ACTION_TYPES }));

  // ------------------------------------------------------------ routines

  app.get('/api/v1/routines', async (request) => {
    const user = requireUser(request);
    return { items: (await listRoutines(pool, user.id)).map(routineDto) };
  });

  app.post<{ Body: RoutineBody }>('/api/v1/routines', { schema: { body: routineBodySchema } }, async (request, reply) => {
    const user = requireUser(request);
    const definition = validate(request.body);
    const routine = await withTransaction(pool, (client) => insertRoutine(client, randomUUID(), user.id, definition, user.id));
    request.log.info({ routineId: routine.id, name: routine.name }, 'routine created');
    return reply.status(201).header('location', `/api/v1/routines/${routine.id}`).send(routineDto(routine));
  });

  app.get<{ Params: { routineId: string } }>('/api/v1/routines/:routineId', { schema: { params: routineParams } }, async (request) => {
    const user = requireUser(request);
    const routine = await getRoutine(pool, user.id, request.params.routineId);
    if (!routine) throw notFound('Routine');
    return routineDto(routine);
  });

  app.put<{ Params: { routineId: string }; Body: RoutineBody }>(
    '/api/v1/routines/:routineId',
    { schema: { params: routineParams, body: routineBodySchema } },
    async (request) => {
      const user = requireUser(request);
      const definition = validate(request.body);
      const updated = await withTransaction(pool, async (client) => {
        const routine = await getRoutine(client, user.id, request.params.routineId, true);
        if (!routine) throw notFound('Routine');
        if (request.body.version !== undefined && request.body.version !== routine.version) {
          throw conflict(`Routine was modified concurrently (expected version ${request.body.version}, current ${routine.version})`);
        }
        return updateRoutine(client, routine, definition, firstRun(definition, routine.active), { by: user.id });
      });
      return routineDto(updated);
    },
  );

  app.patch<{ Params: { routineId: string }; Body: Appearance }>(
    '/api/v1/routines/:routineId',
    { schema: { params: routineParams, body: appearanceBodySchema } },
    async (request) => {
      const user = requireUser(request);
      const updated = await withTransaction(pool, async (client) => {
        const routine = await getRoutine(client, user.id, request.params.routineId, true);
        if (!routine) throw notFound('Routine');
        return updateAppearance(client, routine.id, request.body, user.id);
      });
      return routineDto(updated);
    },
  );

  app.delete<{ Params: { routineId: string } }>(
    '/api/v1/routines/:routineId',
    { schema: { params: routineParams } },
    async (request, reply) => {
      const user = requireUser(request);
      if (!(await deleteRoutine(pool, user.id, request.params.routineId))) throw notFound('Routine');
      return reply.status(204).send();
    },
  );

  for (const [path, active] of [
    ['activate', true],
    ['deactivate', false],
  ] as const) {
    app.post<{ Params: { routineId: string } }>(
      `/api/v1/routines/:routineId/${path}`,
      { schema: { params: routineParams } },
      async (request) => {
        const user = requireUser(request);
        const updated = await withTransaction(pool, async (client) => {
          const routine = await getRoutine(client, user.id, request.params.routineId, true);
          if (!routine) throw notFound('Routine');
          return setRoutineActive(client, routine.id, active, firstRun(routine, active), user.id);
        });
        request.log.info({ routineId: updated.id, active }, active ? 'routine activated' : 'routine deactivated');
        return routineDto(updated);
      },
    );
  }

  app.post<{ Params: { routineId: string } }>(
    '/api/v1/routines/:routineId/webhook/rotate',
    { schema: { params: routineParams } },
    async (request) => {
      const user = requireUser(request);
      const updated = await withTransaction(pool, async (client) => {
        const routine = await getRoutine(client, user.id, request.params.routineId, true);
        if (!routine) throw notFound('Routine');
        if (routine.trigger.type !== 'webhook') throw conflict('Routine is not triggered by a webhook');
        return rotateWebhookToken(client, routine.id, user.id);
      });
      request.log.info({ routineId: updated.id }, 'webhook token rotated');
      return routineDto(updated);
    },
  );

  // ------------------------------------------------------------ versions (06-engine §7)

  app.get<{ Params: { routineId: string } }>('/api/v1/routines/:routineId/versions', { schema: { params: routineParams } }, async (request) => {
    const user = requireUser(request);
    const routine = await getRoutine(pool, user.id, request.params.routineId);
    if (!routine) throw notFound('Routine');
    // with definitions: the history page diffs neighbouring versions (≤ 30 steps each, so it stays small)
    return { items: (await listVersions(pool, routine.id)).map((version) => versionDto(version)) };
  });

  app.get<{ Params: { routineId: string; version: number } }>(
    '/api/v1/routines/:routineId/versions/:version',
    { schema: { params: versionParams } },
    async (request) => {
      const user = requireUser(request);
      const routine = await getRoutine(pool, user.id, request.params.routineId);
      if (!routine) throw notFound('Routine');
      const version = await getVersion(pool, routine.id, request.params.version);
      if (!version) throw notFound('Version');
      return versionDto(version);
    },
  );

  // Restore never rewrites history: the old definition becomes the next version.
  app.post<{ Params: { routineId: string; version: number } }>(
    '/api/v1/routines/:routineId/versions/:version/restore',
    { schema: { params: versionParams } },
    async (request) => {
      const user = requireUser(request);
      const restored = await withTransaction(pool, async (client) => {
        const routine = await getRoutine(client, user.id, request.params.routineId, true);
        if (!routine) throw notFound('Routine');
        const version = await getVersion(client, routine.id, request.params.version);
        if (!version) throw notFound('Version');
        const { active: _active, ...old } = version.definition;
        const definition = validate(old);
        return updateRoutine(client, routine, definition, firstRun(definition, routine.active), { by: user.id, origin: 'restore' });
      });
      request.log.info({ routineId: restored.id, from: request.params.version, version: restored.version }, 'routine version restored');
      return routineDto(restored);
    },
  );

  // ------------------------------------------------------------ executions

  app.post<{ Params: { routineId: string }; Headers: { 'idempotency-key'?: string } }>(
    '/api/v1/routines/:routineId/executions',
    { schema: { params: routineParams, headers: triggerHeaders } },
    async (request, reply) => {
      const user = requireUser(request);
      const idempotencyKey = request.headers['idempotency-key'] || undefined;
      const result = await withTransaction(pool, async (client) => {
        // The row lock serialises concurrent triggers of this routine, retries included.
        const routine = await getRoutine(client, user.id, request.params.routineId, true);
        if (!routine) throw notFound('Routine');
        if (!routine.active) throw conflict('Routine is not active – activate it before triggering');
        return withContext({ routineId: routine.id }, () => engine.createExecution(client, routine, { type: 'manual', idempotencyKey }));
      });
      if (!result) throw conflict('Execution could not be created');
      return reply
        .status(result.created ? 202 : 200)
        .header('location', `/api/v1/executions/${result.execution.id}`)
        .send(executionDto(result.execution));
    },
  );

  // External systems start a routine here. No user token: the unguessable path segment is the
  // credential, and an unknown token and a non-webhook routine look the same (404). Senders that
  // retry (most webhook providers do) pass an Idempotency-Key and still start only one run.
  app.post<{ Params: { token: string }; Headers: { 'idempotency-key'?: string }; Body: Record<string, unknown> | null }>(
    '/api/v1/hooks/:token',
    { bodyLimit: WEBHOOK_BODY_LIMIT, schema: { params: hookParams, headers: triggerHeaders, body: hookBody } },
    async (request, reply) => {
      const idempotencyKey = request.headers['idempotency-key'] || undefined;
      const result = await withTransaction(pool, async (client) => {
        const routine = await getRoutineByWebhookToken(client, request.params.token);
        if (!routine) throw notFound('Webhook');
        if (!routine.active) throw conflict('Routine is not active');
        return withContext({ routineId: routine.id }, () =>
          engine.createExecution(client, routine, { type: 'webhook', idempotencyKey, payload: request.body ?? {} }),
        );
      });
      if (!result) throw conflict('Execution could not be created');
      // deliberately small: the caller is not the owner and learns nothing about the routine
      return reply.status(result.created ? 202 : 200).send({ executionId: result.execution.id, status: result.execution.status });
    },
  );

  app.get<{ Params: { routineId: string }; Querystring: { status?: string; limit: number } }>(
    '/api/v1/routines/:routineId/executions',
    { schema: { params: routineParams, querystring: executionQuery } },
    async (request) => {
      const user = requireUser(request);
      if (!(await getRoutine(pool, user.id, request.params.routineId))) throw notFound('Routine');
      const rows = await listExecutions(pool, user.id, { routineId: request.params.routineId, ...request.query });
      return { items: rows.map((row) => executionDto(row)) };
    },
  );

  app.get<{ Querystring: { status?: string; limit: number } }>(
    '/api/v1/executions',
    { schema: { querystring: executionQuery } },
    async (request) => {
      const user = requireUser(request);
      return { items: (await listExecutions(pool, user.id, request.query)).map((row) => executionDto(row)) };
    },
  );

  app.get<{ Querystring: { hours: number } }>('/api/v1/executions/stats', { schema: { querystring: statsQuery } }, async (request) => {
    const user = requireUser(request);
    const since = new Date(Date.now() - request.query.hours * 3_600_000);
    return { since, ...(await executionStats(pool, user.id, since)) };
  });

  app.get<{ Params: { executionId: string } }>(
    '/api/v1/executions/:executionId',
    { schema: { params: executionParams } },
    async (request) => {
      const user = requireUser(request);
      const execution = await getExecution(pool, user.id, request.params.executionId);
      if (!execution) throw notFound('Execution');
      const [actions, log] = await Promise.all([listExecutionActions(pool, execution.id), listLog(pool, execution.id)]);
      return executionDto(execution, actions, log);
    },
  );

  // "Retry from here": a failed run goes on from its failed step (06-engine §6)
  app.post<{ Params: { executionId: string } }>(
    '/api/v1/executions/:executionId/resume',
    { schema: { params: executionParams } },
    async (request) => {
      const user = requireUser(request);
      const outcome = await engine.resume(request.params.executionId, user.id, user.id);
      if (outcome === 'not_found') throw notFound('Execution');
      if (outcome === 'not_failed') throw conflict('Only a failed run can be resumed');
      const execution = await getExecution(pool, user.id, request.params.executionId);
      if (!execution) throw notFound('Execution');
      const [actions, log] = await Promise.all([listExecutionActions(pool, execution.id), listLog(pool, execution.id)]);
      return executionDto(execution, actions, log);
    },
  );
}
