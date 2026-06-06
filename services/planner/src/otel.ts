// Module: OpenTelemetry bootstrap for planner and hosted-agent processes.
// Exports: nothing; importing this file conditionally starts telemetry.
// Does: configures Node auto-instrumentation, OTLP trace/metric exporters, and
// shutdown flushing while filtering noisy broker polling calls.
// Why: lets worker.ts and agent.ts enable observability before their long-running
// loops or HTTP server start without duplicating telemetry setup.

import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const ignoredBackgroundPaths = [
  '/api/agent/',
  '/api/planner/next-intent',
  '/api/planner/next-readiness-job',
  '/api/planner/readiness-jobs/',
  '/api/state',
];

function isIgnoredBackgroundPath(path: string | undefined): boolean {
  return Boolean(path && ignoredBackgroundPaths.some((ignoredPath) => path.startsWith(ignoredPath)));
}

if (otlpEndpoint) {
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'calendar-planner-worker',
    traceExporter: new OTLPTraceExporter(),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-http': {
          ignoreOutgoingRequestHook: (request) => isIgnoredBackgroundPath(String(request.path ?? '')),
        },
        '@opentelemetry/instrumentation-undici': {
          ignoreRequestHook: (request) => isIgnoredBackgroundPath(request.path),
        },
      }),
    ],
  });

  try {
    sdk.start();
    console.log(`[otel] OpenTelemetry export enabled for ${process.env.OTEL_SERVICE_NAME ?? 'calendar-planner-worker'}.`);
  } catch (error) {
    console.error('[otel] failed to start OpenTelemetry SDK', error);
  }

  const shutdown = () => {
    void sdk.shutdown().catch((error) => {
      console.error('[otel] failed to stop OpenTelemetry SDK', error);
    });
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} else {
  console.warn('[otel] OTEL_EXPORTER_OTLP_ENDPOINT is not set; OpenTelemetry export is disabled.');
}
