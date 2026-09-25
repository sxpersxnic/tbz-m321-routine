import { randomUUID } from 'node:crypto';
import { currentContext, currentTraceId, withTransaction, type Logger, type Pool, type PoolClient } from '@routine/service-kit';
import { conditionMet, CONTROL_ACTION_TYPES, ControlError, evaluateControlAction } from './domain/control.ts';
import { decideNext, inFlightStatus, TERMINAL_ACTION_STATUSES, TERMINAL_EXECUTION_STATUSES } from './domain/progress.ts';
import type { ExecutionTrigger } from './domain/definition.ts';
import { resolveTemplates, TemplateError, type TemplateScope } from './domain/templates.ts';
import {
  actionRequested,
  executionCompleted,
  executionFailed,
  routineTriggered,
  subRoutineResult,
  type ActionResult,
  type CompletionEventFormat,
} from './messages.ts';
import { enqueue } from './outbox.ts';
import {
  appendLog,
  findExecutionByIdempotencyKey,
  getRoutine,
  insertExecution,
  insertExecutionActions,
  insertLoopActions,
  listExecutionActions,
  lockExecution,
  markActionCompleted,
  markActionDispatched,
  markActionFailed,
  markActionRetrying,
  markActionSkipped,
  markStaleExecutionsWaiting,
  skipPendingActions,
  updateExecutionStatus,
  type ExecutionActionRow,
  type ExecutionRow,
  type RoutineRow,
} from './store.ts';

export interface EngineOptions {
  completionEventFormat: CompletionEventFormat;
  waitingAfterMs: number;
}

export interface TriggerRequest {
  type: ExecutionTrigger;
  scheduledFor?: Date;
  idempotencyKey?: string;
  /** Body of a webhook call, or `{ input }` of a routine.run call. */
  payload?: Record<string, unknown>;
  /** The routine.run step that called this routine. */
  parent?: { actionId: string; executionId: string; depth: number };
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

/** `processed_by` of what the engine did itself (scripting actions, loop expansion). */
const ENGINE = 'routine-engine';
const MAX_LOOP_ITEMS = 50;
/** routine.run nesting: A → B → C … at most this deep, so a routine calling itself stops. */
const MAX_CALL_DEPTH = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TRIGGER_LOG: Record<ExecutionTrigger, (trigger: TriggerRequest) => string> = {
  manual: () => 'Started manually',
  routine: () => 'Called by another routine',
  schedule: (trigger) => `Started by schedule (${trigger.scheduledFor?.toISOString()})`,
  webhook: () => 'Started by webhook',
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

  constructor(pool: Pool, logger: Logger, options: EngineOptions) {
    this.#pool = pool;
    this.#logger = logger;
    this.#options = options;
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
        this.#logger.info({ actionKey: action.key, status: action.status, resultKind: result.kind }, 'duplicate result ignored (action already finished)');
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
          await markActionFailed(client, action.id, result.error, result.processedBy, result.attempts);
          await appendLog(client, execution.id, 'ACTION_FAILED', `Failed after ${result.attempts} attempt(s): ${result.error}`, action.key);
          Object.assign(action, { status: 'FAILED', error: result.error });
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
      }

      // Late results of a finished execution are recorded but change nothing else.
      if (TERMINAL_EXECUTION_STATUSES.has(execution.status)) return;
      await this.#advance(client, execution, actions);
    });
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
          const fail = async (action: ExecutionActionRow, message: string) => {
            await markActionFailed(client, action.id, message, null);
            await appendLog(client, execution.id, 'ACTION_FAILED', message, action.key);
            Object.assign(action, { status: 'FAILED', error: message });
          };

          for (const action of batch) {
            // "Only if": a step whose condition did not hold (or did not run) is skipped
            if (action.run_if) {
              const condition = actions.find((candidate) => candidate.key === action.run_if?.action);
              if (!condition || !conditionMet(condition, action.run_if.is)) {
                await markActionSkipped(client, action.id);
                await appendLog(client, execution.id, 'ACTION_SKIPPED', `Skipped – "${action.run_if.action}" was not ${action.run_if.is}`, action.key);
                action.status = 'SKIPPED';
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
                await fail(action, error.message);
                continue;
              }
              if (!Array.isArray(list)) {
                await fail(action, `"repeat for each" needs a list, ${action.for_each} is ${list === null ? 'null' : typeof list}`);
                continue;
              }
              if (list.length > MAX_LOOP_ITEMS) {
                await fail(action, `"repeat for each" is limited to ${MAX_LOOP_ITEMS} items, the list has ${list.length}`);
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

            let params: Record<string, unknown>;
            try {
              params = resolveTemplates(action.params, scope) as Record<string, unknown>;
            } catch (error) {
              if (!(error instanceof TemplateError)) throw error;
              await fail(action, error.message);
              continue;
            }

            // A function call: start the other routine and wait – its end completes this step (see #reportToCaller).
            if (action.type === 'routine.run') {
              const targetId = typeof params.routineId === 'string' && UUID.test(params.routineId) ? params.routineId : null;
              const target = targetId ? await getRoutine(client, execution.owner_id, targetId) : null;
              if (!target) {
                await fail(action, 'the routine to run does not exist (any more)');
                continue;
              }
              if (execution.call_depth >= MAX_CALL_DEPTH) {
                await fail(action, `routines can call each other at most ${MAX_CALL_DEPTH} levels deep`);
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

            // Scripting actions are computed right here, inside this transaction – no broker round trip.
            if (CONTROL_ACTION_TYPES.has(action.type)) {
              await markActionDispatched(client, action.id, params);
              let output: Record<string, unknown>;
              try {
                output = evaluateControlAction(action.type, params);
              } catch (error) {
                if (!(error instanceof ControlError)) throw error;
                await fail(action, error.message);
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
                correlationId: execution.correlation_id,
              }),
            );
            await appendLog(client, execution.id, 'ACTION_DISPATCHED', `${action.type} handed to the broker`, action.key);
            Object.assign(action, { status: 'DISPATCHED', dispatched_at: new Date() });
          }
          await updateExecutionStatus(client, execution.id, 'RUNNING', { currentStep: decision.step });
          if (toSend.length === 0) continue; // handled entirely here (skipped, scripting, expanded loop) → on to what is next
          this.#logger.info({ executionId: execution.id, step: decision.step, actions: toSend.map(({ action }) => action.key) }, 'step dispatched');
          return;
        }

        case 'complete': {
          await updateExecutionStatus(client, execution.id, 'COMPLETED');
          await appendLog(client, execution.id, 'COMPLETED', 'All actions completed successfully');
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
          await enqueue(
            client,
            executionFailed({
              executionId: execution.id,
              routineId: execution.routine_id,
              ownerId: execution.owner_id,
              routineName: execution.routine_name,
              reason,
              failedActionKey: decision.failedKey,
              correlationId: execution.correlation_id,
            }),
          );
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
            await appendLog(
              client,
              execution.id,
              status,
              status === 'WAITING' ? 'Waiting for an action to be retried' : 'Processing resumed',
            );
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
      ...(execution.trigger_type === 'routine' ? { input: (execution.trigger_payload as { input?: unknown } | null)?.input ?? null } : {}),
      now: new Date().toISOString(),
    };
  }
}
