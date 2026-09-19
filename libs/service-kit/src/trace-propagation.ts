import { context, isSpanContextValid, propagation, ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';

/** Trace id of the active span, e.g. to link an execution to its trace in Jaeger. */
export function currentTraceId(): string | null {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return spanContext && isSpanContextValid(spanContext) ? spanContext.traceId : null;
}

/**
 * Runs `fn` inside a new active span. Used for work that does not start with an
 * incoming request or message (e.g. the scheduler), so it still gets a trace.
 */
export async function withSpan<T>(name: string, attributes: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  return trace.getTracer('routine').startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn();
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}

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
