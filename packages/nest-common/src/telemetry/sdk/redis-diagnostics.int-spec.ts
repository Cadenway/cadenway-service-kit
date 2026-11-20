import type http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

import type * as NestPlatformExpress from '@nestjs/platform-express';
import { trace } from '@opentelemetry/api';
import type { Redis } from 'ioredis';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { startCollector } from '../../testing/otlp-collector.js';
import { startTelemetry } from './start-telemetry.js';
import { shutdownTelemetry } from './telemetry-handle.js';

let container: StartedTestContainer | undefined;

beforeAll(async () => {
  container = await new GenericContainer('redis:8.10.3-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/u))
    .start();
});

afterAll(async () => {
  await container?.stop();
});

it('exports command names and correlated error spans without Redis arguments', async () => {
  if (container === undefined) throw new Error('The Redis fixture is unavailable.');
  const collector = await startCollector();
  vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', collector.url);
  let redis: Redis | undefined;
  let server: http.Server | undefined;
  try {
    const telemetry = startTelemetry({
      service: 'sample-service',
      redactRedisCommandArguments: true,
    });
    // Load the libraries under the instrumentation hooks after the SDK starts.
    const runtimeRequire = createRequire(import.meta.url);
    const RedisClient = runtimeRequire('ioredis') as typeof Redis;
    const httpClient = runtimeRequire('http') as typeof http;
    const requireFromExpressAdapter = createRequire(
      runtimeRequire.resolve('@nestjs/platform-express'),
    );
    const createExpress = requireFromExpressAdapter('express') as () => unknown;
    const { ExpressAdapter } = runtimeRequire(
      '@nestjs/platform-express',
    ) as typeof NestPlatformExpress;
    const express = new ExpressAdapter(createExpress());
    const client = new RedisClient({
      host: container.getHost(),
      port: container.getMappedPort(6379),
      lazyConnect: true,
    });
    redis = client;
    await client.connect();
    const key = 'fixture-private-redis-key';
    const argument = 'fixture-private-redis-argument';
    const errorArgument = 'fixture-private-redis-reply';
    const script = await client.script('LOAD', 'return ARGV[1]');
    const errorScript = await client.script('LOAD', "return redis.error_reply('ERR ' .. ARGV[1])");
    if (typeof script !== 'string' || typeof errorScript !== 'string') {
      throw new Error('The Redis fixture did not load both scripts.');
    }
    express.get(
      '/redis-error',
      async (_request: IncomingMessage, response: ServerResponse, next?: unknown) => {
        try {
          await client.evalsha(errorScript, 1, key, errorArgument);
          response.writeHead(200).end();
        } catch (error) {
          if (typeof next !== 'function') throw error;
          (next as (error: unknown) => void)(error);
        }
      },
    );
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
        response.writeHead(503).end();
      },
    );
    const httpServer = httpClient.createServer(express.getInstance<http.RequestListener>());
    server = httpServer;
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${String((httpServer.address() as AddressInfo).port)}`;

    const parent = await trace.getTracer('test').startActiveSpan('redis-request', async (span) => {
      try {
        expect(await client.incr(key)).toBe(1);
        expect(await client.evalsha(script, 1, key, argument)).toBe(argument);
        expect(
          await client.eval('return ARGV[1] -- fixture-private-redis-script', 1, key, argument),
        ).toBe(argument);
        await expect(client.evalsha(errorScript, 1, key, errorArgument)).rejects.toThrow(
          errorArgument,
        );
        const response = await fetch(`${origin}/redis-error`);
        expect(response.status).toBe(503);
        await response.text();
        return span.spanContext();
      } finally {
        span.end();
      }
    });
    await telemetry.shutdown();

    const traceBodies = collector.received.get('/v1/traces') ?? [];
    const spans = traceBodies.flatMap((body) => {
      const batch = JSON.parse(body) as {
        resourceSpans: {
          scopeSpans: {
            scope: { name: string };
            spans: {
              name: string;
              traceId: string;
              parentSpanId?: string;
              status: { code: number; message?: string };
              attributes: { key: string; value: { stringValue?: string } }[];
              events?: { name: string }[];
            }[];
          }[];
        }[];
      };
      return batch.resourceSpans.flatMap(({ scopeSpans }) =>
        scopeSpans.flatMap(({ scope, spans: observed }) =>
          observed.map((span) => ({ ...span, scope: scope.name })),
        ),
      );
    });
    for (const operation of ['incr', 'eval']) {
      const command = spans.find((span) => span.name === operation);
      expect(command).toMatchObject({
        traceId: parent.traceId,
        parentSpanId: parent.spanId,
      });
      expect(command?.attributes).toContainEqual({
        key: 'db.query.text',
        value: { stringValue: operation },
      });
    }
    const failedRedis = spans.find(
      (span) => span.scope === '@opentelemetry/instrumentation-ioredis' && span.status.code === 2,
    );
    expect(failedRedis).toMatchObject({
      name: 'evalsha',
      traceId: parent.traceId,
      status: { code: 2 },
    });
    for (const key of ['db.operation.name', 'db.query.text']) {
      expect(failedRedis?.attributes).toContainEqual({ key, value: { stringValue: 'evalsha' } });
    }
    expect(failedRedis?.events?.some((event) => event.name === 'exception')).toBe(true);
    const failedRoute = spans.find(
      (span) => span.scope === '@opentelemetry/instrumentation-express' && span.status.code === 2,
    );
    expect(failedRoute).toMatchObject({
      traceId: parent.traceId,
      status: { code: 2 },
    });
    expect(failedRoute?.events?.some((event) => event.name === 'exception')).toBe(true);
    expect(failedRedis?.status.message).toBeUndefined();
    expect(failedRoute?.status.message).toBeUndefined();
    expect(traceBodies.join('')).not.toContain('fixture-private-redis-');
    const metrics = (collector.received.get('/v1/metrics') ?? []).join('');
    expect(metrics).toContain('http.server.request.duration');
    expect(metrics).not.toContain('fixture-private-redis-');
  } finally {
    redis?.disconnect();
    await shutdownTelemetry();
    vi.unstubAllEnvs();
    await collector.close();
    if (server !== undefined) {
      const httpServer = server;
      await new Promise<void>((resolve) =>
        httpServer.close(() => {
          resolve();
        }),
      );
    }
  }
});
