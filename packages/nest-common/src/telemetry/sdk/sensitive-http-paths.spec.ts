import assert from 'node:assert/strict';
import type http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

import type * as NestPlatformExpress from '@nestjs/platform-express';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { expect, it, vi } from 'vitest';

import { startCollector } from '../../testing/otlp-collector.js';
import { startTelemetry } from './start-telemetry.js';
import { shutdownTelemetry } from './telemetry-handle.js';

/**
 * Function requestNodeHttp
 *
 * @description
 * Makes a Node HTTP request with the exact supplied target, including unusual path segments.
 *
 * @param {typeof http} httpClient - Node HTTP module loaded after instrumentation starts.
 * @param {string} origin - Address of the loopback fixture.
 * @param {string} path - Request target sent to the fixture.
 * @returns {Promise<number>} HTTP response status after consuming its body.
 */
function requestNodeHttp(httpClient: typeof http, origin: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpClient.request(origin, { path }, (response) => {
      response.resume().once('end', () => {
        resolve(response.statusCode ?? 0);
      });
    });
    request.once('error', reject);
    request.end();
  });
}

it('redacts both HTTP directions and fetch in OTLP while preserving trace propagation', async () => {
  const collector = await startCollector();
  vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'http/dup');
  vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', collector.url);
  const handle = startTelemetry({
    service: 'sample-service',
    version: '1.2.3',
    sensitiveHttpPathPrefixes: ['/public/share/', '/internal/share/'],
  });

  // Use the CommonJS load hook after starting the SDK. Unlike the application, Vitest does not
  // preload the OpenTelemetry ESM module hook.
  const runtimeRequire = createRequire(import.meta.url);
  const httpClient = runtimeRequire('http') as typeof http;
  const requireFromExpressAdapter = createRequire(
    runtimeRequire.resolve('@nestjs/platform-express'),
  );
  const createExpress = requireFromExpressAdapter('express') as () => unknown;
  const { ExpressAdapter } = runtimeRequire(
    '@nestjs/platform-express',
  ) as typeof NestPlatformExpress;
  const express = new ExpressAdapter(createExpress());
  express.get('/public/share/:key', () => {
    throw new Error('fixture-express-only fixture-contact-express@example.test');
  });
  express.use(
    (
      error: Error,
      _request: IncomingMessage,
      response: ServerResponse,
      next: (error: Error) => void,
    ) => {
      if (response.headersSent) {
        next(error);
        return;
      }
      response.writeHead(422).end();
    },
  );
  const expressHandler = express.getInstance<http.RequestListener>();
  const seen = new Map<string, string | string[] | undefined>();
  const server = httpClient.createServer((request, response) => {
    const target = request.url ?? '';
    seen.set(target, request.headers.traceparent);
    if (target.startsWith('/public/share/fixture-express-only')) {
      expressHandler(request, response);
      return;
    }
    const span = trace.getSpan(context.active());
    if (target.startsWith('/public/share/fixture-node-only?')) {
      span?.setAttribute('http.route', '/public/share/:key').updateName('GET /public/share/:key');
    }
    if (target.includes('/../')) {
      span?.recordException(new Error(`Fixture failed for ${target}`));
      span?.setStatus({ code: SpanStatusCode.ERROR, message: target });
      response.writeHead(404);
    }
    response.end('fixture');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  try {
    const nodePath = '/public/share/fixture-node-only?message=fixture-contact-node';
    const fallbackPath = '/PUBLIC/SHARE/../fixture-fallback-only?message=fixture-contact-fallback';
    const fetchPath =
      '/internal/share/fixture-fetch-only/submissions?message=fixture-contact-fetch';
    const expressPath = '/public/share/fixture-express-only';
    const unrelatedPath = '/public/shared/ordinary-route?message=ordinary-query';
    await expect(requestNodeHttp(httpClient, origin, nodePath)).resolves.toBe(200);
    await expect(requestNodeHttp(httpClient, origin, fallbackPath)).resolves.toBe(404);
    const fetched = await fetch(origin + fetchPath, {
      method: 'POST',
      body: JSON.stringify({ email: 'fixture-contact-body@example.test' }),
    });
    expect(fetched.status).toBe(200);
    await fetched.text();
    await expect(requestNodeHttp(httpClient, origin, expressPath)).resolves.toBe(422);
    await expect(requestNodeHttp(httpClient, origin, unrelatedPath)).resolves.toBe(200);
    expect([...seen.keys()]).toEqual([
      nodePath,
      fallbackPath,
      fetchPath,
      expressPath,
      unrelatedPath,
    ]);
    await handle.shutdown();

    const traceBodies = collector.received.get('/v1/traces') ?? [];
    const exportedSpans = traceBodies.flatMap((body) => {
      const batch = JSON.parse(body) as {
        resourceSpans: {
          scopeSpans: {
            spans: { kind: number; traceId: string; spanId: string; parentSpanId?: string }[];
          }[];
        }[];
      };
      return batch.resourceSpans.flatMap(({ scopeSpans }) =>
        scopeSpans.flatMap(({ spans }) => spans),
      );
    });
    for (const header of seen.values()) {
      assert(typeof header === 'string');
      expect(header).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u);
      const [, traceId, spanId] = header.split('-');
      expect(exportedSpans).toContainEqual(expect.objectContaining({ kind: 3, traceId, spanId }));
      expect(exportedSpans).toContainEqual(
        expect.objectContaining({ kind: 2, traceId, parentSpanId: spanId }),
      );
    }
    const spans = traceBodies.join('');
    expect(spans).toContain('"name":"@opentelemetry/instrumentation-http"');
    expect(spans).toContain('"name":"@opentelemetry/instrumentation-undici"');
    expect(spans).toContain('"name":"@opentelemetry/instrumentation-express"');
    expect(spans).toContain('GET /public/share/:key');
    expect(spans).toContain('/public/share/REDACTED');
    expect(spans).toContain('/PUBLIC/SHARE/REDACTED');
    expect(spans).toContain('/internal/share/REDACTED');
    expect(spans).toContain('/public/shared/ordinary-route');
    expect(spans).toContain('ordinary-query');
    expect(spans).not.toMatch(
      /fixture-(?:node-only|fallback-only|fetch-only|express-only|contact-)/u,
    );
    expect(spans).not.toContain('cadenway.http.redacted_path');

    const metrics = (collector.received.get('/v1/metrics') ?? []).join('');
    expect(metrics).toContain('http.server.request.duration');
    expect(metrics).not.toMatch(
      /fixture-(?:node-only|fallback-only|fetch-only|express-only|contact-)/u,
    );
  } finally {
    await shutdownTelemetry();
    vi.unstubAllEnvs();
    await collector.close();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
});
