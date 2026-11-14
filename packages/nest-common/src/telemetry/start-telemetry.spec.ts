import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { context, ROOT_CONTEXT, trace, type Span } from '@opentelemetry/api';
import { RPCType, setRPCMetadata, type RPCMetadata } from '@opentelemetry/core';
import { of } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';

import { RouteNameInterceptor } from './route-name.interceptor.js';
import { startTelemetry, type TelemetryHandle } from './start-telemetry.js';
import { shutdownTelemetry } from './telemetry-handle.js';

/**
 * Interface Collector
 *
 * @description
 * Local HTTP server standing in for an OTLP collector.
 */
interface Collector {
  // #region Properties
  /**
   * Property url
   *
   * @description
   * Base URL to put in `OTEL_EXPORTER_OTLP_ENDPOINT`.
   *
   * @type {string}
   * @readonly
   */
  readonly url: string;

  /**
   * Property received
   *
   * @description
   * Bodies received so far, by request path.
   *
   * @type {Map<string, string[]>}
   * @readonly
   */
  readonly received: Map<string, string[]>;
  // #endregion

  // #region Methods
  /**
   * Method close
   *
   * @description
   * Stops the server.
   *
   * @returns {Promise<void>} Resolves once the server is closed.
   */
  close(): Promise<void>;
  // #endregion
}

/**
 * Function startCollector
 *
 * @description
 * Starts a local server that records every OTLP request and answers 200.
 *
 * @returns {Promise<Collector>} The running collector.
 */
async function startCollector(): Promise<Collector> {
  const received: Map<string, string[]> = new Map<string, string[]>();
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path: string = request.url ?? '';
      received.set(path, [...(received.get(path) ?? []), Buffer.concat(chunks).toString('utf8')]);
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const port: number = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * Function httpExecutionContext
 *
 * @description
 * Builds the part of a NestJS execution context the route interceptor reads.
 *
 * @param {object} request - Request the interceptor sees.
 * @returns {ExecutionContext} A minimal HTTP execution context.
 */
function httpExecutionContext(request: object): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/**
 * Constant next
 *
 * @description
 * Handler that completes at once, standing in for the rest of the pipeline.
 *
 * @type {CallHandler}
 */
const next: CallHandler = { handle: () => of(null) };

describe('startTelemetry', () => {
  afterEach(async () => {
    await shutdownTelemetry();
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  it('creates spans but exports nothing when no collector is configured', async () => {
    const handle: TelemetryHandle = startTelemetry({ service: 'sample-service', version: '1.2.3' });

    expect(handle.exporting).toBe(false);
    const span: Span = trace.getTracer('test').startSpan('work');
    expect(span.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/u);
    expect(span.spanContext().traceId).not.toBe('0'.repeat(32));
    span.end();
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it('returns the running handle on a second call', () => {
    const first: TelemetryHandle = startTelemetry({ service: 'sample-service', version: '1.2.3' });
    const second: TelemetryHandle = startTelemetry({ service: 'other', version: '9.9.9' });

    expect(second).toBe(first);
  });

  it('refuses a collector endpoint that is not an HTTP URL', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'collector:4318';

    expect(() => startTelemetry({ service: 'sample-service', version: '1.2.3' })).toThrow(
      /OTEL_EXPORTER_OTLP_ENDPOINT must be an http or https URL/u,
    );
  });

  it('exports spans with the service identity to the configured collector', async () => {
    const collector: Collector = await startCollector();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.url;
    try {
      const handle: TelemetryHandle = startTelemetry({
        service: 'sample-service',
        version: '1.2.3',
      });
      expect(handle.exporting).toBe(true);
      trace.getTracer('test').startSpan('exported-work').end();
      await handle.shutdown();

      const traces: string = (collector.received.get('/v1/traces') ?? []).join('');
      expect(traces).toContain('exported-work');
      expect(traces).toContain('sample-service');
      expect(traces).toContain('1.2.3');
    } finally {
      await collector.close();
    }
  });
});

describe('RouteNameInterceptor', () => {
  afterEach(async () => {
    await shutdownTelemetry();
  });

  it('names the server span after the matched route and hands the route to the instrumentation', () => {
    startTelemetry({ service: 'sample-service', version: '1.2.3' });
    const span: Span = trace.getTracer('test').startSpan('GET');
    const metadata: RPCMetadata = { type: RPCType.HTTP, span };

    context.with(setRPCMetadata(trace.setSpan(ROOT_CONTEXT, span), metadata), () => {
      new RouteNameInterceptor().intercept(
        httpExecutionContext({ method: 'GET', route: { path: '/internal/v1/tasks/:taskId' } }),
        next,
      );
    });

    expect(metadata.route).toBe('/internal/v1/tasks/:taskId');
    expect(span).toMatchObject({
      name: 'GET /internal/v1/tasks/:taskId',
      attributes: { 'http.route': '/internal/v1/tasks/:taskId' },
    });
    span.end();
  });

  it('leaves the span untouched when no route matched', () => {
    startTelemetry({ service: 'sample-service', version: '1.2.3' });
    const span: Span = trace.getTracer('test').startSpan('GET');
    const metadata: RPCMetadata = { type: RPCType.HTTP, span };

    context.with(setRPCMetadata(trace.setSpan(ROOT_CONTEXT, span), metadata), () => {
      new RouteNameInterceptor().intercept(
        httpExecutionContext({ method: 'GET', route: { path: '{/*splat}' } }),
        next,
      );
    });

    expect(metadata.route).toBeUndefined();
    expect(span).toMatchObject({ name: 'GET' });
    span.end();
  });
});
