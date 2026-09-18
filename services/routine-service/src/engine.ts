import { randomUUID } from 'node:crypto';
import { currentContext, currentTraceId, withTransaction, type Logger, type Pool, type PoolClient } from '@routine/service-kit';
import { decideNext, inFlightStatus, TERMINAL_ACTION_STATUSES, TERMINAL_EXECUTION_STATUSES } from './domain/progress.ts';
import type { TriggerType } from './domain/definition.ts';
import { resolveTemplates, TemplateError, type TemplateScope } from './domain/templates.ts';
import {
  actionRequested,
  executionCompleted,
  executionFailed,
  routineTriggered,
  type ActionResult,
  type CompletionEventFormat,
} from './messages.ts';
import { enqueue } from './outbox.ts';
import {
  appendLog,
  findExecutionByIdempotencyKey,
  insertExecution,
  insertExecutionActions,
  listExecutionActions,
  lockExecution,
  markActionCompleted,
  markActionDispatched,
  markActionFailed,
  markActionRetrying,
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
  type: TriggerType;
  scheduledFor?: Date;
  idempotencyKey?: string;
  /** Body of a webhook call. */
  payload?: Record<string, unknown>;
}

const TRIGGER_LOG: Record<TriggerType, (trigger: TriggerRequest) => string> = {
  manual: () => 'Started manually',
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
          const scope = this.#templateScope(execution, actions);
          const resolved = new Map<string, Record<string, unknown>>();
          let templateFailed = false;
          for (const action of batch) {
            try {
              resolved.set(action.id, resolveTemplates(action.params, scope) as Record<string, unknown>);
            } catch (error) {
              if (!(error instanceof TemplateError)) throw error;
              await markActionFailed(client, action.id, error.message, null);
              await appendLog(client, execution.id, 'ACTION_FAILED', error.message, action.key);
              Object.assign(action, { status: 'FAILED', error: error.message });
              templateFailed = true;
            }
          }
          if (templateFailed) continue; // re-evaluate → fail

          for (const action of batch) {
            const params = resolved.get(action.id) ?? {};
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
          this.#logger.info({ executionId: execution.id, step: decision.step, actions: decision.keys }, 'step dispatched');
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

  #templateScope(execution: ExecutionRow, actions: ExecutionActionRow[]): TemplateScope {
    return {
      routine: { id: execution.routine_id, name: execution.routine_name },
      execution: {
        id: execution.id,
        trigger: execution.trigger_type,
        startedAt: (execution.started_at ?? new Date()).toISOString(),
      },
      trigger: { type: execution.trigger_type, body: execution.trigger_payload ?? {} },
      actions: Object.fromEntries(
        actions.filter((action) => action.status === 'COMPLETED').map((action) => [action.key, action.output ?? {}]),
      ),
      now: new Date().toISOString(),
    };
  }
}
