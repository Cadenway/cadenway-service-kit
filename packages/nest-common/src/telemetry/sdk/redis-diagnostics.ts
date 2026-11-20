import type { SpanExporter } from '@opentelemetry/sdk-trace';

import { mapSpanExports, spanForExport } from './span-export-view.js';

/**
 * Constant ERROR_SCOPES
 *
 * @description
 * Automatic instrumentation scopes that can capture a Redis error or propagate its details.
 *
 * @type {ReadonlySet<string>}
 */
const ERROR_SCOPES: ReadonlySet<string> = new Set([
  '@opentelemetry/instrumentation-ioredis',
  '@opentelemetry/instrumentation-http',
  '@opentelemetry/instrumentation-express',
  '@opentelemetry/instrumentation-undici',
]);

/**
 * Function redactRedisErrorExports
 *
 * @description
 * Removes free-form diagnostics where a Redis reply can repeat command arguments. Preserve the
 * failure status and exception occurrence for tracing and leave unrelated instrumentation intact.
 *
 * @param {SpanExporter} exporter - Transport used for these spans.
 * @returns {SpanExporter} Exporter that omits these error details.
 */
export function redactRedisErrorExports(exporter: SpanExporter): SpanExporter {
  return mapSpanExports(exporter, (span) => {
    if (!ERROR_SCOPES.has(span.instrumentationScope.name)) return span;
    if (
      span.status.message === undefined &&
      !span.events.some((event) => event.name === 'exception')
    ) {
      return span;
    }
    return spanForExport(span, {
      status: { code: span.status.code },
      events: span.events.map((event) =>
        event.name === 'exception' ? { ...event, attributes: undefined } : event,
      ),
    });
  });
}
