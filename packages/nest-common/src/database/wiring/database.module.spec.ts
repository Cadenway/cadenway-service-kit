import { Controller, HttpCode, Module, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import pg from 'pg';
import request, { type Response } from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createApplication } from '../../bootstrap/application/create-application.js';
import { baseConfigShape, type BaseConfig } from '../../config/base-config.js';
import { CONFIG, ConfigModule } from '../../config/config.module.js';
import { ConfigError, loadConfig } from '../../config/load-config.js';
import { Idempotent } from '../idempotency/idempotency.interceptor.js';
import {
  DATABASE_POOL,
  databaseConfigShape,
  DEFAULT_POOL_SIZE,
  type DatabaseConfig,
} from '../index.js';
import { DatabaseModule } from './database.module.js';

describe('database configuration', () => {
  it('accepts existing manual configs and defaults the schema-validated attempt limit', () => {
    const config: DatabaseConfig = { DATABASE_URL: 'postgres://notes_app@127.0.0.1:1/notes' };
    const schema = z.object(databaseConfigShape);

    expect(loadConfig(schema, { DATABASE_URL: config.DATABASE_URL })).toEqual({
      ...config,
      DATABASE_TRANSACTION_MAX_ATTEMPTS: 3,
    });
    expect(
      loadConfig(schema, {
        DATABASE_URL: config.DATABASE_URL,
        DATABASE_TRANSACTION_MAX_ATTEMPTS: '1',
      }),
    ).toMatchObject({ DATABASE_TRANSACTION_MAX_ATTEMPTS: 1 });
  });

  it.each(['0', '1.5', '9007199254740992'])(
    'rejects an invalid transaction attempt limit (%s) before startup',
    (limit) => {
      expect(() =>
        loadConfig(z.object(databaseConfigShape), {
          DATABASE_URL: 'postgres://notes_app@127.0.0.1:1/notes',
          DATABASE_TRANSACTION_MAX_ATTEMPTS: limit,
        }),
      ).toThrow(ConfigError);
    },
  );
});

/**
 * Interface AppConfig
 *
 * @description
 * Configuration of a fictional service with a database.
 */
interface AppConfig extends BaseConfig {
  // #region Properties
  /**
   * Property DATABASE_URL
   *
   * @description
   * Connection string of the service database.
   *
   * @type {string}
   * @readonly
   */
  readonly DATABASE_URL: string;
  // #endregion
}

/**
 * Constant appConfigSchema
 *
 * @description
 * Schema of the fictional service.
 *
 * @type {z.ZodType<AppConfig>}
 */
const appConfigSchema: z.ZodType<AppConfig> = z.object({
  ...baseConfigShape,
  ...databaseConfigShape,
});

/**
 * Class NoteController
 *
 * @description
 * Route marked for `Idempotency-Key`, which requires the header: answered 400 before any query
 * when the interceptor runs, 201 when it does not.
 */
@Controller('internal/v1/notes')
class NoteController {
  // #region Methods
  /**
   * Method create
   *
   * @description
   * Pretends to create a note.
   *
   * @returns {{ created: boolean }} A marker.
   */
  @Post()
  @HttpCode(201)
  @Idempotent({ required: true })
  public create(): { created: boolean } {
    return { created: true };
  }
  // #endregion
}

/**
 * Class LazyApplicationModule
 *
 * @description
 * Application module of a service that reads its configuration when the application is created:
 * declared at the top of this file, so importing the file must validate nothing whatever the
 * environment.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ schema: appConfigSchema, eager: false }),
    DatabaseModule.forRootAsync({
      inject: [CONFIG],
      useFactory: (config: AppConfig) => ({
        connectionString: config.DATABASE_URL,
        applicationName: 'notes-service',
        idempotency: true,
      }),
    }),
  ],
  controllers: [NoteController],
})
class LazyApplicationModule {}

/**
 * Function startService
 *
 * @description
 * Creates the application of a module with silent logs and no internal token.
 *
 * @param {typeof LazyApplicationModule} applicationModule - Module of the application.
 * @returns {Promise<NestExpressApplication>} The initialized application.
 */
async function startService(
  applicationModule: typeof LazyApplicationModule,
): Promise<NestExpressApplication> {
  const app: NestExpressApplication = await createApplication(applicationModule, {
    service: 'notes-service',
    config: { LOG_LEVEL: 'silent' },
    internalTokenVerification: 'off',
  });
  await app.init();
  return app;
}

describe('DatabaseModule.forRootAsync', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lets a module that reads its configuration lazily be imported with an invalid environment, then fails the creation with a ConfigError', async () => {
    vi.stubEnv('PORT', '');
    vi.stubEnv('DATABASE_URL', 'not-a-url');

    const failure: unknown = await startService(LazyApplicationModule).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ConfigError);
    expect((failure as ConfigError).issues).toEqual([
      'PORT: required, not set',
      expect.stringMatching(/^DATABASE_URL: /u) as unknown as string,
    ]);
    expect((failure as ConfigError).message).not.toContain('not-a-url');
  });

  it('builds the pool and the Idempotency-Key interceptor from the options its factory returns', async () => {
    vi.stubEnv('PORT', '3013');
    vi.stubEnv('DATABASE_URL', 'postgres://notes_app@127.0.0.1:1/notes');

    const app: NestExpressApplication = await startService(LazyApplicationModule);
    const pool: pg.Pool = app.get<pg.Pool>(DATABASE_POOL);
    const response: Response = await request(app.getHttpServer())
      .post('/internal/v1/notes')
      .expect(400);
    await app.close();

    expect(pool).toBeInstanceOf(pg.Pool);
    expect(pool.options.max).toBe(DEFAULT_POOL_SIZE);
    expect(pool.options.application_name).toBe('notes-service');
    expect(response.body).toMatchObject({ code: 'idempotency.key-required' });
  });

  it('registers no Idempotency-Key interceptor when the resolved options leave it off', async () => {
    vi.stubEnv('PORT', '3013');
    vi.stubEnv('DATABASE_URL', 'postgres://notes_app@127.0.0.1:1/notes');

    /**
     * Class PlainApplicationModule
     *
     * @description
     * Same service, without `idempotency`.
     */
    @Module({
      imports: [
        ConfigModule.forRoot({ schema: appConfigSchema, eager: false }),
        DatabaseModule.forRootAsync({
          inject: [CONFIG],
          useFactory: (config: AppConfig) => ({ connectionString: config.DATABASE_URL }),
        }),
      ],
      controllers: [NoteController],
    })
    class PlainApplicationModule {}

    const app: NestExpressApplication = await startService(PlainApplicationModule);
    const response: Response = await request(app.getHttpServer())
      .post('/internal/v1/notes')
      .expect(201);
    await app.close();

    expect(response.body).toEqual({ created: true });
  });
});
