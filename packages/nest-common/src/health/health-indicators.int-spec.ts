import { once } from 'node:events';

import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import pg from 'pg';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestDatabase, type TestDatabase } from '../testing/postgres.js';
import { postgresIndicator, redisIndicator } from './health-indicators.js';
import { HealthModule } from './health.module.js';

/**
 * Constant REDIS_IMAGE
 *
 * @description
 * Redis image of the integration specs: the tag cadenway-ops pins in `compose/infra.yaml`.
 *
 * @type {string}
 */
const REDIS_IMAGE: string = 'redis:8.10.3-alpine';

/**
 * Constant POOL_TOKEN
 *
 * @description
 * Injection token standing in for the database pool of an application.
 *
 * @type {symbol}
 */
const POOL_TOKEN: unique symbol = Symbol('pool');

/**
 * Constant holder
 *
 * @description
 * Pool created once the container runs, read by the provider below.
 *
 * @type {{ pool: pg.Pool | undefined }}
 */
const holder: { pool: pg.Pool | undefined } = { pool: undefined };

/**
 * Class PoolModule
 *
 * @description
 * Global module providing the pool, as `DatabaseModule` does in an application.
 */
@Global()
@Module({
  providers: [{ provide: POOL_TOKEN, useFactory: (): pg.Pool | undefined => holder.pool }],
  exports: [POOL_TOKEN],
})
class PoolModule {}

describe('health indicators on real dependencies', () => {
  let database: TestDatabase;
  let redisContainer: StartedRedisContainer;
  let pool: pg.Pool;
  let redis: Redis;
  let app: INestApplication<App>;

  beforeAll(async () => {
    [database, redisContainer] = await Promise.all([
      startTestDatabase(),
      new RedisContainer(REDIS_IMAGE).start(),
    ]);
    pool = new pg.Pool({ connectionString: database.appUrl, max: 1 });
    pool.on('error', () => undefined);
    holder.pool = pool;
    redis = new Redis(redisContainer.getConnectionUrl(), {
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      retryStrategy: () => 50,
    });
    redis.on('error', () => undefined);
    await once(redis, 'ready');
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        PoolModule,
        HealthModule.forRootAsync({
          inject: [POOL_TOKEN],
          useFactory: (injected: pg.Pool) => ({
            indicators: [postgresIndicator(injected), redisIndicator(redis)],
            timeoutMs: 500,
          }),
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    redis.disconnect();
    await pool.end();
    await database.stop();
  });

  it('answers 200 while PostgreSQL and Redis answer', async () => {
    const response: Response = await request(app.getHttpServer()).get('/health/ready').expect(200);

    expect(response.body).toEqual({
      status: 'ok',
      info: { postgres: { status: 'up' }, redis: { status: 'up' } },
      error: {},
      details: { postgres: { status: 'up' }, redis: { status: 'up' } },
    });
  });

  it('answers 503 naming Redis once it stops, while liveness stays 200', async () => {
    await redisContainer.stop();

    const ready: Response = await request(app.getHttpServer()).get('/health/ready').expect(503);
    await request(app.getHttpServer()).get('/health/live').expect(200);

    expect(ready.headers['content-type']).toMatch(/^application\/json/u);
    expect(ready.body).toMatchObject({
      status: 'error',
      info: { postgres: { status: 'up' } },
      error: { redis: { status: 'down' } },
    });
    expect(JSON.stringify(ready.body)).not.toMatch(/127\.0\.0\.1|localhost|ECONN/u);
  });
});
