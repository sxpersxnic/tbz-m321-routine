import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request / per-message context. Every log line written while a context is
 * active automatically carries these fields (see logger mixin), which is what
 * makes a single execution traceable across all services.
 */
export interface LogContext {
  correlationId?: string;
  [key: string]: string | number | undefined;
}

const storage = new AsyncLocalStorage<LogContext>();

export function withContext<T>(fields: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...fields }, fn);
}

export function currentContext(): LogContext {
  return storage.getStore() ?? {};
}
