import { context, propagation, ROOT_CONTEXT, type Context } from '@opentelemetry/api';

import { TRACEPARENT_HEADER } from '../transport/event-headers.js';

/**
 * Function currentTraceparent
 *
 * @description
 * Reads the W3C `traceparent` of an OpenTelemetry context through the global propagator, the
 * one `@cadenway/nest-common/telemetry` registers.
 *
 * @param {Context} activeContext - Context to read; defaults to the active one.
 * @returns {string | null} The `traceparent`, or `null` when the context carries no span or no propagator is registered.
 */
export function currentTraceparent(activeContext: Context = context.active()): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(activeContext, carrier);
  return carrier[TRACEPARENT_HEADER] ?? null;
}

/**
 * Function contextFromTraceparent
 *
 * @description
 * Builds the OpenTelemetry context a consumer span is started in: the remote span named by a
 * `traceparent` header becomes its parent.
 *
 * @param {string | null | undefined} traceparent - Value of the `traceparent` header, when the message has one.
 * @returns {Context} A context whose span is the remote parent, or the root context without a usable header.
 */
export function contextFromTraceparent(traceparent: string | null | undefined): Context {
  if (traceparent === undefined || traceparent === null || traceparent === '') {
    return ROOT_CONTEXT;
  }
  return propagation.extract(ROOT_CONTEXT, { [TRACEPARENT_HEADER]: traceparent });
}
