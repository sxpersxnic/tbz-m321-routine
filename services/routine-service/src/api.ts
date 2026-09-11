import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { conflict, HttpError, notFound, requireUser, withContext, withTransaction, type Pool } from '@routine/service-kit';
import { ACTION_TYPES } from './domain/action-catalog.ts';
import { DefinitionError, validateRoutine, type RoutineDefinition, type RoutineInput } from './domain/definition.ts';
import { nextRun } from './domain/schedule.ts';
import type { ExecutionEngine } from './engine.ts';
import {
  deleteRoutine,
  executionDto,
  getExecution,
  getRoutine,
  insertRoutine,
  listExecutionActions,
  listExecutions,
  listLog,
  listRoutines,
  routineDto,
  setRoutineActive,
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
  },
} as const;

const triggerSchema = {
  type: 'object',
  required: ['type'],
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['manual', 'schedule'] },
    cron: { type: 'string', minLength: 1 },
    timezone: { type: 'string', minLength: 1 },
  },
  if: { properties: { type: { const: 'schedule' } } },
  then: { required: ['type', 'cron'] },
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
    version: { type: 'integer', minimum: 1, description: 'Optimistic locking: expected current version' },
  },
} as const;

const routineParams = {
  type: 'object',
  required: ['routineId'],
  properties: { routineId: { type: 'string', format: 'uuid' } },
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
    const routine = await insertRoutine(pool, randomUUID(), user.id, definition);
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
        return updateRoutine(client, routine, definition, firstRun(definition, routine.active));
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
          return setRoutineActive(client, routine.id, active, firstRun(routine, active));
        });
        request.log.info({ routineId: updated.id, active }, active ? 'routine activated' : 'routine deactivated');
        return routineDto(updated);
      },
    );
  }

  // ------------------------------------------------------------ executions

  app.post<{ Params: { routineId: string } }>(
    '/api/v1/routines/:routineId/executions',
    { schema: { params: routineParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const idempotencyKey = request.headers['idempotency-key'];
      const result = await withTransaction(pool, async (client) => {
        const routine = await getRoutine(client, user.id, request.params.routineId, true);
        if (!routine) throw notFound('Routine');
        if (!routine.active) throw conflict('Routine is not active – activate it before triggering');
        return withContext({ routineId: routine.id }, () =>
          engine.createExecution(client, routine, {
            type: 'manual',
            idempotencyKey: typeof idempotencyKey === 'string' && idempotencyKey ? idempotencyKey.slice(0, 200) : undefined,
          }),
        );
      });
      if (!result) throw conflict('Execution could not be created');
      return reply
        .status(result.created ? 202 : 200)
        .header('location', `/api/v1/executions/${result.execution.id}`)
        .send(executionDto(result.execution));
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
}
