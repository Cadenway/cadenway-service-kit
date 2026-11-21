import type { Attributes } from '@opentelemetry/api';
import type { SpanExporter } from '@opentelemetry/sdk-trace';
import { ATTR_URL_FULL, ATTR_URL_PATH } from '@opentelemetry/semantic-conventions';

import { mapSpanExports, spanForExport } from './span-export-view.js';

/**
 * Constant HTTP_URL_ATTRIBUTES
 *
 * @description
 * URL fields that can contain a query in stable and legacy HTTP traces.
 *
 * @type {readonly string[]}
 */
const HTTP_URL_ATTRIBUTES: readonly string[] = [
  ATTR_URL_FULL,
  ATTR_URL_PATH,
  'url.original',
  'http.url',
  'http.target',
];

/**
 * Constant HTTP_INSTRUMENTATIONS
 *
 * @description
 * Scopes whose free-form exceptions can repeat the URL.
 *
 * @type {ReadonlySet<string>}
 */
const HTTP_INSTRUMENTATIONS: ReadonlySet<string> = new Set([
  '@opentelemetry/instrumentation-http',
  '@opentelemetry/instrumentation-express',
  '@opentelemetry/instrumentation-undici',
]);

/**
 * Function withoutQuery
 *
 * @description
 * Removes a discrete query attribute and cuts query suffixes without decoding or normalizing
 * the remaining URL. A matched route template stays intact.
 *
 * @param {Attributes} attributes - Attributes to sanitize.
 * @returns {Attributes} Original or sanitized attributes.
 */
function withoutQuery(attributes: Attributes): Attributes {
  let sanitized: Attributes | undefined;
  if (Object.hasOwn(attributes, 'url.query')) {
    sanitized = { ...attributes };
    delete sanitized['url.query'];
  }
  for (const key of HTTP_URL_ATTRIBUTES) {
    const value = attributes[key];
    if (typeof value !== 'string') continue;
    const query = value.indexOf('?');
    if (query === -1) continue;
    sanitized ??= { ...attributes };
    sanitized[key] = value.slice(0, query);
  }
  return sanitized ?? attributes;
}

/**
 * Function redactHttpQueryExports
 *
 * @description
 * Removes queries from URL attributes after instrumentation finishes. Suppresses free-form
 * diagnostics from automatic HTTP spans, where an error can repeat the raw request target.
 *
 * @param {SpanExporter} exporter - Transport used for these spans.
 * @returns {SpanExporter} Exporter that sends sanitized spans without altering trace context.
 */
export function redactHttpQueryExports(exporter: SpanExporter): SpanExporter {
  return mapSpanExports(exporter, (span) => {
    const automaticHttp = HTTP_INSTRUMENTATIONS.has(span.instrumentationScope.name);
    return spanForExport(span, {
      status: automaticHttp ? { code: span.status.code } : span.status,
      attributes: withoutQuery(span.attributes),
      events: span.events.map((event) => {
        if (event.attributes === undefined) return event;
        const attributes = withoutQuery(event.attributes);
        if (!automaticHttp || event.name !== 'exception') return { ...event, attributes };
        const diagnostics = { ...attributes };
        delete diagnostics['exception.message'];
        delete diagnostics['exception.stacktrace'];
        return { ...event, attributes: diagnostics };
      }),
      links: span.links.map((link) =>
        link.attributes === undefined
          ? link
          : { ...link, attributes: withoutQuery(link.attributes) },
      ),
    });
  });
}
