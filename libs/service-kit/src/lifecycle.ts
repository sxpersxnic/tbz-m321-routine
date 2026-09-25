import { setTimeout as sleep } from 'node:timers/promises';
import { errorMessage } from './errors.ts';
import type { Logger } from './logger.ts';

export type ShutdownStep = () => Promise<void> | void;

/** Runs the given steps in order on SIGTERM/SIGINT (docker stop) and exits. */
export function onShutdown(logger: Logger, ...steps: ShutdownStep[]): void {
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down gracefully');
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        logger.error({ err: errorMessage(error) }, 'shutdown step failed');
      }
    }
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

export interface Loop {
  stop(): Promise<void>;
}

/**
 * Runs `tick` repeatedly without overlapping. When `tick` returns true (there
 * was work), the next iteration starts immediately; otherwise it waits.
 */
export function startLoop(name: string, intervalMs: number, logger: Logger, tick: () => Promise<boolean | void>): Loop {
  let running = true;
  const done = (async () => {
    while (running) {
      let busy = false;
      try {
        busy = (await tick()) === true;
      } catch (error) {
        logger.error({ loop: name, err: errorMessage(error) }, 'background loop iteration failed');
        await sleep(Math.max(intervalMs, 1_000));
      }
      if (!busy && running) await sleep(intervalMs);
    }
  })();
  return {
    async stop() {
      running = false;
      await done;
    },
  };
}
