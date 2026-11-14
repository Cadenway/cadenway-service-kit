import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { HealthCheckResult } from '@nestjs/terminus';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProblemFilter } from '../problem/problem.filter.js';
import {
  natsIndicator,
  postgresIndicator,
  redisIndicator,
  type HealthModuleOptions,
} from './health-indicators.js';
import { HealthModule } from './health.module.js';

/**
 * Constant healthyBody
 *
 * @description
 * Complete healthy response read by the orchestrator and dashboards.
 *
 * @type {HealthCheckResult}
 */
const healthyBody: HealthCheckResult = { status: 'ok', info: {}, error: {}, details: {} };

/**
 * Function startApp
 *
 * @description
 * Starts an application with the health module configured as given, behind the problem filter
 * as in a real service.
 *
 * @param {HealthModuleOptions | undefined} options - Readiness options; the bare module when absent.
 * @returns {Promise<INestApplication<App>>} The running application.
 */
async function startApp(options?: HealthModuleOptions): Promise<INestApplication<App>> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [options === undefined ? HealthModule : HealthModule.forRoot(options)],
  }).compile();
  const app: INestApplication<App> = moduleRef.createNestApplication();
  app.useGlobalFilters(new ProblemFilter());
  await app.init();
  return app;
}

describe('HealthModule', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await startApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers 200 on the liveness route', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200, healthyBody);
  });

  it('answers 200 on the readiness route', async () => {
    await request(app.getHttpServer()).get('/health/ready').expect(200, healthyBody);
  });
});

describe('HealthModule.forRoot', () => {
  it('answers 200 with each dependency up', async () => {
    const app: INestApplication<App> = await startApp({
      indicators: [
        postgresIndicator({ query: () => Promise.resolve({ rows: [] }) }),
        redisIndicator({ ping: () => Promise.resolve('PONG') }),
        natsIndicator({ isClosed: () => false, flush: () => Promise.resolve() }),
      ],
    });

    const response: Response = await request(app.getHttpServer()).get('/health/ready').expect(200);
    await app.close();

    expect(response.body).toMatchObject({
      status: 'ok',
      info: { postgres: { status: 'up' }, redis: { status: 'up' }, nats: { status: 'up' } },
      error: {},
    });
  });

  it('answers 503 with the Terminus body naming what is down, never why', async () => {
    const app: INestApplication<App> = await startApp({
      indicators: [
        postgresIndicator({
          query: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.12:5432 user=svc')),
        }),
        redisIndicator({ ping: () => Promise.resolve('PONG') }),
        natsIndicator({ isClosed: () => true, flush: () => Promise.resolve() }, 'events'),
      ],
    });

    const ready: Response = await request(app.getHttpServer()).get('/health/ready').expect(503);
    const live: Response = await request(app.getHttpServer()).get('/health/live').expect(200);
    await app.close();

    expect(ready.headers['content-type']).toMatch(/^application\/json/u);
    expect(ready.body).toEqual({
      status: 'error',
      info: { redis: { status: 'up' } },
      error: {
        postgres: { status: 'down', message: 'unreachable' },
        events: { status: 'down', message: 'unreachable' },
      },
      details: {
        redis: { status: 'up' },
        postgres: { status: 'down', message: 'unreachable' },
        events: { status: 'down', message: 'unreachable' },
      },
    });
    expect(live.body).toEqual(healthyBody);
  });

  it('counts a dependency that does not answer in time as down', async () => {
    const app: INestApplication<App> = await startApp({
      timeoutMs: 50,
      indicators: [redisIndicator({ ping: () => new Promise<never>(() => undefined) })],
    });

    const started: number = performance.now();
    const response: Response = await request(app.getHttpServer()).get('/health/ready').expect(503);
    const elapsed: number = performance.now() - started;
    await app.close();

    expect(response.body).toMatchObject({
      status: 'error',
      error: { redis: { status: 'down', message: 'timeout' } },
    });
    expect(elapsed).toBeLessThan(1000);
  });
});
