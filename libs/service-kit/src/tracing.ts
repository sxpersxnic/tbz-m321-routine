/**
 * OpenTelemetry bootstrap. Loaded before the service via `node --import`,
 * so http, undici (fetch), pg, amqplib and pino are instrumented. The amqplib
 * instrumentation propagates the W3C trace context through message headers,
 * which links spans of all services into one distributed trace in Jaeger.
 */
import { register } from 'node:module';
import { createAddHookMessageChannel } from 'import-in-the-middle';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { AmqplibInstrumentation } from '@opentelemetry/instrumentation-amqplib';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { NodeSDK } from '@opentelemetry/sdk-node';

const IGNORED_PATHS = /^\/(health|ready|favicon\.ico|assets\/|index\.html$|$)/;

if (process.env.OTEL_SDK_DISABLED !== 'true') {
  const { registerOptions, waitForAllMessagesAcknowledged } = createAddHookMessageChannel();
  register('import-in-the-middle/hook.mjs', import.meta.url, registerOptions);

  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) => IGNORED_PATHS.test(request.url ?? ''),
      }),
      new UndiciInstrumentation(),
      new AmqplibInstrumentation(),
      // Only record queries that belong to a request/message – not background polling.
      new PgInstrumentation({ requireParentSpan: true }),
      new PinoInstrumentation(),
    ],
  });
  sdk.start();
  await waitForAllMessagesAcknowledged();
}
