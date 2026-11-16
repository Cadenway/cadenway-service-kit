import {
  propagation,
  ROOT_CONTEXT,
  trace,
  TraceFlags,
  type Context,
  type SpanContext,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { contextFromTraceparent, currentTraceparent } from './trace-context.js';

/**
 * Constant TRACEPARENT
 *
 * @description
 * W3C trace context of the fixtures: a sampled span of a known trace.
 *
 * @type {string}
 */
const TRACEPARENT: string = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

describe('trace context', () => {
  beforeAll(() => {
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  });

  afterAll(() => {
    propagation.disable();
  });

  it('reads the traceparent of the span of a context', () => {
    const active: Context = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: TraceFlags.SAMPLED,
    });

    expect(currentTraceparent(active)).toBe(TRACEPARENT);
  });

  it('reads no traceparent from a context without a span', () => {
    expect(currentTraceparent(ROOT_CONTEXT)).toBeNull();
  });

  it('makes the span of a traceparent header the remote parent of a consumer span', () => {
    const parent: SpanContext | undefined = trace.getSpanContext(
      contextFromTraceparent(TRACEPARENT),
    );

    expect(parent).toMatchObject({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      isRemote: true,
    });
  });

  it.each([undefined, null, '', 'not-a-traceparent'])(
    'starts from the root context for the header %s',
    (header: string | null | undefined) => {
      expect(trace.getSpanContext(contextFromTraceparent(header))).toBeUndefined();
    },
  );
});
