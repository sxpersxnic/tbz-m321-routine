import { randomUUID } from 'node:crypto';
import { withContext, withTransaction, type Logger, type Pool } from '@routine/service-kit';
import { nextRun } from './domain/schedule.ts';
import type { ExecutionEngine } from './engine.ts';
import { lockDueRoutines, setNextRun } from './store.ts';

/**
 * Time-based trigger. Due routines are locked with SKIP LOCKED and every slot
 * is unique per routine, so any number of routine-service replicas can run the
 * scheduler without firing a slot twice. Missed slots (service was down) are
 * caught up once, then the schedule continues from "now".
 */
export class Scheduler {
  #pool: Pool;
  #engine: ExecutionEngine;
  #logger: Logger;

  constructor(pool: Pool, engine: ExecutionEngine, logger: Logger) {
    this.#pool = pool;
    this.#engine = engine;
    this.#logger = logger;
  }

  async tick(): Promise<boolean> {
    return withTransaction(this.#pool, async (client) => {
      const due = await lockDueRoutines(client, 20);
      for (const routine of due) {
        if (routine.trigger.type !== 'schedule' || !routine.next_run_at) {
          await setNextRun(client, routine.id, null);
          continue;
        }
        const slot = routine.next_run_at;
        await withContext({ correlationId: randomUUID(), routineId: routine.id }, async () => {
          const result = await this.#engine.createExecution(client, routine, { type: 'schedule', scheduledFor: slot });
          if (!result) this.#logger.info({ slot }, 'scheduled slot already executed');
        });
        const now = new Date();
        const following = nextRun(routine.trigger.cron, routine.trigger.timezone, slot > now ? slot : now);
        await setNextRun(client, routine.id, following);
      }
      return due.length > 0;
    });
  }
}
