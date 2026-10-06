import { randomUUID } from 'node:crypto';
import { currentContext, currentTraceId, enqueue, withTransaction, type ErrorCode, type Logger, type Pool, type PoolClient } from '@routine/service-kit';
import { conditionMet, ControlError } from './domain/control.ts';
import { CONTROL_ACTION_TYPES, evaluateControlAction } from './domain/scripting.ts';
import { decideNext, inFlightStatus, TERMINAL_ACTION_STATUSES, TERMINAL_EXECUTION_STATUSES, type InFlightStatus } from './domain/progress.ts';
import { BUILTIN_CATALOG, type Catalog, type CatalogCapability } from './domain/catalog.ts';
import type { ActionDefinition, ExecutionTrigger } from './domain/definition.ts';
import { DEFAULT_TIMEZONE } from './domain/schedule.ts';
import { resolveTemplates, TemplateError, type TemplateScope } from './domain/templates.ts';
import { wakeAt } from './domain/wait.ts';
import {
  actionCancelRequested,
  actionRequested,
  executionCompleted,
  executionFailed,
  executionResumed,
  executionWaitingForYou,
  routineUnhealthy,
  routineTriggered,
  subRoutineResult,
  type ActionResult,
  type CancelReason,
  type CompletionEventFormat,
} from './messages.ts';
import {
  appendLog,
  findExecutionByIdempotencyKey,
  getRoutine,
  insertExecutionActions,
  insertLoopActions,
  listExecutionActions,
  lockExecution,
  copySampleActions,
  dueAwaitingActions,
  dueWaitActions,
  insertExecution,
  markExecutionResumed,
  recordRunOutcome,
  resetForResume,
  markActionAwaiting,
  markActionCompleted,
  markActionDispatched,
  markActionFailed,
  markActionRetrying,
  markActionScheduled,
  markActionSkipped,
  markStaleExecutionsWaiting,
  skipPendingActions,
  skipUnfinishedActions,
  updateExecutionStatus,
  type ExecutionActionRow,
  type ExecutionRow,
  type RoutineRow,
} from './store.ts';

export interface EngineOptions {
  completionEventFormat: CompletionEventFormat;
  waitingAfterMs: number;
  /** The current catalog – decides what a test run may send (default: routine-service's own domains + v1). */
  catalog?: () => Promise<Catalog>;
}

export interface TriggerRequest {
  type: ExecutionTrigger;
  scheduledFor?: Date;
  idempotencyKey?: string;
  /** Body of a webhook call, or `{ input }` of a routine.run call. */
  payload?: Record<string, unknown>;
  /** The routine.run step that called this routine. */
  parent?: { actionId: string; executionId: string; depth: number };
  /** The answers to the routine's questions (validated by the caller). */
  inputs?: Record<string, unknown>;
  /** What started an event-triggered run (StartRoutineRequested). */
  event?: { event: string; eventMessageId: string; data: Record<string, unknown>; depth: number };
}

/** Values of the `variable.set` steps that ran, in run order – a later assignment wins. */
function variablesOf(actions: ExecutionActionRow[]): Record<string, unknown> {
  const vars: Record<string, unknown> = {};
  const done = actions.filter((action) => action.status === 'COMPLETED' && action.type === 'variable.set');
  for (const action of done.sort((a, b) => a.step - b.step || (a.finished_at?.getTime() ?? 0) - (b.finished_at?.getTime() ?? 0))) {
    if (typeof action.output?.name === 'string') vars[action.output.name] = action.output.value;
  }
  return vars;
}

/** What a routine returns to the step that called it: its variables, and "result" as the return value. */
function subRoutineOutput(actions: ExecutionActionRow[]): Record<string, unknown> {
  const vars = variablesOf(actions);
  return { result: vars.result ?? null, vars };
}

/**
 * What a test run may send (04 §3.4, 06 §4): values and everything else without side effects run as
 * usual; an action runs only if its domain can answer with a preview (it then changes nothing).
 * Everything else is skipped (`test`).
 */
export function runsInTest(capability: CatalogCapability | undefined): boolean {
  if (!capability) return false;
  return capability.kind === 'value' || !capability.sideEffects || (capability.kind === 'action' && capability.preview === true);
}

/** `processed_by` of what the engine did itself (scripting actions, loop expansion). */
const ENGINE = 'routine-engine';
const MAX_LOOP_ITEMS = 50;
/** routine.run nesting: A → B → C … at most this deep, so a routine calling itself stops. */
const MAX_CALL_DEPTH = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IN_FLIGHT_LOG: Record<InFlightStatus, string> = {
  WAITING: 'Waiting for an action to be retried',
  RUNNING: 'Processing resumed',
  WAITING_FOR_YOU: 'Waiting for you',
  DELAYED: 'Waiting for a timer',
};

const TRIGGER_LOG: Record<ExecutionTrigger, (trigger: TriggerRequest) => string> = {
  manual: () => 'Started manually',
  routine: () => 'Called by another routine',
  schedule: (trigger) => `Started by schedule (${trigger.scheduledFor?.toISOString()})`,
  webhook: () => 'Started by webhook',
  event: (trigger) => `Started by ${trigger.event?.event ?? 'an event'}`,
};

/**
 * Orchestrates executions. Every state transition happens in one database
 * transaction together with the outbox messages it causes, and the execution
 * row is locked, so concurrent results (parallel actions, several replicas,
 * duplicate deliveries) are applied one after another and exactly once.
 */
export class ExecutionEngine {
  #pool: Pool;
  #logger: Logger;
  #options: EngineOptions;
  #catalog: () => Promise<Catalog>;

  constructor(pool: Pool, logger: Logger, options: EngineOptions) {
    this.#pool = pool;
    this.#logger = logger;
    this.#options = options;
    this.#catalog = options.catalog ?? (async () => BUILTIN_CATALOG);
  }

  /** Creates a PENDING execution and emits RoutineTriggered – inside the caller's transaction. */
  async createExecution(
    client: PoolClient,
    routine: RoutineRow,
    trigger: TriggerRequest,
  ): Promise<{ execution: ExecutionRow; created: boolean } | null> {
    if (trigger.idempotencyKey) {
      const existing = await findExecutionByIdempotencyKey(client, routine.id, trigger.idempotencyKey);
      if (existing) return { execution: existing, created: false };
    }

    const correlationId = currentContext().correlationId ?? randomUUID();
    const execution = await insertExecution(client, {
      id: randomUUID(),
      routine,
      trigger: trigger.type,
      scheduledFor: trigger.scheduledFor ?? null,
      idempotencyKey: trigger.idempotencyKey ?? null,
      payload: trigger.payload ?? null,
      correlationId,
      traceId: currentTraceId(),
      parent: trigger.parent,
      inputs: trigger.inputs ?? null,
    });
    if (!execution) {
      // Lost an insert race: a concurrent request with the same key won (the caller's routine
      // lock normally prevents this) – answer with its execution, like a sequential retry.
      if (trigger.idempotencyKey) {
        const existing = await findExecutionByIdempotencyKey(client, routine.id, trigger.idempotencyKey);
        if (existing) return { execution: existing, created: false };
      }
      return null; // this scheduled slot was already taken
    }

    await insertExecutionActions(
      client,
      execution.id,
      routine.actions.map((action) => ({ ...action, id: randomUUID() })),
    );
    await appendLog(
      client,
      execution.id,
      'TRIGGERED',
      TRIGGER_LOG[trigger.type](trigger),
    );
    await enqueue(
      client,
      routineTriggered({
        executionId: execution.id,
        routineId: routine.id,
        ownerId: routine.owner_id,
        trigger: trigger.type,
        scheduledFor: execution.scheduled_for,
        correlationId,
      }),
    );
    this.#logger.info({ executionId: execution.id, routineId: routine.id, trigger: trigger.type }, 'execution created');
    return { execution, created: true };
  }

  /** Handles RoutineTriggered: PENDING → RUNNING and dispatch of the first step. */
  async start(executionId: string): Promise<void> {
    await withTransaction(this.#pool, async (client) => {
      const execution = await lockExecution(client, executionId);
      if (!execution) {
        this.#logger.warn({ executionId }, 'RoutineTriggered for unknown execution ignored');
        return;
      }
      if (execution.status !== 'PENDING') {
        this.#logger.info({ executionId, status: execution.status }, 'duplicate RoutineTriggered ignored (execution already started)');
        return;
      }
      await updateExecutionStatus(client, execution.id, 'RUNNING');
      await appendLog(client, execution.id, 'STARTED', 'Execution started');
      execution.status = 'RUNNING';
      execution.started_at = new Date();
      this.#logger.info({ executionId }, 'execution started');
      await this.#advance(client, execution, await listExecutionActions(client, execution.id));
    });
  }

  /** Handles ActionCompleted / ActionFailed / ActionRetryScheduled. */
  async applyResult(result: ActionResult): Promise<void> {
    await withTransaction(this.#pool, async (client) => {
      const execution = await lockExecution(client, result.executionId);
      if (!execution) {
        this.#logger.warn({ actionId: result.actionId }, 'result for unknown execution ignored');
        return;
      }
      const actions = await listExecutionActions(client, execution.id);
      const action = actions.find((candidate) => candidate.id === result.actionId);
      if (!action) {
        this.#logger.warn({ actionId: result.actionId }, 'result for unknown action ignored');
        return;
      }
      if (TERMINAL_ACTION_STATUSES.has(action.status)) {
        // a person who acts in the moment their step expired or was skipped: the first transition won (05 §5 rule 4)
        if (result.kind === 'completed' && action.status === 'SKIPPED' && action.awaiting && !result.duplicate) {
          await appendLog(client, execution.id, 'ACTION_LATE', 'Done too late – the step was skipped already', action.key);
        }
        this.#logger.info({ actionKey: action.key, status: action.status, resultKind: result.kind }, 'duplicate result ignored (action already finished)');
        return;
      }
      if (result.kind === 'awaiting' && action.status === 'AWAITING_USER') {
        this.#logger.info({ actionKey: action.key }, 'duplicate awaiting result ignored (step waits already)');
        return;
      }

      switch (result.kind) {
        case 'completed':
          await markActionCompleted(client, action.id, result.output, result.processedBy);
          await appendLog(client, execution.id, 'ACTION_COMPLETED', `${action.type} completed by ${result.processedBy}`, action.key);
          Object.assign(action, { status: 'COMPLETED', output: result.output, processed_by: result.processedBy });
          this.#logger.info({ actionKey: action.key, processedBy: result.processedBy }, 'action completed');
          break;
        case 'failed':
          await markActionFailed(client, action.id, { error: result.error, code: result.code }, result.processedBy, result.attempts);
          await appendLog(client, execution.id, 'ACTION_FAILED', `Failed after ${result.attempts} attempt(s): ${result.error}`, action.key);
          Object.assign(action, { status: 'FAILED', error: result.error, error_code: result.code });
          this.#logger.warn({ actionKey: action.key, err: result.error }, 'action failed');
          break;
        case 'retry':
          await markActionRetrying(client, action.id, result.attempt, result.error, result.processedBy);
          await appendLog(
            client,
            execution.id,
            'ACTION_RETRY',
            `Attempt ${result.attempt} failed (${result.error}) – retrying in ${result.nextAttemptInMs / 1000} s`,
            action.key,
          );
          Object.assign(action, { status: 'RETRYING' });
          this.#logger.info({ actionKey: action.key, attempt: result.attempt }, 'action retry scheduled');
          break;
        case 'awaiting': {
          const { accepted_at, deadline_at } = await markActionAwaiting(client, action.id, result.awaiting, result.processedBy);
          await appendLog(client, execution.id, 'ACTION_AWAITING', `Waiting for you: ${result.awaiting.title}`, action.key);
          Object.assign(action, { status: 'AWAITING_USER', awaiting: result.awaiting, accepted_at, deadline_at, processed_by: result.processedBy });
          this.#logger.info({ actionKey: action.key, kind: result.awaiting.kind, deadlineAt: deadline_at }, 'action waiting for a person');
          break;
        }
      }

      // Late results of a finished execution are recorded but change nothing else.
      if (TERMINAL_EXECUTION_STATUSES.has(execution.status)) return;
      await this.#advance(client, execution, actions);
    });
  }

  /**
   * "Try this step" (06-engine §12): a test run of one step. References resolve against `sample`
   * (normally the routine's last run), whose completed steps are copied into the test run. Only
   * test-safe steps really run; the client polls the returned execution.
   */
  async createTestRun(routine: RoutineRow, action: ActionDefinition, sample: ExecutionRow | null): Promise<string> {
    const id = await withTransaction(this.#pool, async (client) => {
      const execution = await insertExecution(client, {
        id: randomUUID(),
        routine,
        trigger: sample?.trigger_type ?? 'manual',
        scheduledFor: null,
        idempotencyKey: null,
        payload: sample?.trigger_payload ?? null,
        correlationId: currentContext().correlationId ?? randomUUID(),
        traceId: currentTraceId(),
        kind: 'test',
        inputs: sample?.inputs ?? null,
      });
      if (!execution) throw new Error('test run could not be created');
      if (sample) await copySampleActions(client, execution.id, sample.id, action.key);
      await insertExecutionActions(client, execution.id, [{ ...action, id: randomUUID() }]);
      await appendLog(client, execution.id, 'TRIGGERED', `Test of step "${action.key}"${sample ? ` with the values of run ${sample.id}` : ''}`);
      return execution.id;
    });
    await this.start(id);
    this.#logger.info({ executionId: id, routineId: routine.id, actionType: action.type }, 'test run started');
    return id;
  }

  /**
   * "Retry from here" (06-engine §6): a FAILED run goes on from its failed step. Completed steps keep
   * their results; the failed step and the steps skipped because of it run again, with the routine's
   * current settings for them. `not_failed` when the run isn't FAILED (any more).
   */
  async resume(executionId: string, ownerId: string, resumedBy: string): Promise<'resumed' | 'not_found' | 'not_failed'> {
    return withTransaction(this.#pool, async (client) => {
      const execution = await lockExecution(client, executionId);
      if (!execution || execution.owner_id !== ownerId) return 'not_found';
      // a cancelled run was ended on purpose – there is no failed step to go on from
      if (execution.status !== 'FAILED' || execution.error_code === 'CANCELLED') return 'not_failed';

      const routine = await getRoutine(client, ownerId, execution.routine_id);
      const current = new Map(
        (routine?.actions ?? []).map((action) => [action.key, { type: action.type, params: action.params, runIf: action.runIf ?? null, forEach: action.forEach ?? null, timeout: action.timeout ?? null }]),
      );
      const from = (await listExecutionActions(client, execution.id)).filter((action) => action.status === 'FAILED').sort((a, b) => a.step - b.step)[0];
      await resetForResume(client, execution.id, current);
      await markExecutionResumed(client, execution.id);
      Object.assign(execution, { status: 'RUNNING', error: null, finished_at: null, resume_count: execution.resume_count + 1 });
      await appendLog(client, execution.id, 'RESUMED', `Resumed from "${from?.key ?? '?'}"`, from?.key);
      await enqueue(
        client,
        executionResumed({
          executionId: execution.id,
          routineId: execution.routine_id,
          ownerId,
          fromActionKey: from?.key ?? '',
          resumedBy,
          resumeCount: execution.resume_count,
          correlationId: execution.correlation_id,
        }),
      );
      this.#logger.info({ executionId, from: from?.key, resumeCount: execution.resume_count }, 'execution resumed');
      await this.#advance(client, execution, await listExecutionActions(client, execution.id));
      return 'resumed';
    });
  }

  /**
   * Housekeeping (06-engine §5.4): human steps whose deadline passed are skipped or fail, as their
   * timeout says, and their items closed. Replica-safe: an execution another replica holds is left
   * for the next round. Returns how many steps expired.
   */
  async expireAwaitingActions(limit = 50): Promise<number> {
    let expired = 0;
    for (const due of await dueAwaitingActions(this.#pool, limit)) {
      const done = await withTransaction(this.#pool, async (client) => {
        const execution = await lockExecution(client, due.execution_id, true);
        if (!execution) return false;
        const actions = await listExecutionActions(client, execution.id);
        const action = actions.find((candidate) => candidate.id === due.id);
        // completed, skipped or cancelled meanwhile – whoever committed first wins
        if (action?.status !== 'AWAITING_USER' || !action.deadline_at || action.deadline_at.getTime() > Date.now()) return false;
        if (action.timeout?.then === 'fail') {
          const message = `Nobody did "${action.awaiting?.title ?? action.key}" in time`;
          await markActionFailed(client, action.id, { error: message, code: 'AWAIT_EXPIRED' }, null);
          await appendLog(client, execution.id, 'ACTION_FAILED', message, action.key);
          Object.assign(action, { status: 'FAILED', error: message, error_code: 'AWAIT_EXPIRED' });
        } else {
          await markActionSkipped(client, action.id, 'expired');
          await appendLog(client, execution.id, 'ACTION_SKIPPED', 'Skipped – nobody got to it in time', action.key);
          Object.assign(action, { status: 'SKIPPED', skip_reason: 'expired' });
        }
        await this.#cancelItem(client, execution, action, 'expired');
        this.#logger.info({ executionId: execution.id, actionKey: action.key, outcome: action.timeout?.then ?? 'skip' }, 'human step expired');
        if (!TERMINAL_EXECUTION_STATUSES.has(execution.status)) await this.#advance(client, execution, actions);
        return true;
      });
      if (done) expired++;
    }
    return expired;
  }

  /**
   * Housekeeping (06-engine §9): Wait steps whose time has come complete with `wokeAt`, and the run
   * goes on. Replica-safe like expiry: an execution another replica holds waits for the next round.
   */
  async wakeDueWaits(limit = 50): Promise<number> {
    let woken = 0;
    for (const due of await dueWaitActions(this.#pool, limit)) {
      const done = await withTransaction(this.#pool, async (client) => {
        const execution = await lockExecution(client, due.execution_id, true);
        if (!execution) return false;
        const actions = await listExecutionActions(client, execution.id);
        const action = actions.find((candidate) => candidate.id === due.id);
        if (action?.status !== 'SCHEDULED' || !action.wake_at || action.wake_at.getTime() > Date.now()) return false;
        const output = { wokeAt: new Date().toISOString() };
        await markActionCompleted(client, action.id, output, ENGINE);
        await appendLog(client, execution.id, 'ACTION_COMPLETED', 'Waited long enough', action.key);
        Object.assign(action, { status: 'COMPLETED', output, processed_by: ENGINE });
        if (!TERMINAL_EXECUTION_STATUSES.has(execution.status)) await this.#advance(client, execution, actions);
        return true;
      });
      if (done) woken++;
    }
    return woken;
  }

  /** "Skip" on a waiting human step (06-engine §5.5): the run goes on without it. */
  async skipAwaitingAction(executionId: string, ownerId: string, actionKey: string): Promise<'skipped' | 'not_found' | 'not_waiting'> {
    return withTransaction(this.#pool, async (client) => {
      const execution = await lockExecution(client, executionId);
      if (!execution || execution.owner_id !== ownerId) return 'not_found';
      const actions = await listExecutionActions(client, execution.id);
      const action = actions.find((candidate) => candidate.key === actionKey);
      if (!action) return 'not_found';
      if (action.status !== 'AWAITING_USER') return 'not_waiting';
      await markActionSkipped(client, action.id, 'user');
      await appendLog(client, execution.id, 'ACTION_SKIPPED', 'Skipped by you', action.key);
      Object.assign(action, { status: 'SKIPPED', skip_reason: 'user' });
      await this.#cancelItem(client, execution, action, 'skipped');
      if (!TERMINAL_EXECUTION_STATUSES.has(execution.status)) await this.#advance(client, execution, actions);
      return 'skipped';
    });
  }

  /**
   * Cancels a run that hasn't finished (services/routine-service.md §3): everything not finished is
   * skipped, waiting items are closed, and the run ends FAILED with CANCELLED – no ExecutionFailed
   * and no health count, it was the owner's choice. A calling routine.run step fails.
   */
  async cancel(executionId: string, ownerId: string): Promise<'cancelled' | 'not_found' | 'finished'> {
    return withTransaction(this.#pool, async (client) => {
      const execution = await lockExecution(client, executionId);
      if (!execution || execution.owner_id !== ownerId) return 'not_found';
      if (TERMINAL_EXECUTION_STATUSES.has(execution.status)) return 'finished';
      for (const action of await skipUnfinishedActions(client, execution.id)) await this.#cancelItem(client, execution, action, 'runCancelled');
      await updateExecutionStatus(client, execution.id, 'FAILED', { error: 'Cancelled', errorCode: 'CANCELLED' });
      await appendLog(client, execution.id, 'CANCELLED', 'Cancelled by you');
      await this.#reportToCaller(client, execution, { ok: false, error: `Routine "${execution.routine_name}" was cancelled` });
      this.#logger.info({ executionId }, 'execution cancelled');
      return 'cancelled';
    });
  }

  /** Asks the domain holding a human step's item to close it (05-messaging §4.1) – through the outbox. */
  async #cancelItem(client: PoolClient, execution: ExecutionRow, action: ExecutionActionRow, reason: CancelReason): Promise<void> {
    await enqueue(
      client,
      actionCancelRequested({
        actionId: action.id,
        executionId: execution.id,
        routineId: execution.routine_id,
        ownerId: execution.owner_id,
        actionKey: action.key,
        actionType: action.type,
        reason,
        correlationId: execution.correlation_id,
      }),
    );
  }

  /** Periodic check: executions waiting for an unresponsive worker become WAITING. */
  async markStaleExecutions(): Promise<void> {
    const ids = await markStaleExecutionsWaiting(this.#pool, this.#options.waitingAfterMs);
    for (const executionId of ids) this.#logger.warn({ executionId }, 'execution waiting: no worker response yet');
  }

  async #advance(client: PoolClient, execution: ExecutionRow, actions: ExecutionActionRow[]): Promise<void> {
    for (;;) {
      const decision = decideNext(
        actions.map((action) => ({ key: action.key, step: action.step, status: action.status, dispatchedAt: action.dispatched_at })),
      );

      switch (decision.kind) {
        case 'dispatch': {
          const batch = actions.filter((action) => decision.keys.includes(action.key));
          const toSend: Array<{ action: ExecutionActionRow; params: Record<string, unknown> }> = [];
          const fail = async (action: ExecutionActionRow, message: string, code: ErrorCode) => {
            await markActionFailed(client, action.id, { error: message, code }, null);
            await appendLog(client, execution.id, 'ACTION_FAILED', message, action.key);
            Object.assign(action, { status: 'FAILED', error: message, error_code: code });
          };

          for (const action of batch) {
            // "Only if": a step whose condition did not hold (or did not run) is skipped
            if (action.run_if) {
              const condition = actions.find((candidate) => candidate.key === action.run_if?.action);
              if (!condition || !conditionMet(condition, action.run_if.is)) {
                await markActionSkipped(client, action.id, 'condition');
                await appendLog(client, execution.id, 'ACTION_SKIPPED', `Skipped – "${action.run_if.action}" was not ${action.run_if.is}`, action.key);
                Object.assign(action, { status: 'SKIPPED', skip_reason: 'condition' });
                continue;
              }
            }
            const scope = this.#templateScope(execution, actions, action);

            // "Repeat for each": expand into one row per item; the rows run in parallel within this step
            if (action.for_each && !action.parent_id) {
              let list: unknown;
              try {
                list = resolveTemplates(action.for_each, scope);
              } catch (error) {
                if (!(error instanceof TemplateError)) throw error;
                await fail(action, error.message, 'TEMPLATE_ERROR');
                continue;
              }
              if (!Array.isArray(list)) {
                await fail(action, `"repeat for each" needs a list, ${action.for_each} is ${list === null ? 'null' : typeof list}`, 'INVALID_PARAMS');
                continue;
              }
              if (list.length > MAX_LOOP_ITEMS) {
                await fail(action, `"repeat for each" is limited to ${MAX_LOOP_ITEMS} items, the list has ${list.length}`, 'INPUT_TOO_LARGE');
                continue;
              }
              actions.push(...(await insertLoopActions(client, action, list)));
              // no resolved params of its own: the children carry the real ones, the parent keeps its template
              const output = { count: list.length };
              await markActionCompleted(client, action.id, output, ENGINE);
              await appendLog(client, execution.id, 'LOOP_EXPANDED', `Repeats for ${list.length} item(s)`, action.key);
              Object.assign(action, { status: 'COMPLETED', output, processed_by: ENGINE });
              continue;
            }

            // a test run tries only what can't change anything
            if (execution.kind === 'test' && !runsInTest((await this.#catalog()).capability(action.type))) {
              await markActionSkipped(client, action.id, 'test');
              await appendLog(client, execution.id, 'ACTION_SKIPPED', `Skipped – ${action.type} doesn't run in a test`, action.key);
              Object.assign(action, { status: 'SKIPPED', skip_reason: 'test' });
              continue;
            }

            let params: Record<string, unknown>;
            try {
              params = resolveTemplates(action.params, scope) as Record<string, unknown>;
            } catch (error) {
              if (!(error instanceof TemplateError)) throw error;
              await fail(action, error.message, 'TEMPLATE_ERROR');
              continue;
            }

            // A function call: start the other routine and wait – its end completes this step (see #reportToCaller).
            if (action.type === 'routine.run') {
              const targetId = typeof params.routineId === 'string' && UUID.test(params.routineId) ? params.routineId : null;
              const target = targetId ? await getRoutine(client, execution.owner_id, targetId) : null;
              if (!target) {
                await fail(action, 'the routine to run does not exist (any more)', 'REFERENCE_GONE');
                continue;
              }
              if (execution.call_depth >= MAX_CALL_DEPTH) {
                await fail(action, `routines can call each other at most ${MAX_CALL_DEPTH} levels deep`, 'SUBROUTINE_FAILED');
                continue;
              }
              await markActionDispatched(client, action.id, params);
              const started = await this.createExecution(client, target, {
                type: 'routine',
                payload: { input: params.input ?? null },
                parent: { actionId: action.id, executionId: execution.id, depth: execution.call_depth + 1 },
              });
              await appendLog(client, execution.id, 'ACTION_DISPATCHED', `Calls routine "${target.name}" (${started?.execution.id ?? '?'})`, action.key);
              Object.assign(action, { status: 'DISPATCHED', dispatched_at: new Date() });
              continue;
            }

            // "Wait": the step sleeps until its time (housekeeping wakes it); a test run doesn't wait
            if (action.type === 'flow.wait') {
              let until: Date;
              try {
                until = execution.kind === 'test' ? new Date() : wakeAt(params, new Date(), DEFAULT_TIMEZONE);
              } catch (error) {
                if (!(error instanceof ControlError)) throw error;
                await fail(action, error.message, 'INVALID_PARAMS');
                continue;
              }
              if (execution.kind === 'test') {
                await markActionDispatched(client, action.id, params);
                const output = { wokeAt: until.toISOString() };
                await markActionCompleted(client, action.id, output, ENGINE);
                await appendLog(client, execution.id, 'ACTION_COMPLETED', 'A test does not wait', action.key);
                Object.assign(action, { status: 'COMPLETED', output, processed_by: ENGINE });
                continue;
              }
              await markActionScheduled(client, action.id, params, until);
              await appendLog(client, execution.id, 'ACTION_SCHEDULED', `Waits until ${until.toISOString()}`, action.key);
              Object.assign(action, { status: 'SCHEDULED', wake_at: until, dispatched_at: new Date() });
              continue;
            }

            // Scripting actions are computed right here, inside this transaction – no broker round trip.
            if (CONTROL_ACTION_TYPES.has(action.type)) {
              await markActionDispatched(client, action.id, params);
              let output: Record<string, unknown>;
              try {
                output = evaluateControlAction(action.type, params);
              } catch (error) {
                if (!(error instanceof ControlError)) throw error;
                await fail(action, error.message, 'INVALID_PARAMS');
                continue;
              }
              await markActionCompleted(client, action.id, output, ENGINE);
              await appendLog(client, execution.id, 'ACTION_COMPLETED', `${action.type} evaluated by the routine engine`, action.key);
              Object.assign(action, { status: 'COMPLETED', output, processed_by: ENGINE });
              continue;
            }
            toSend.push({ action, params });
          }

          // a failure in this step ends the run – nothing more goes to the workers
          if (batch.some((action) => action.status === 'FAILED')) continue;

          for (const { action, params } of toSend) {
            await markActionDispatched(client, action.id, params);
            await enqueue(
              client,
              actionRequested({
                actionId: action.id,
                executionId: execution.id,
                routineId: execution.routine_id,
                ownerId: execution.owner_id,
                actionKey: action.key,
                actionType: action.type,
                params,
                context: {
                  mode: execution.kind,
                  routineName: execution.routine_name,
                  stepIndex: action.step,
                  stepCount: Math.max(...actions.map((candidate) => candidate.step)),
                  depth: 0,
                },
                correlationId: execution.correlation_id,
              }),
            );
            await appendLog(client, execution.id, 'ACTION_DISPATCHED', `${action.type} handed to the broker`, action.key);
            Object.assign(action, { status: 'DISPATCHED', dispatched_at: new Date() });
          }
          await updateExecutionStatus(client, execution.id, 'RUNNING', { currentStep: decision.step });
          execution.status = 'RUNNING';
          if (toSend.length === 0) continue; // handled entirely here (skipped, scripting, expanded loop) → on to what is next
          this.#logger.info({ executionId: execution.id, step: decision.step, actions: toSend.map(({ action }) => action.key) }, 'step dispatched');
          return;
        }

        case 'complete': {
          await updateExecutionStatus(client, execution.id, 'COMPLETED');
          await appendLog(client, execution.id, 'COMPLETED', 'All actions completed successfully');
          // a test run is scratch paper: no health, no events
          if (execution.kind === 'test') return;
          await recordRunOutcome(client, execution.routine_id, 'COMPLETED');
          const durationMs = Date.now() - (execution.started_at ?? execution.created_at).getTime();
          await enqueue(
            client,
            executionCompleted(
              {
                executionId: execution.id,
                routineId: execution.routine_id,
                ownerId: execution.owner_id,
                routineName: execution.routine_name,
                correlationId: execution.correlation_id,
                durationMs,
              },
              this.#options.completionEventFormat,
            ),
          );
          await this.#reportToCaller(client, execution, { ok: true, output: { executionId: execution.id, ...subRoutineOutput(actions) } });
          this.#logger.info({ executionId: execution.id, durationMs, eventFormat: this.#options.completionEventFormat }, 'execution completed');
          return;
        }

        case 'fail': {
          const failed = actions.find((action) => action.key === decision.failedKey);
          const reason = `Action "${decision.failedKey}" failed: ${failed?.error ?? 'unknown error'}`;
          await skipPendingActions(client, execution.id);
          await updateExecutionStatus(client, execution.id, 'FAILED', { error: reason });
          await appendLog(client, execution.id, 'FAILED', reason);
          if (execution.kind === 'test') return;
          await enqueue(
            client,
            executionFailed({
              executionId: execution.id,
              routineId: execution.routine_id,
              ownerId: execution.owner_id,
              routineName: execution.routine_name,
              reason,
              failedActionKey: decision.failedKey,
              failedActionType: failed?.type ?? null,
              errorCode: failed?.error_code ?? null,
              resumeCount: execution.resume_count,
              correlationId: execution.correlation_id,
            }),
          );
          // health: once per streak, when the failures in a row reach the routine's threshold
          const health = await recordRunOutcome(client, execution.routine_id, 'FAILED');
          if (health && health.alert_after_failures !== null && health.consecutive_failures === health.alert_after_failures) {
            await enqueue(
              client,
              routineUnhealthy({
                routineId: execution.routine_id,
                ownerId: execution.owner_id,
                routineName: health.name,
                consecutiveFailures: health.consecutive_failures,
                lastErrorCode: failed?.error_code ?? null,
                executionId: execution.id,
                correlationId: execution.correlation_id,
              }),
            );
            this.#logger.warn({ routineId: execution.routine_id, consecutiveFailures: health.consecutive_failures }, 'routine unhealthy');
          }
          // a failure that came up from a deeper call already names its routine – pass it on as it is
          const error = failed?.type === 'routine.run' && failed.error ? failed.error : `Routine "${execution.routine_name}": ${failed?.error ?? 'unknown error'}`;
          await this.#reportToCaller(client, execution, { ok: false, error });
          this.#logger.warn({ executionId: execution.id, reason }, 'execution failed');
          return;
        }

        case 'wait': {
          const status = inFlightStatus(
            actions.map((action) => ({ key: action.key, step: action.step, status: action.status, dispatchedAt: action.dispatched_at })),
            new Date(),
            this.#options.waitingAfterMs,
          );
          if (status !== execution.status) {
            await updateExecutionStatus(client, execution.id, status);
            await appendLog(client, execution.id, status, IN_FLIGHT_LOG[status]);
            execution.status = status;
            // entering "Waiting for you" is worth telling (push from M8) – staying in it is not
            if (status === 'WAITING_FOR_YOU' && execution.kind === 'live') {
              const awaiting = actions.filter((action) => action.status === 'AWAITING_USER' && action.awaiting);
              await enqueue(
                client,
                executionWaitingForYou({
                  executionId: execution.id,
                  routineId: execution.routine_id,
                  ownerId: execution.owner_id,
                  routineName: execution.routine_name,
                  awaiting: awaiting.map((action) => ({ actionKey: action.key, ...(action.awaiting as NonNullable<typeof action.awaiting>), dueAt: action.deadline_at?.toISOString() ?? null })),
                  correlationId: execution.correlation_id,
                }),
              );
            }
          }
          return;
        }
      }
    }
  }

  /** A routine called by a routine.run step answers that step, through the outbox like any worker result. */
  async #reportToCaller(
    client: PoolClient,
    execution: ExecutionRow,
    outcome: { ok: true; output: Record<string, unknown> } | { ok: false; error: string },
  ): Promise<void> {
    if (!execution.parent_action_id || !execution.parent_execution_id) return;
    await enqueue(
      client,
      subRoutineResult({ actionId: execution.parent_action_id, executionId: execution.parent_execution_id, correlationId: execution.correlation_id, outcome }),
    );
  }

  /** What `{{…}}` can see when `action` is dispatched. */
  #templateScope(execution: ExecutionRow, actions: ExecutionActionRow[], action: ExecutionActionRow): TemplateScope {
    const done = actions.filter((candidate) => candidate.status === 'COMPLETED');
    const outputs: Record<string, unknown> = {};
    for (const candidate of done) {
      if (candidate.parent_id) continue;
      if (candidate.for_each) {
        // a loop step exposes what each repetition produced, in item order
        const children = actions.filter((child) => child.parent_id === candidate.id).sort((a, b) => (a.loop_index ?? 0) - (b.loop_index ?? 0));
        outputs[candidate.key] = { ...(candidate.output ?? {}), items: children.map((child) => child.output ?? null) };
      } else {
        outputs[candidate.key] = candidate.output ?? {};
      }
    }
    const vars = variablesOf(actions);
    return {
      routine: { id: execution.routine_id, name: execution.routine_name },
      execution: {
        id: execution.id,
        trigger: execution.trigger_type,
        startedAt: (execution.started_at ?? new Date()).toISOString(),
      },
      trigger: { type: execution.trigger_type, body: execution.trigger_payload ?? {} },
      actions: outputs,
      vars,
      ...(action.loop_index !== null && action.loop_index !== undefined ? { item: action.loop_item, index: action.loop_index } : {}),
      // a called routine reads what its caller passed (v1), a routine run by hand its answers
      ...(execution.trigger_type === 'routine'
        ? { input: (execution.trigger_payload as { input?: unknown } | null)?.input ?? null }
        : execution.inputs
          ? { input: execution.inputs }
          : {}),
      now: new Date().toISOString(),
    };
  }
}
