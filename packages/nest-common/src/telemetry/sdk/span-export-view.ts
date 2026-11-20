import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';

/**
 * Type ExportFields
 *
 * @description
 * Diagnostic fields that can be sanitized without changing trace identity.
 *
 * @type {Pick<ReadableSpan, 'name' | 'status' | 'attributes' | 'events' | 'links'>}
 */
type ExportFields = Pick<ReadableSpan, 'name' | 'status' | 'attributes' | 'events' | 'links'>;

/**
 * Function spanForExport
 *
 * @description
 * Copies the public ended-span view, including SDK getters and trace context, for export only.
 *
 * @param {ReadableSpan} span - Ended SDK span.
 * @param {Partial<ExportFields>} fields - Sanitized diagnostic fields.
 * @returns {ReadableSpan} Independent export view of the span.
 */
export function spanForExport(span: ReadableSpan, fields: Partial<ExportFields>): ReadableSpan {
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
    status: span.status,
    attributes: span.attributes,
    events: span.events,
    links: span.links,
    ...fields,
  };
}

/**
 * Function mapSpanExports
 *
 * @description
 * Transforms ended spans while preserving the transport's flush and shutdown behavior.
 *
 * @param {SpanExporter} exporter - Transport used for these spans.
 * @param {(span: ReadableSpan) => ReadableSpan} transform - Diagnostic transformation.
 * @returns {SpanExporter} Exporter that sends the transformed view of each span.
 */
export function mapSpanExports(
  exporter: SpanExporter,
  transform: (span: ReadableSpan) => ReadableSpan,
): SpanExporter {
  return {
    export: (spans, callback) => {
      exporter.export(spans.map(transform), callback);
    },
    forceFlush: () => exporter.forceFlush?.() ?? Promise.resolve(),
    shutdown: () => exporter.shutdown(),
  };
}
