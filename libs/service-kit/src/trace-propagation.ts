import { context, propagation, ROOT_CONTEXT } from '@opentelemetry/api';

/**
 * Serialises the active trace context (W3C traceparent) so it can be stored,
 * e.g. in an outbox row, and restored later by a different code path.
 */
export function captureTraceHeaders(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/** Runs `fn` as if it were still part of the trace captured in `headers`. */
export function runWithTraceHeaders<T>(headers: Record<string, string> | null | undefined, fn: () => T): T {
  return context.with(propagation.extract(ROOT_CONTEXT, headers ?? {}), fn);
}
