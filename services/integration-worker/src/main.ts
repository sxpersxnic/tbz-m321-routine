import { join } from 'node:path';
import {
  Broker,
  createHttpServer,
  createLogger,
  createPool,
  env,
  envFloat,
  envInt,
  envList,
  instanceId,
  onShutdown,
  runMigrations,
  TransientError,
  waitForDatabase,
  withContext,
  type Envelope,
} from '@routine/service-kit';
import { executeAction, type ActionEnvironment } from './actions.ts';
import {
  actionCompleted,
  actionFailed,
  actionRef,
  actionRetryScheduled,
  parseActionRequested,
  RESULTS_EXCHANGE,
  type ActionCommand,
} from './messages.ts';

const SERVICE = 'integration-worker';
const PROCESSED_BY = `${SERVICE}@${instanceId}`;
const logger = createLogger(SERVICE);

const settings = {
  externalApiUrl: env('EXTERNAL_API_URL', 'http://mock-external:8090'),
  allowedHosts: envList('HTTP_ALLOWED_HOSTS', ['mock-external']),
  timeoutMs: envInt('ACTION_TIMEOUT_MS', 10_000),
  leaseSeconds: envInt('ACTION_LEASE_SECONDS', 60),
};

const pool = createPool(env('DATABASE_URL'));
await waitForDatabase(pool, logger);
await runMigrations(pool, join(import.meta.dirname, '..', 'migrations'), logger);
const broker = new Broker(env('AMQP_URL'), logger);

type Claim = { kind: 'claimed' } | { kind: 'completed'; output: Record<string, unknown> } | { kind: 'busy' };

/**
 * Idempotency across replicas: a replica may only execute an action it has
 * claimed. A completed action is never executed twice; an action currently
 * leased by another replica is retried later.
 */
async function claim(command: ActionCommand): Promise<Claim> {
  const claimed = await pool.query(
    `INSERT INTO action_executions (action_id, execution_id, action_type, status, processed_by, lease_until)
     VALUES ($1, $2, $3, 'IN_PROGRESS', $4, now() + make_interval(secs => $5))
     ON CONFLICT (action_id) DO UPDATE
        SET attempts = action_executions.attempts + 1,
            processed_by = EXCLUDED.processed_by,
            lease_until = EXCLUDED.lease_until,
            updated_at = now()
      WHERE action_executions.status = 'IN_PROGRESS' AND action_executions.lease_until < now()
     RETURNING action_id`,
    [command.actionId, command.executionId, command.actionType, PROCESSED_BY, settings.leaseSeconds],
  );
  if (claimed.rowCount === 1) return { kind: 'claimed' };
  const { rows } = await pool.query<{ status: string; output: Record<string, unknown> }>(
    'SELECT status, output FROM action_executions WHERE action_id = $1',
    [command.actionId],
  );
  return rows[0]?.status === 'COMPLETED' ? { kind: 'completed', output: rows[0].output } : { kind: 'busy' };
}

const RESULT_ROUTING_KEYS: Record<string, string> = {
  ActionCompleted: 'action.completed',
  ActionFailed: 'action.failed',
  ActionRetryScheduled: 'action.retry-scheduled',
};

async function publishResult(envelope: Envelope<unknown>) {
  await broker.publish(RESULTS_EXCHANGE, RESULT_ROUTING_KEYS[envelope.type], envelope);
}

broker.consume(
  {
    queue: 'integration-worker.actions',
    // "fair dispatch": few unacked messages per replica, so load spreads over all replicas
    prefetch: envInt('PREFETCH', 1),
    retryDelaysMs: [1_000, 5_000, 15_000],
    chaosFailureRate: envFloat('CHAOS_FAILURE_RATE', 0),
    onRetry: async (envelope, { attempt, delayMs, error }) => {
      const ref = actionRef(envelope);
      if (ref) await publishResult(actionRetryScheduled(ref, error, attempt, delayMs, PROCESSED_BY));
    },
    onGiveUp: async (envelope, { attempt, error }) => {
      const ref = actionRef(envelope);
      if (ref) await publishResult(actionFailed(ref, error, attempt, PROCESSED_BY));
    },
  },
  async (envelope, context) => {
    const command = parseActionRequested(envelope);
    await withContext({ executionId: command.executionId, actionId: command.actionId }, async () => {
      const state = await claim(command);
      if (state.kind === 'completed') {
        logger.info({ actionType: command.actionType }, 'duplicate ActionRequested – already executed, stored result re-sent');
        await publishResult(actionCompleted(command, state.output, PROCESSED_BY, true));
        return;
      }
      if (state.kind === 'busy') throw new TransientError('action is currently processed by another replica');

      const started = Date.now();
      logger.info({ actionType: command.actionType, attempt: context.attempt }, 'executing action');
      try {
        const environment: ActionEnvironment = { ...settings, actionId: command.actionId };
        const output = await executeAction(command.actionType, command.params, environment);
        await pool.query(
          `UPDATE action_executions SET status = 'COMPLETED', output = $2, lease_until = NULL, updated_at = now() WHERE action_id = $1`,
          [command.actionId, JSON.stringify(output)],
        );
        logger.info({ actionType: command.actionType, durationMs: Date.now() - started }, 'action executed');
        await publishResult(actionCompleted(command, output, PROCESSED_BY, false));
      } catch (error) {
        // release the lease so the retry (on any replica) may claim it again
        await pool.query('UPDATE action_executions SET lease_until = now(), updated_at = now() WHERE action_id = $1', [command.actionId]);
        throw error;
      }
    });
  },
);

// Workers have no public API – only health endpoints for the orchestrator.
const app = createHttpServer({
  service: SERVICE,
  logger,
  readiness: {
    database: async () => void (await pool.query('SELECT 1')),
    broker: () => {
      if (!broker.isConnected()) throw new Error('not connected');
    },
  },
});
await app.listen({ host: '0.0.0.0', port: envInt('PORT', 3000) });
logger.info({ allowedHosts: settings.allowedHosts }, 'integration-worker ready');

onShutdown(logger, () => app.close(), () => broker.close(), () => pool.end());
