import assert from 'node:assert/strict';
import type http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

import { SpanStatusCode, trace } from '@opentelemetry/api';
import { expect, it, vi } from 'vitest';

import { startCollector } from '../../testing/otlp-collector.js';
import { nameHttpSpan } from '../http/route-name.interceptor.js';
import { startTelemetry } from './start-telemetry.js';
import { shutdownTelemetry } from './telemetry-handle.js';

it('exports Node HTTP and fetch trace pairs without request queries or copied error descriptions', async () => {
  const collector = await startCollector();
  vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', collector.url);
  vi.stubEnv('CADENWAY_OTEL_REDACT_HTTP_QUERY_STRINGS', 'true');
  const handle = startTelemetry({ service: 'sample-service', version: '1.2.3' });
  const runtimeRequire = createRequire(import.meta.url);
  const nodeHttp = runtimeRequire('http') as typeof http;
  const seen = new Map<string, string | string[] | undefined>();
  const server = nodeHttp.createServer((request, response) => {
    const target = request.url ?? '';
    seen.set(target, request.headers.traceparent);
    nameHttpSpan('GET', '/usage/:name');
    if (target.startsWith('/usage/fetch?')) {
      const span = trace.getActiveSpan();
      span?.setStatus({ code: SpanStatusCode.ERROR, message: target });
      span?.recordException(new TypeError(target));
    }
    response.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  try {
    const nodePath = '/usage/node?cursor=fixture-private-cursor';
    const fetchPath = '/usage/fetch?code=fixture-private-code';
    await new Promise<void>((resolve, reject) => {
      nodeHttp
        .get(origin + nodePath, (response) => {
          response.resume().once('end', () => {
            resolve();
          });
        })
        .once('error', reject);
    });
    expect(await (await fetch(origin + fetchPath)).text()).toBe('ok');
    expect([...seen.keys()]).toEqual([nodePath, fetchPath]);
    trace
      .getTracer('legacy-fixture')
      .startSpan('legacy fixture', {
        attributes: {
          'http.url': `${origin}/legacy?cursor=fixture-private-legacy-url`,
          'http.target': '/legacy?cursor=fixture-private-legacy-target',
          'http.route': '/legacy/:name?',
        },
      })
      .addEvent('fixture', { 'url.query': 'cursor=fixture-private-event' })
      .end();

    await handle.shutdown();
    const traceBodies = collector.received.get('/v1/traces') ?? [];
    const spans = traceBodies.flatMap((body) => {
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
      const [, traceId, spanId] = header.split('-');
      expect(spans).toContainEqual(expect.objectContaining({ kind: 3, traceId, spanId }));
      expect(spans).toContainEqual(
        expect.objectContaining({ kind: 2, traceId, parentSpanId: spanId }),
      );
    }

    const exported = traceBodies.join('');
    expect(exported).toContain('"name":"@opentelemetry/instrumentation-undici"');
    expect(exported).toContain('"name":"GET /usage/:name"');
    expect(exported).toContain('"key":"http.request.method","value":{"stringValue":"GET"}');
    expect(exported).toContain('"key":"url.path","value":{"stringValue":"/usage/node"}');
    expect(exported).toContain('"key":"url.path","value":{"stringValue":"/usage/fetch"}');
    expect(exported).toContain(`"key":"url.full","value":{"stringValue":"${origin}/usage/node"}`);
    expect(exported).toContain(`"key":"url.full","value":{"stringValue":"${origin}/usage/fetch"}`);
    expect(exported).toContain(`"key":"http.url","value":{"stringValue":"${origin}/legacy"}`);
    expect(exported).toContain('"key":"http.target","value":{"stringValue":"/legacy"}');
    expect(exported).toContain('"key":"http.route","value":{"stringValue":"/legacy/:name?"}');
    expect(exported).toContain('"key":"exception.type","value":{"stringValue":"TypeError"}');
    expect(exported).not.toContain('"key":"url.query"');
    expect(exported).not.toContain('fixture-private-');
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
