import { hostname } from 'node:os';
import pino, { type Logger } from 'pino';
import { currentContext } from './context.ts';

export type { Logger };

/** Identifies a single replica, e.g. one of several scaled worker containers. */
export const instanceId = hostname();

/** Structured JSON logger; context fields (correlationId, executionId, …) are merged into every line. */
export function createLogger(service: string): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service, instance: instanceId },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    mixin: () => currentContext(),
  });
}
