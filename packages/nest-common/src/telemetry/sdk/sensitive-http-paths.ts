import type { Attributes, Span } from '@opentelemetry/api';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';

import { mapSpanExports, spanForExport } from './span-export-view.js';

/**
 * Constant REDACTED
 *
 * @description
 * Marker used in place of a confidential path tail or diagnostic.
 *
 * @type {string}
 */
const REDACTED: string = 'REDACTED';

/**
 * Constant REQUEST_PATH
 *
 * @description
 * Carries an already sanitized request path to the exporter even if URL parsing normalized the
 * original path before the instrumentation recorded it.
 *
 * @type {string}
 */
const REQUEST_PATH: string = 'cadenway.http.redacted_path';

/**
 * Constant PATH_ATTRIBUTES
 *
 * @description
 * Current and legacy OpenTelemetry attributes for a path or request URL.
 *
 * @type {ReadonlySet<string>}
 */
const PATH_ATTRIBUTES: ReadonlySet<string> = new Set([
  'http.target',
  'http.url',
  'url.full',
  'url.path',
]);

/**
 * Constant ROUTE_TEMPLATE
 *
 * @description
 * Recognizes a route parameter in a template without treating a question or fragment as a path.
 *
 * @type {RegExp}
 */
const ROUTE_TEMPLATE: RegExp = /\/:[a-z][a-z0-9_]*(?:\/|$)/iu;

/**
 * Function sensitiveHttpPaths
 *
 * @description
 * Prepares a case-insensitive matcher from literal, absolute path prefixes. The closing slash
 * bounds the last static segment and keeps adjacent unrelated routes outside the match.
 *
 * @param {readonly string[]} prefixes - Configured prefixes.
 * @returns {RegExp | undefined} A matcher, or no matcher when no prefixes are configured.
 * @throws {Error} When a prefix is not an absolute static path ending in a slash.
 */
export function sensitiveHttpPaths(prefixes: readonly string[]): RegExp | undefined {
  if (!prefixes.every((prefix) => /^(?:\/[a-z0-9_.~-]+)+\/$/iu.test(prefix))) {
    throw new Error(
      'Sensitive HTTP path prefixes must be absolute static paths ending in a slash.',
    );
  }
  if (prefixes.length === 0) return undefined;
  return new RegExp(prefixes.map((prefix) => prefix.replaceAll('.', '\\.')).join('|'), 'iu');
}

/**
 * Function markSensitiveHttpPath
 *
 * @description
 * Marks the span when the raw request target contains a configured path prefix. The marker
 * contains only the configured routing prefix and the redaction marker.
 *
 * @param {Span} span - Span created by HTTP instrumentation.
 * @param {RegExp} paths - Configured path matcher.
 * @param {string} target - Raw request URL or target from the instrumentation.
 */
export function markSensitiveHttpPath(span: Span, paths: RegExp, target: string): void {
  const rawPath = /^(?:https?:\/\/[^/?#]*)?(\/[^?#]*)/iu.exec(target)?.[1] ?? '';
  const match = paths.exec(rawPath);
  if (match?.index === 0) span.setAttribute(REQUEST_PATH, match[0] + REDACTED);
}

/**
 * Function redactText
 *
 * @description
 * Scrubs a path from trace diagnostics, including URLs quoted in exception messages.
 *
 * @param {RegExp} paths - Configured path matcher.
 * @param {string} value - Trace text to inspect.
 * @returns {string} Text without the matched path tail, when present.
 */
function redactText(paths: RegExp, value: string): string {
  const match = paths.exec(value);
  return match === null ? value : value.slice(0, match.index) + match[0] + REDACTED;
}

/**
 * Function redactAttributes
 *
 * @description
 * Scrubs URLs and any incidental copy with the configured prefix. On a matched request, the
 * original path marker also replaces any normalized path and query fields.
 *
 * @param {RegExp} paths - Configured path matcher.
 * @param {Attributes} attributes - Attributes of the span, event or link.
 * @param {string | undefined} requestPath - Sanitized path of the matched request, when known.
 * @returns {Attributes} Attributes safe to send to the exporter.
 */
function redactAttributes(
  paths: RegExp,
  attributes: Attributes,
  requestPath: string | undefined,
): Attributes {
  return Object.fromEntries(
    Object.entries(attributes).flatMap(([key, value]) => {
      if (key === REQUEST_PATH) return [];
      if (typeof value !== 'string') {
        const sanitized = Array.isArray(value)
          ? value.map((item: unknown) =>
              typeof item === 'string' ? redactText(paths, item) : item,
            )
          : value;
        return [[key, sanitized]];
      }
      if (key === 'http.route' && ROUTE_TEMPLATE.test(value)) return [[key, value]];
      if (requestPath !== undefined) {
        if (key === 'url.query' || key === 'exception.message' || key === 'exception.stacktrace') {
          return [[key, REDACTED]];
        }
        if (PATH_ATTRIBUTES.has(key)) {
          const url = URL.parse(value);
          return [[key, (url?.origin ?? '') + requestPath]];
        }
      }
      return [[key, redactText(paths, value)]];
    }),
  );
}

/**
 * Function redactSpan
 *
 * @description
 * Creates an export view of an ended span without changing SDK state, sampling, metrics or
 * propagated trace context. The export view copies only the public ReadableSpan fields, which
 * include getters and the span context method.
 *
 * @param {RegExp} paths - Configured path matcher.
 * @param {ReadableSpan} span - Ended SDK span.
 * @returns {ReadableSpan} Span with confidential path values removed.
 */
function redactSpan(paths: RegExp, span: ReadableSpan): ReadableSpan {
  const marker = span.attributes[REQUEST_PATH];
  const requestPath = typeof marker === 'string' ? marker : undefined;
  const route = span.attributes['http.route'];
  const hasRouteName =
    typeof route === 'string' &&
    ROUTE_TEMPLATE.test(route) &&
    span.name.endsWith(route) &&
    !paths.test(span.name.slice(0, -route.length));
  return spanForExport(span, {
    name: hasRouteName ? span.name : redactText(paths, span.name),
    status:
      span.status.message === undefined || requestPath !== undefined
        ? { code: span.status.code }
        : { ...span.status, message: redactText(paths, span.status.message) },
    attributes: redactAttributes(paths, span.attributes, requestPath),
    events: span.events.map((event) => ({
      ...event,
      name: redactText(paths, event.name),
      attributes:
        event.attributes === undefined
          ? undefined
          : redactAttributes(paths, event.attributes, requestPath),
    })),
    links: span.links.map((link) => ({
      ...link,
      attributes:
        link.attributes === undefined
          ? undefined
          : redactAttributes(paths, link.attributes, requestPath),
    })),
  });
}

/**
 * Function redactSensitiveHttpPathExports
 *
 * @description
 * Scrubs ended spans just before OTLP encoding, after all instrumentation has set its final
 * attributes. The wrapped exporter retains its queue flush and shutdown behavior.
 *
 * @param {SpanExporter} exporter - Transport used for these spans.
 * @param {RegExp} paths - Configured path matcher.
 * @returns {SpanExporter} Exporter that sends a sanitized view of each span.
 */
export function redactSensitiveHttpPathExports(
  exporter: SpanExporter,
  paths: RegExp,
): SpanExporter {
  return mapSpanExports(exporter, (span) => redactSpan(paths, span));
}
