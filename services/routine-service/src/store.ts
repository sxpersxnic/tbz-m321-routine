import type { Queryable } from '@routine/service-kit';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ActionDefinition, Appearance, RoutineDefinition, RunIf, TriggerDefinition, TriggerType } from './domain/definition.ts';
import type { ActionStatus, ExecutionStatus } from './domain/progress.ts';

// ---------------------------------------------------------------- rows

export interface RoutineRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  trigger: TriggerDefinition;
  actions: ActionDefinition[];
  active: boolean;
  next_run_at: Date | null;
  webhook_token: string | null;
  icon: string | null;
  color: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface ExecutionRow {
  id: string;
  routine_id: string;
  owner_id: string;
  routine_name: string;
  trigger_type: TriggerType;
  scheduled_for: Date | null;
  trigger_payload: Record<string, unknown> | null;
  status: ExecutionStatus;
  current_step: number;
  correlation_id: string;
  trace_id: string | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface ExecutionActionRow {
  id: string;
  execution_id: string;
  key: string;
  type: string;
  step: number;
  params: Record<string, unknown>;
  resolved_params: Record<string, unknown> | null;
  status: ActionStatus;
  attempts: number;
  output: Record<string, unknown> | null;
  error: string | null;
  processed_by: string | null;
  dispatched_at: Date | null;
  finished_at: Date | null;
  run_if: RunIf | null;
  for_each: string | null;
  /** Set on the rows a "repeat for each" step was expanded into. */
  parent_id: string | null;
  loop_item: unknown;
  loop_index: number | null;
}

export interface ExecutionLogRow {
  at: Date;
  kind: string;
  action_key: string | null;
  message: string;
}

// ---------------------------------------------------------------- routines

/** 32 random bytes – the token is the webhook's only credential. */
export const newWebhookToken = () => randomBytes(32).toString('base64url');

export const webhookPath = (token: string) => `/api/v1/hooks/${token}`;

/** A webhook routine needs a token; any other routine keeps whatever it had (so switching back keeps the URL). */
const tokenFor = (definition: RoutineDefinition) => (definition.trigger.type === 'webhook' ? newWebhookToken() : null);

export async function listRoutines(db: Queryable, ownerId: string): Promise<RoutineRow[]> {
  const { rows } = await db.query<RoutineRow>('SELECT * FROM routines WHERE owner_id = $1 ORDER BY created_at DESC', [ownerId]);
  return rows;
}

export async function getRoutine(db: Queryable, ownerId: string, id: string, forUpdate = false): Promise<RoutineRow | null> {
  const { rows } = await db.query<RoutineRow>(
    `SELECT * FROM routines WHERE id = $1 AND owner_id = $2 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [id, ownerId],
  );
  return rows[0] ?? null;
}

export async function insertRoutine(db: Queryable, id: string, ownerId: string, definition: RoutineDefinition): Promise<RoutineRow> {
  const { rows } = await db.query<RoutineRow>(
    `INSERT INTO routines (id, owner_id, name, description, trigger, actions, webhook_token, icon, color)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      id,
      ownerId,
      definition.name,
      definition.description,
      JSON.stringify(definition.trigger),
      JSON.stringify(definition.actions),
      tokenFor(definition),
      definition.icon ?? null,
      definition.color ?? null,
    ],
  );
  return rows[0];
}

export async function updateRoutine(
  db: Queryable,
  routine: RoutineRow,
  definition: RoutineDefinition,
  nextRunAt: Date | null,
): Promise<RoutineRow> {
  const { rows } = await db.query<RoutineRow>(
    `UPDATE routines
        SET name = $2, description = $3, trigger = $4, actions = $5, next_run_at = $6,
            webhook_token = COALESCE(webhook_token, $7),
            icon = CASE WHEN $8 THEN $9 ELSE icon END,
            color = CASE WHEN $10 THEN $11 ELSE color END,
            version = version + 1, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [
      routine.id,
      definition.name,
      definition.description,
      JSON.stringify(definition.trigger),
      JSON.stringify(definition.actions),
      nextRunAt,
      tokenFor(definition),
      definition.icon !== undefined,
      definition.icon ?? null,
      definition.color !== undefined,
      definition.color ?? null,
    ],
  );
  return rows[0];
}

/** Icon and colour only – the definition, schedule and webhook stay untouched. */
export async function updateAppearance(db: Queryable, id: string, appearance: Appearance): Promise<RoutineRow> {
  const { rows } = await db.query<RoutineRow>(
    `UPDATE routines
        SET icon = CASE WHEN $2 THEN $3 ELSE icon END,
            color = CASE WHEN $4 THEN $5 ELSE color END,
            version = version + 1, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, appearance.icon !== undefined, appearance.icon ?? null, appearance.color !== undefined, appearance.color ?? null],
  );
  return rows[0];
}

export async function setRoutineActive(db: Queryable, id: string, active: boolean, nextRunAt: Date | null): Promise<RoutineRow> {
  const { rows } = await db.query<RoutineRow>(
    'UPDATE routines SET active = $2, next_run_at = $3, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *',
    [id, active, nextRunAt],
  );
  return rows[0];
}

/** The routine behind a webhook URL – regardless of owner, the token is the credential. Locked for the trigger. */
export async function getRoutineByWebhookToken(db: Queryable, token: string): Promise<RoutineRow | null> {
  const { rows } = await db.query<RoutineRow>(
    `SELECT * FROM routines WHERE webhook_token = $1 AND trigger->>'type' = 'webhook' FOR UPDATE`,
    [token],
  );
  return rows[0] ?? null;
}

/** Invalidates the old URL at once – for a leaked link. */
export async function rotateWebhookToken(db: Queryable, id: string): Promise<RoutineRow> {
  const { rows } = await db.query<RoutineRow>(
    'UPDATE routines SET webhook_token = $2, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *',
    [id, newWebhookToken()],
  );
  return rows[0];
}

export async function deleteRoutine(db: Queryable, ownerId: string, id: string): Promise<boolean> {
  const result = await db.query('DELETE FROM routines WHERE id = $1 AND owner_id = $2', [id, ownerId]);
  return (result.rowCount ?? 0) > 0;
}

/** Locks due routines; SKIP LOCKED lets several scheduler replicas work side by side. */
export async function lockDueRoutines(db: Queryable, limit: number): Promise<RoutineRow[]> {
  const { rows } = await db.query<RoutineRow>(
    `SELECT * FROM routines
      WHERE active AND next_run_at IS NOT NULL AND next_run_at <= now()
      ORDER BY next_run_at
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  return rows;
}

export async function setNextRun(db: Queryable, id: string, nextRunAt: Date | null): Promise<void> {
  await db.query('UPDATE routines SET next_run_at = $2 WHERE id = $1', [id, nextRunAt]);
}

// ---------------------------------------------------------------- executions

export async function insertExecution(
  db: Queryable,
  execution: {
    id: string;
    routine: RoutineRow;
    trigger: TriggerType;
    scheduledFor: Date | null;
    idempotencyKey: string | null;
    payload: Record<string, unknown> | null;
    correlationId: string;
    traceId: string | null;
  },
): Promise<ExecutionRow | null> {
  const { rows } = await db.query<ExecutionRow>(
    `INSERT INTO executions (id, routine_id, owner_id, routine_name, trigger_type, scheduled_for, idempotency_key, status, correlation_id, trace_id, trigger_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9, $10)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      execution.id,
      execution.routine.id,
      execution.routine.owner_id,
      execution.routine.name,
      execution.trigger,
      execution.scheduledFor,
      execution.idempotencyKey,
      execution.correlationId,
      execution.traceId,
      execution.payload === null ? null : JSON.stringify(execution.payload),
    ],
  );
  return rows[0] ?? null;
}

export async function insertExecutionActions(
  db: Queryable,
  executionId: string,
  actions: Array<ActionDefinition & { id: string }>,
): Promise<void> {
  for (const [position, action] of actions.entries()) {
    await db.query(
      `INSERT INTO execution_actions (id, execution_id, key, type, step, position, params, status, run_if, for_each)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9)`,
      [
        action.id,
        executionId,
        action.key,
        action.type,
        action.step,
        position,
        JSON.stringify(action.params),
        action.runIf ? JSON.stringify(action.runIf) : null,
        action.forEach ?? null,
      ],
    );
  }
}

/**
 * The rows a "repeat for each" step expands into: same type, params and step as
 * the parent – so they run in parallel – each with its own item. Keys are
 * `<parent>[<index>]`, positions sort them right after the parent.
 */
export async function insertLoopActions(db: Queryable, parent: ExecutionActionRow, items: unknown[]): Promise<ExecutionActionRow[]> {
  const rows: ExecutionActionRow[] = [];
  for (const [index, item] of items.entries()) {
    const { rows: inserted } = await db.query<ExecutionActionRow>(
      `INSERT INTO execution_actions (id, execution_id, key, type, step, position, params, status, parent_id, loop_item, loop_index)
       SELECT $1, execution_id, $2, type, step, (position + 1) * 1000 + $3, params, 'PENDING', id, $4, $3
         FROM execution_actions WHERE id = $5
       RETURNING *`,
      [randomUUID(), `${parent.key}[${index}]`, index, JSON.stringify(item ?? null), parent.id],
    );
    rows.push(inserted[0]);
  }
  return rows;
}

export async function markActionSkipped(db: Queryable, id: string): Promise<void> {
  await db.query(`UPDATE execution_actions SET status = 'SKIPPED', finished_at = now(), updated_at = now() WHERE id = $1`, [id]);
}

export async function findExecutionByIdempotencyKey(db: Queryable, routineId: string, key: string): Promise<ExecutionRow | null> {
  const { rows } = await db.query<ExecutionRow>('SELECT * FROM executions WHERE routine_id = $1 AND idempotency_key = $2', [routineId, key]);
  return rows[0] ?? null;
}

/** Serialises all state changes of one execution (parallel results, several replicas). */
export async function lockExecution(db: Queryable, id: string): Promise<ExecutionRow | null> {
  const { rows } = await db.query<ExecutionRow>('SELECT * FROM executions WHERE id = $1 FOR UPDATE', [id]);
  return rows[0] ?? null;
}

export async function getExecution(db: Queryable, ownerId: string, id: string): Promise<ExecutionRow | null> {
  const { rows } = await db.query<ExecutionRow>('SELECT * FROM executions WHERE id = $1 AND owner_id = $2', [id, ownerId]);
  return rows[0] ?? null;
}

export async function listExecutions(
  db: Queryable,
  ownerId: string,
  filter: { routineId?: string; status?: string; limit: number },
): Promise<ExecutionRow[]> {
  const { rows } = await db.query<ExecutionRow>(
    `SELECT * FROM executions
      WHERE owner_id = $1
        AND ($2::uuid IS NULL OR routine_id = $2)
        AND ($3::text IS NULL OR status = $3)
      ORDER BY created_at DESC
      LIMIT $4`,
    [ownerId, filter.routineId ?? null, filter.status ?? null, filter.limit],
  );
  return rows;
}

const IN_FLIGHT_STATUSES: ExecutionStatus[] = ['PENDING', 'RUNNING', 'WAITING'];

/** Counts per status: executions created since `since`, plus all still in flight (however old). */
export async function executionStats(
  db: Queryable,
  ownerId: string,
  since: Date,
): Promise<{ byStatus: Partial<Record<ExecutionStatus, number>>; inFlight: Partial<Record<ExecutionStatus, number>> }> {
  const { rows } = await db.query<{ status: ExecutionStatus; recent: number; total: number }>(
    `SELECT status, count(*) FILTER (WHERE created_at >= $2)::int AS recent, count(*)::int AS total
       FROM executions
      WHERE owner_id = $1 AND (created_at >= $2 OR status = ANY($3))
      GROUP BY status`,
    [ownerId, since, IN_FLIGHT_STATUSES],
  );
  return {
    byStatus: Object.fromEntries(rows.filter((row) => row.recent > 0).map((row) => [row.status, row.recent])),
    inFlight: Object.fromEntries(rows.filter((row) => IN_FLIGHT_STATUSES.includes(row.status)).map((row) => [row.status, row.total])),
  };
}

export async function updateExecutionStatus(
  db: Queryable,
  id: string,
  status: ExecutionStatus,
  fields: { error?: string | null; currentStep?: number } = {},
): Promise<void> {
  await db.query(
    `UPDATE executions
        SET status = $2,
            error = COALESCE($3, error),
            current_step = COALESCE($4, current_step),
            started_at = CASE WHEN $2 = 'RUNNING' AND started_at IS NULL THEN now() ELSE started_at END,
            finished_at = CASE WHEN $2 IN ('COMPLETED', 'FAILED') THEN now() ELSE finished_at END,
            updated_at = now()
      WHERE id = $1`,
    [id, status, fields.error ?? null, fields.currentStep ?? null],
  );
}

export async function listExecutionActions(db: Queryable, executionId: string, forUpdate = false): Promise<ExecutionActionRow[]> {
  const { rows } = await db.query<ExecutionActionRow>(
    `SELECT * FROM execution_actions WHERE execution_id = $1 ORDER BY step, position ${forUpdate ? 'FOR UPDATE' : ''}`,
    [executionId],
  );
  return rows;
}

export async function markActionDispatched(db: Queryable, id: string, resolvedParams: Record<string, unknown>): Promise<void> {
  await db.query(
    `UPDATE execution_actions
        SET status = 'DISPATCHED', resolved_params = $2, attempts = 1, dispatched_at = now(), updated_at = now()
      WHERE id = $1`,
    [id, JSON.stringify(resolvedParams)],
  );
}

export async function markActionCompleted(db: Queryable, id: string, output: Record<string, unknown>, processedBy: string): Promise<void> {
  await db.query(
    `UPDATE execution_actions
        SET status = 'COMPLETED', output = $2, processed_by = $3, error = NULL, finished_at = now(), updated_at = now()
      WHERE id = $1`,
    [id, JSON.stringify(output), processedBy],
  );
}

export async function markActionFailed(db: Queryable, id: string, error: string, processedBy: string | null, attempts?: number): Promise<void> {
  await db.query(
    `UPDATE execution_actions
        SET status = 'FAILED', error = $2, processed_by = COALESCE($3, processed_by),
            attempts = COALESCE($4, attempts), finished_at = now(), updated_at = now()
      WHERE id = $1`,
    [id, error, processedBy, attempts ?? null],
  );
}

export async function markActionRetrying(db: Queryable, id: string, attempt: number, error: string, processedBy: string): Promise<void> {
  await db.query(
    `UPDATE execution_actions
        SET status = 'RETRYING', attempts = GREATEST(attempts, $2), error = $3, processed_by = $4, updated_at = now()
      WHERE id = $1`,
    [id, attempt + 1, error, processedBy],
  );
}

export async function skipPendingActions(db: Queryable, executionId: string): Promise<void> {
  await db.query(
    `UPDATE execution_actions SET status = 'SKIPPED', updated_at = now() WHERE execution_id = $1 AND status = 'PENDING'`,
    [executionId],
  );
}

export async function appendLog(db: Queryable, executionId: string, kind: string, message: string, actionKey?: string): Promise<void> {
  await db.query('INSERT INTO execution_log (execution_id, kind, action_key, message) VALUES ($1, $2, $3, $4)', [
    executionId,
    kind,
    actionKey ?? null,
    message,
  ]);
}

export async function listLog(db: Queryable, executionId: string): Promise<ExecutionLogRow[]> {
  const { rows } = await db.query<ExecutionLogRow>(
    'SELECT at, kind, action_key, message FROM execution_log WHERE execution_id = $1 ORDER BY id',
    [executionId],
  );
  return rows;
}

/** Flags executions whose dispatched actions got no answer for too long (e.g. worker down). */
export async function markStaleExecutionsWaiting(db: Queryable, waitingAfterMs: number): Promise<string[]> {
  const { rows } = await db.query<{ execution_id: string }>(
    `WITH stale AS (
       UPDATE executions e
          SET status = 'WAITING', updated_at = now()
        WHERE e.status = 'RUNNING'
          AND EXISTS (
            SELECT 1 FROM execution_actions a
             WHERE a.execution_id = e.id
               AND a.status = 'DISPATCHED'
               AND a.dispatched_at < now() - make_interval(secs => $1::double precision / 1000))
        RETURNING e.id
     )
     INSERT INTO execution_log (execution_id, kind, message)
     SELECT id, 'WAITING', 'No response from a worker – message is waiting in the broker' FROM stale
     RETURNING execution_id`,
    [waitingAfterMs],
  );
  return rows.map((row) => row.execution_id);
}

// ---------------------------------------------------------------- API representations

export function routineDto(row: RoutineRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    trigger: row.trigger,
    actions: row.actions,
    active: row.active,
    nextRunAt: row.next_run_at,
    // only the owner ever gets a routine DTO, and only a webhook routine has a usable URL
    webhookPath: row.trigger.type === 'webhook' && row.webhook_token ? webhookPath(row.webhook_token) : null,
    icon: row.icon,
    color: row.color,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function executionDto(row: ExecutionRow, actions?: ExecutionActionRow[], log?: ExecutionLogRow[]) {
  return {
    id: row.id,
    routineId: row.routine_id,
    routineName: row.routine_name,
    status: row.status,
    trigger: row.trigger_type,
    scheduledFor: row.scheduled_for,
    correlationId: row.correlation_id,
    traceId: row.trace_id,
    currentStep: row.current_step,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    ...(actions && { triggerPayload: row.trigger_payload }),
    ...(actions && {
      actions: actions.map((action) => ({
        id: action.id,
        key: action.key,
        type: action.type,
        step: action.step,
        status: action.status,
        attempts: action.attempts,
        params: action.resolved_params ?? action.params,
        output: action.output,
        error: action.error,
        processedBy: action.processed_by,
        dispatchedAt: action.dispatched_at,
        finishedAt: action.finished_at,
        ...(action.run_if && { runIf: action.run_if }),
        ...(action.for_each && { forEach: action.for_each }),
        ...(action.parent_id && { parentId: action.parent_id, loopIndex: action.loop_index }),
      })),
    }),
    ...(log && {
      log: log.map((entry) => ({ at: entry.at, kind: entry.kind, actionKey: entry.action_key, message: entry.message })),
    }),
  };
}
