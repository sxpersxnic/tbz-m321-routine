import { withTransaction, type ErrorCode, type Pool, type Queryable } from '@routine/service-kit';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ActionDefinition, Appearance, ExecutionTrigger, RoutineColor, RoutineDefinition, RunIf, TriggerDefinition } from './domain/definition.ts';
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
  alert_after_failures: number | null;
  consecutive_failures: number;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  runs_30d: number;
  failures_30d: number;
  created_at: Date;
  updated_at: Date;
}

export interface ExecutionRow {
  id: string;
  routine_id: string;
  owner_id: string;
  routine_name: string;
  trigger_type: ExecutionTrigger;
  scheduled_for: Date | null;
  trigger_payload: Record<string, unknown> | null;
  status: ExecutionStatus;
  current_step: number;
  correlation_id: string;
  trace_id: string | null;
  parent_action_id: string | null;
  parent_execution_id: string | null;
  call_depth: number;
  error: string | null;
  resume_count: number;
  routine_version: number | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  /** Code of the failed action (lists only: joined in by listExecutions). */
  error_code?: ErrorCode | null;
}

/** Why a step was skipped (docs/v2/06-engine.md §1). */
export type SkipReason = 'condition' | 'failure' | 'expired' | 'user' | 'test';

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
  error_code: ErrorCode | null;
  skip_reason: SkipReason | null;
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

// ---------------------------------------------------------------- versions (06-engine §7)

/** What changed in a version: the kind of write that produced it. */
export type VersionOrigin = 'create' | 'edit' | 'appearance' | 'activate' | 'deactivate' | 'webhook' | 'restore' | 'backfill';

/** A routine as its history keeps it – no ids, no webhook token. */
export interface VersionDefinition extends RoutineDefinition {
  active: boolean;
}

export interface RoutineVersionRow {
  routine_id: string;
  version: number;
  definition: VersionDefinition;
  created_at: Date;
  created_by: string;
  origin: VersionOrigin;
}

export function versionDefinition(row: RoutineRow): VersionDefinition {
  return {
    name: row.name,
    description: row.description,
    trigger: row.trigger,
    actions: row.actions,
    icon: row.icon,
    color: row.color as RoutineColor | null,
    alertAfterFailures: row.alert_after_failures,
    active: row.active,
  };
}

/** Stores the version a write just produced – call it in that write's transaction. Returns the row for chaining. */
async function recordVersion(db: Queryable, row: RoutineRow, origin: VersionOrigin, by: string): Promise<RoutineRow> {
  await db.query(
    `INSERT INTO routine_versions (routine_id, version, definition, created_by, origin) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (routine_id, version) DO NOTHING`,
    [row.id, row.version, JSON.stringify(versionDefinition(row)), by, origin],
  );
  return row;
}

export async function listVersions(db: Queryable, routineId: string): Promise<RoutineVersionRow[]> {
  const { rows } = await db.query<RoutineVersionRow>('SELECT * FROM routine_versions WHERE routine_id = $1 ORDER BY version DESC', [routineId]);
  return rows;
}

export async function getVersion(db: Queryable, routineId: string, version: number): Promise<RoutineVersionRow | null> {
  const { rows } = await db.query<RoutineVersionRow>('SELECT * FROM routine_versions WHERE routine_id = $1 AND version = $2', [routineId, version]);
  return rows[0] ?? null;
}

export function versionDto(row: RoutineVersionRow, withDefinition = true) {
  return {
    version: row.version,
    createdAt: row.created_at,
    origin: row.origin,
    ...(withDefinition && { definition: row.definition }),
  };
}

export async function insertRoutine(db: Queryable, id: string, ownerId: string, definition: RoutineDefinition, by: string = ownerId): Promise<RoutineRow> {
  const { rows } = await db.query<RoutineRow>(
    `INSERT INTO routines (id, owner_id, name, description, trigger, actions, webhook_token, icon, color, alert_after_failures)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $10 THEN $11::int ELSE 2 END) RETURNING *`,
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
      definition.alertAfterFailures !== undefined,
      definition.alertAfterFailures ?? null,
    ],
  );
  return recordVersion(db, rows[0], 'create', by);
}

export async function updateRoutine(
  db: Queryable,
  routine: RoutineRow,
  definition: RoutineDefinition,
  nextRunAt: Date | null,
  change: { by: string; origin?: VersionOrigin } = { by: routine.owner_id },
): Promise<RoutineRow> {
  const { rows } = await db.query<RoutineRow>(
    `UPDATE routines
        SET name = $2, description = $3, trigger = $4, actions = $5, next_run_at = $6,
            webhook_token = COALESCE(webhook_token, $7),
            icon = CASE WHEN $8 THEN $9 ELSE icon END,
            color = CASE WHEN $10 THEN $11 ELSE color END,
            alert_after_failures = CASE WHEN $12 THEN $13::int ELSE alert_after_failures END,
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
      definition.alertAfterFailures !== undefined,
      definition.alertAfterFailures ?? null,
    ],
  );
  return recordVersion(db, rows[0], change.origin ?? 'edit', change.by);
}

/** Icon and colour only – the definition, schedule and webhook stay untouched. */
export async function updateAppearance(db: Queryable, id: string, appearance: Appearance, by: string): Promise<RoutineRow> {
  const { rows } = await db.query<RoutineRow>(
    `UPDATE routines
        SET icon = CASE WHEN $2 THEN $3 ELSE icon END,
            color = CASE WHEN $4 THEN $5 ELSE color END,
            version = version + 1, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, appearance.icon !== undefined, appearance.icon ?? null, appearance.color !== undefined, appearance.color ?? null],
  );
  return recordVersion(db, rows[0], 'appearance', by);
}

export async function setRoutineActive(db: Queryable, id: string, active: boolean, nextRunAt: Date | null, by: string): Promise<RoutineRow> {
  const { rows } = await db.query<RoutineRow>(
    'UPDATE routines SET active = $2, next_run_at = $3, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *',
    [id, active, nextRunAt],
  );
  return recordVersion(db, rows[0], active ? 'activate' : 'deactivate', by);
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
export async function rotateWebhookToken(db: Queryable, id: string, by: string): Promise<RoutineRow> {
  const { rows } = await db.query<RoutineRow>(
    'UPDATE routines SET webhook_token = $2, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *',
    [id, newWebhookToken()],
  );
  return recordVersion(db, rows[0], 'webhook', by);
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
    trigger: ExecutionTrigger;
    scheduledFor: Date | null;
    idempotencyKey: string | null;
    payload: Record<string, unknown> | null;
    correlationId: string;
    traceId: string | null;
    /** Set when a `routine.run` step started this execution. */
    parent?: { actionId: string; executionId: string; depth: number };
  },
): Promise<ExecutionRow | null> {
  const { rows } = await db.query<ExecutionRow>(
    `INSERT INTO executions (id, routine_id, owner_id, routine_name, trigger_type, scheduled_for, idempotency_key, status, correlation_id, trace_id, trigger_payload,
                             parent_action_id, parent_execution_id, call_depth, routine_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9, $10, $11, $12, $13, $14)
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
      execution.parent?.actionId ?? null,
      execution.parent?.executionId ?? null,
      execution.parent?.depth ?? 0,
      execution.routine.version,
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

export async function markActionSkipped(db: Queryable, id: string, reason: SkipReason): Promise<void> {
  await db.query(`UPDATE execution_actions SET status = 'SKIPPED', skip_reason = $2, finished_at = now(), updated_at = now() WHERE id = $1`, [id, reason]);
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
    `SELECT e.*,
            (SELECT a.error_code FROM execution_actions a
              WHERE a.execution_id = e.id AND a.status = 'FAILED'
              ORDER BY a.finished_at DESC NULLS LAST LIMIT 1) AS error_code
       FROM executions e
      WHERE e.owner_id = $1
        AND ($2::uuid IS NULL OR e.routine_id = $2)
        AND ($3::text IS NULL OR e.status = $3)
      ORDER BY e.created_at DESC
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

export async function markActionFailed(
  db: Queryable,
  id: string,
  failure: { error: string; code: ErrorCode },
  processedBy: string | null,
  attempts?: number,
): Promise<void> {
  await db.query(
    `UPDATE execution_actions
        SET status = 'FAILED', error = $2, error_code = $3, processed_by = COALESCE($4, processed_by),
            attempts = COALESCE($5, attempts), finished_at = now(), updated_at = now()
      WHERE id = $1`,
    [id, failure.error, failure.code, processedBy, attempts ?? null],
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

/** A step as the routine defines it now – resume runs reset steps with their current settings. */
export interface CurrentStep {
  type: string;
  params: Record<string, unknown>;
  runIf: RunIf | null;
  forEach: string | null;
}

/**
 * Resume (06-engine §6): the failed steps and the ones skipped because of the failure go back to
 * PENDING – same ids, so workers see the same idempotency key, attempts kept. A step still in the
 * routine with the same key and type takes its current params (a loop child: its loop's params),
 * so "Edit step" followed by "Retry from here" runs the fixed step. Returns the reset rows.
 */
export async function resetForResume(db: Queryable, executionId: string, current: Map<string, CurrentStep>): Promise<ExecutionActionRow[]> {
  const { rows } = await db.query<ExecutionActionRow>(
    `UPDATE execution_actions
        SET status = 'PENDING', error = NULL, error_code = NULL, skip_reason = NULL, output = NULL,
            resolved_params = NULL, dispatched_at = NULL, finished_at = NULL, updated_at = now()
      WHERE execution_id = $1 AND (status = 'FAILED' OR (status = 'SKIPPED' AND skip_reason = 'failure'))
      RETURNING *`,
    [executionId],
  );
  const byId = new Map((await listExecutionActions(db, executionId)).map((action) => [action.id, action]));
  for (const row of rows) {
    const parent = row.parent_id ? byId.get(row.parent_id) : undefined;
    const step = current.get(parent?.key ?? row.key);
    if (!step || step.type !== row.type) continue;
    // a loop child keeps its item; only a top-level step takes over its condition and loop
    const runIf = parent ? row.run_if : step.runIf;
    const forEach = parent ? row.for_each : step.forEach;
    await db.query('UPDATE execution_actions SET params = $2, run_if = $3, for_each = $4 WHERE id = $1', [
      row.id,
      JSON.stringify(step.params),
      runIf ? JSON.stringify(runIf) : null,
      forEach,
    ]);
    Object.assign(row, { params: step.params, run_if: runIf, for_each: forEach });
  }
  return rows;
}

/** FAILED → RUNNING for a resume: error and end cleared, one more resume counted. */
export async function markExecutionResumed(db: Queryable, id: string): Promise<void> {
  await db.query(
    `UPDATE executions SET status = 'RUNNING', error = NULL, finished_at = NULL, resume_count = resume_count + 1, updated_at = now() WHERE id = $1`,
    [id],
  );
}

/** After a failure: everything not run yet is skipped *because of* it – resume runs these again. */
export async function skipPendingActions(db: Queryable, executionId: string): Promise<void> {
  await db.query(
    `UPDATE execution_actions SET status = 'SKIPPED', skip_reason = 'failure', updated_at = now() WHERE execution_id = $1 AND status = 'PENDING'`,
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
    alertAfterFailures: row.alert_after_failures,
    health: {
      consecutiveFailures: row.consecutive_failures,
      lastSuccessAt: row.last_success_at,
      lastFailureAt: row.last_failure_at,
      runs30d: row.runs_30d,
      failures30d: row.failures_30d,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------- health (06-engine §10)

/**
 * A run of the routine finished: a success resets the streak, a failure extends it. Returns the
 * routine's counters after the change (null if the routine is gone).
 */
export async function recordRunOutcome(
  db: Queryable,
  routineId: string,
  outcome: 'COMPLETED' | 'FAILED',
): Promise<Pick<RoutineRow, 'consecutive_failures' | 'alert_after_failures' | 'name'> | null> {
  const failed = outcome === 'FAILED';
  const { rows } = await db.query<Pick<RoutineRow, 'consecutive_failures' | 'alert_after_failures' | 'name'>>(
    `UPDATE routines
        SET consecutive_failures = CASE WHEN $2 THEN consecutive_failures + 1 ELSE 0 END,
            last_failure_at = CASE WHEN $2 THEN now() ELSE last_failure_at END,
            last_success_at = CASE WHEN $2 THEN last_success_at ELSE now() END,
            runs_30d = runs_30d + 1,
            failures_30d = failures_30d + CASE WHEN $2 THEN 1 ELSE 0 END
      WHERE id = $1
      RETURNING consecutive_failures, alert_after_failures, name`,
    [routineId, failed],
  );
  return rows[0] ?? null;
}

/**
 * Recomputes the 30-day counts from the runs (runs older than 30 days drop out). Once per day after
 * `hourUtc`, on one replica: the advisory lock and job_runs make every other attempt a no-op.
 * Returns whether this call did the refresh.
 */
export async function refreshHealthIfDue(pool: Pool, now = new Date(), hourUtc = 3): Promise<boolean> {
  if (now.getUTCHours() < hourUtc) return false;
  return withTransaction(pool, async (client) => {
    const { rows: lock } = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_xact_lock(hashtext('health-refresh')) AS locked`);
    if (!lock[0]?.locked) return false;
    const { rows: last } = await client.query<{ last_run_at: Date }>(`SELECT last_run_at FROM job_runs WHERE name = 'health-refresh'`);
    if (last[0] && last[0].last_run_at.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)) return false;
    await client.query(
      `UPDATE routines r SET
         runs_30d = (SELECT count(*) FROM executions e WHERE e.routine_id = r.id AND e.status IN ('COMPLETED', 'FAILED') AND e.created_at > $1::timestamptz - interval '30 days'),
         failures_30d = (SELECT count(*) FROM executions e WHERE e.routine_id = r.id AND e.status = 'FAILED' AND e.created_at > $1::timestamptz - interval '30 days')`,
      [now],
    );
    await client.query(
      `INSERT INTO job_runs (name, last_run_at) VALUES ('health-refresh', $1) ON CONFLICT (name) DO UPDATE SET last_run_at = $1`,
      [now],
    );
    return true;
  });
}

export function executionDto(row: ExecutionRow, actions?: ExecutionActionRow[], log?: ExecutionLogRow[]) {
  const failed = actions?.filter((action) => action.status === 'FAILED').sort((a, b) => (b.finished_at?.getTime() ?? 0) - (a.finished_at?.getTime() ?? 0))[0];
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
    /** Why the run failed (error code of its failed step), null when it didn't or failed before v2. */
    errorCode: row.status === 'FAILED' ? (failed?.error_code ?? row.error_code ?? null) : null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    calledBy: row.parent_execution_id,
    resumeCount: row.resume_count,
    routineVersion: row.routine_version,
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
        errorCode: action.error_code,
        skipReason: action.skip_reason,
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
