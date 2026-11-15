import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import {
  Injectable,
  Module,
  type BeforeApplicationShutdown,
  type INestApplication,
  type LoggerService,
  type ModuleMetadata,
} from '@nestjs/common';
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
  type HealthIndicator,
  type HealthModuleOptions,
} from './health-indicators.js';
import { HealthModule } from './health.module.js';

/**
 * Interface LoggedCall
 *
 * @description
 * One call received by the recording logger.
 */
interface LoggedCall {
  // #region Properties
  /**
   * Property level
   *
   * @description
   * Method called, such as `warn`.
   *
   * @type {string}
   * @readonly
   */
  readonly level: string;

  /**
   * Property args
   *
   * @description
   * Arguments of the call, the context of the logger last.
   *
   * @type {unknown[]}
   * @readonly
   */
  readonly args: unknown[];
  // #endregion
}

/**
 * Constant shuttingDownBody
 *
 * @description
 * Readiness body answered while the application stops.
 *
 * @type {HealthCheckResult}
 */
const shuttingDownBody: HealthCheckResult = {
  status: 'error',
  info: {},
  error: { shutdown: { status: 'down', message: 'shutting down' } },
  details: { shutdown: { status: 'down', message: 'shutting down' } },
};

/**
 * Function recordingLogger
 *
 * @description
 * Builds a NestJS logger that records every call.
 *
 * @param {LoggedCall[]} calls - Array receiving the calls.
 * @returns {LoggerService} The logger.
 */
function recordingLogger(calls: LoggedCall[]): LoggerService {
  const record: (level: string) => (...args: unknown[]) => void =
    (level: string) =>
    (...args: unknown[]): void => {
      calls.push({ level, args });
    };
  return {
    log: record('log'),
    error: record('error'),
    warn: record('warn'),
    debug: record('debug'),
    verbose: record('verbose'),
    fatal: record('fatal'),
  };
}

/**
 * Function startWith
 *
 * @description
 * Starts an application importing the given modules, behind the problem filter as in a real
 * service, optionally with a recording logger.
 *
 * @param {ModuleMetadata['imports']} imports - Modules of the application.
 * @param {LoggerService | undefined} logger - Logger to install; the NestJS default when absent.
 * @returns {Promise<INestApplication<App>>} The initialized application.
 */
async function startWith(
  imports: ModuleMetadata['imports'],
  logger?: LoggerService,
): Promise<INestApplication<App>> {
  const moduleRef: TestingModule = await Test.createTestingModule({ imports }).compile();
  const app: INestApplication<App> = moduleRef.createNestApplication();
  if (logger !== undefined) {
    app.useLogger(logger);
  }
  app.useGlobalFilters(new ProblemFilter());
  await app.init();
  return app;
}

/**
 * Function urlOf
 *
 * @description
 * Base URL of an application that listens on an ephemeral port of the loopback interface.
 *
 * @param {INestApplication<App>} app - Listening application.
 * @returns {string} The base URL, without a trailing slash.
 */
function urlOf(app: INestApplication<App>): string {
  const address: AddressInfo = (
    app.getHttpServer() as unknown as { address(): AddressInfo }
  ).address();
  return `http://127.0.0.1:${String(address.port)}`;
}

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
  return startWith([options === undefined ? HealthModule : HealthModule.forRoot(options)]);
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

  it('logs the changes of readiness only, never the per-probe error of Terminus', async () => {
    let attempts: number = 0;
    const calls: LoggedCall[] = [];
    const app: INestApplication<App> = await startWith(
      [
        HealthModule.forRoot({
          indicators: [
            {
              name: 'redis',
              check: (): Promise<void> => {
                attempts += 1;
                return attempts <= 3
                  ? Promise.reject(new Error('connect ECONNREFUSED 10.0.0.12:6379'))
                  : Promise.resolve();
              },
            },
          ],
        }),
      ],
      recordingLogger(calls),
    );

    for (const status of [503, 503, 503, 200, 200]) {
      await request(app.getHttpServer()).get('/health/ready').expect(status);
    }
    await app.close();

    const health: LoggedCall[] = calls.filter((call) => call.args.at(-1) === 'Health');
    expect(health).toEqual([
      {
        level: 'warn',
        args: [{ dependencies: { redis: 'unreachable' } }, 'readiness down', 'Health'],
      },
      { level: 'log', args: ['readiness recovered', 'Health'] },
    ]);
    expect(calls.filter((call) => call.level === 'error')).toEqual([]);
    expect(JSON.stringify(calls)).not.toContain('ECONNREFUSED');
  });
});

describe('HealthModule.forRootAsync', () => {
  it('reaches a provider that is not global through its imports', async () => {
    const PROBE: unique symbol = Symbol('probe');

    /**
     * Class ProbeModule
     *
     * @description
     * Module exporting an indicator, not global.
     */
    @Module({
      providers: [
        { provide: PROBE, useValue: redisIndicator({ ping: () => Promise.resolve('PONG') }) },
      ],
      exports: [PROBE],
    })
    class ProbeModule {}

    const app: INestApplication<App> = await startWith([
      HealthModule.forRootAsync({
        imports: [ProbeModule],
        inject: [PROBE],
        useFactory: (indicator: HealthIndicator) => ({ indicators: [indicator] }),
      }),
    ]);

    const response: Response = await request(app.getHttpServer()).get('/health/ready').expect(200);
    await app.close();

    expect(response.body).toMatchObject({ status: 'ok', info: { redis: { status: 'up' } } });
  });
});

describe('HealthModule during the graceful stop', () => {
  it('answers 503 on readiness and 200 on liveness while the shutdown delay runs', async () => {
    const app: INestApplication<App> = await startWith([
      HealthModule.forRoot({ shutdownDelayMs: 400 }),
    ]);
    await app.listen(0, '127.0.0.1');
    const url: string = urlOf(app);
    expect((await fetch(`${url}/health/ready`)).status).toBe(200);

    const started: number = performance.now();
    const closing: Promise<void> = app.close();
    await delay(50);
    const ready: globalThis.Response = await fetch(`${url}/health/ready`);
    const live: globalThis.Response = await fetch(`${url}/health/live`);
    const readyBody: unknown = await ready.json();
    const liveBody: unknown = await live.json();
    await closing;
    const elapsed: number = performance.now() - started;

    expect(ready.status).toBe(503);
    expect(readyBody).toEqual(shuttingDownBody);
    expect(live.status).toBe(200);
    expect(liveBody).toMatchObject({ status: 'ok' });
    expect(elapsed).toBeGreaterThanOrEqual(390);
  });

  it('turns readiness down at the start of the shutdown with the bare module too', async () => {
    /**
     * Class SlowShutdown
     *
     * @description
     * Provider that holds the shutdown after the destroy hooks and before the listener closes,
     * as a resource that drains would.
     */
    @Injectable()
    class SlowShutdown implements BeforeApplicationShutdown {
      // #region Methods
      /**
       * Method beforeApplicationShutdown
       *
       * @description
       * Waits 300 milliseconds.
       *
       * @returns {Promise<void>} Resolves after the wait.
       */
      public async beforeApplicationShutdown(): Promise<void> {
        await delay(300);
      }
      // #endregion
    }

    /**
     * Class DrainingModule
     *
     * @description
     * Module hosting the slow shutdown.
     */
    @Module({ providers: [SlowShutdown] })
    class DrainingModule {}

    const app: INestApplication<App> = await startWith([HealthModule, DrainingModule]);
    await app.listen(0, '127.0.0.1');
    const url: string = urlOf(app);

    const closing: Promise<void> = app.close();
    await delay(50);
    const ready: globalThis.Response = await fetch(`${url}/health/ready`);
    const readyBody: unknown = await ready.json();
    const live: globalThis.Response = await fetch(`${url}/health/live`);
    await closing;

    expect(ready.status).toBe(503);
    expect(readyBody).toEqual(shuttingDownBody);
    expect(live.status).toBe(200);
  });

  it('does not slow the shutdown with the default delay', async () => {
    const app: INestApplication<App> = await startWith([HealthModule]);
    await app.listen(0, '127.0.0.1');
    expect((await fetch(`${urlOf(app)}/health/ready`)).status).toBe(200);

    const started: number = performance.now();
    await app.close();

    expect(performance.now() - started).toBeLessThan(250);
  });
});
