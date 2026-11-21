import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import {
  All,
  Body,
  Controller,
  Get,
  Inject,
  Module,
  Post,
  Query,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { InternalTokenSigner } from '../../auth/internal-token/internal-token-signer.js';
import type { Ed25519PrivateJwk } from '../../auth/internal-token/internal-token.js';
import { getOrganizationContext } from '../../auth/context/organization-context.js';
import { CONFIG } from '../../config/config.module.js';
import { HealthModule } from '../../health/health.module.js';
import { remainingBudgetMs } from '../../http/deadline/request-deadline.js';
import { pageQueryShape, type PageQuery } from '../../pagination/cursor.js';
import { registerTelemetryShutdown } from '../../telemetry/sdk/telemetry-handle.js';
import { generateSigningJwk, publicJwkOf } from '../../testing/internal-token-keys.js';
import { zodDto } from '../../validation/zod-validation.pipe.js';
import { createApplication } from './create-application.js';
import { readPackageVersion } from './package-version.js';

/**
 * Constant listQuerySchema
 *
 * @description
 * Query schema of the sample list route.
 *
 * @type {z.ZodType<PageQuery>}
 */
const listQuerySchema: z.ZodType<PageQuery> = z.object({ ...pageQueryShape });

/**
 * Class ListQueryDto
 *
 * @description
 * Parameter type the global pipe validates.
 */
class ListQueryDto extends zodDto(listQuerySchema) {}

/**
 * Class SampleController
 *
 * @description
 * Routes that show what the bootstrap installed.
 */
@Controller('internal/v1/samples')
class SampleController {
  // #region Methods
  /**
   * Method list
   *
   * @description
   * Echoes the validated query with what the handler sees of its context.
   *
   * @param {ListQueryDto} query - Query validated by the global pipe.
   * @returns {{ limit: number; organizationId: string | null; budgetMs: number }} The observations.
   */
  @Get()
  public list(@Query() query: ListQueryDto): {
    limit: number;
    organizationId: string | null;
    budgetMs: number;
  } {
    return {
      limit: query.limit,
      organizationId: getOrganizationContext()?.organizationId ?? null,
      budgetMs: remainingBudgetMs() ?? -1,
    };
  }

  /**
   * Method create
   *
   * @description
   * Returns an aggregate at version 3.
   *
   * @param {{ padding?: string }} body - Body, only read for its size.
   * @returns {{ version: number; size: number }} The aggregate.
   */
  @Post()
  public create(@Body() body: { padding?: string }): { version: number; size: number } {
    return { version: 3, size: body.padding?.length ?? 0 };
  }

  /**
   * Method inspectWebhookBody
   *
   * @description
   * Reports which parser handled the fixture request and whether it preserved the bytes.
   *
   * @param {unknown} body - Body received by the Nest handler.
   * @returns {{ hex: string } | { body: unknown }} Raw bytes as hex or the decoded body.
   */
  @All(['webhook', 'webhook/nested'])
  public inspectWebhookBody(@Body() body: unknown): { hex: string } | { body: unknown } {
    return Buffer.isBuffer(body) ? { hex: body.toString('hex') } : { body };
  }
  // #endregion
}

/**
 * Class SampleModule
 *
 * @description
 * Module of the fictional application: its routes and the health module, nothing shared.
 */
@Module({ imports: [HealthModule], controllers: [SampleController] })
class SampleModule {}

describe('createApplication', () => {
  let app: NestExpressApplication;
  let gateway: InternalTokenSigner;
  let token: string;
  const lines: Record<string, unknown>[] = [];

  beforeAll(async () => {
    const jwk: Ed25519PrivateJwk = await generateSigningJwk('gateway-2026-11');
    gateway = await InternalTokenSigner.create({ issuer: 'api-gateway', privateJwk: jwk });
    app = await createApplication(SampleModule, {
      service: 'sample-service',
      version: '1.2.3',
      rawJsonPostPaths: ['/internal/v1/samples/webhook'],
      internalToken: {
        verifier: {
          audience: 'sample-service',
          trustedIssuers: { 'api-gateway': [publicJwkOf(jwk)] },
        },
      },
      logDestination: {
        write: (line: string): void => {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    });
    await app.init();
  });

  beforeEach(async () => {
    lines.length = 0;
    token = await gateway.sign('sample-service', {
      actor: { type: 'user', id: 'user-camille' },
      organizationId: '0193a1f0-0000-7000-8000-00000000000a',
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers errors as problems and requires the internal token', async () => {
    const missing: Response = await request(app.getHttpServer())
      .get('/internal/v1/samples')
      .expect(401);
    const unknown: Response = await request(app.getHttpServer())
      .get('/nowhere')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);

    expect(missing.headers['content-type']).toMatch(/^application\/problem\+json/u);
    expect(missing.body).toMatchObject({ code: 'auth.token-missing' });
    expect(unknown.body).toMatchObject({ code: 'http.not-found' });
  });

  it('validates typed parameters, opens the organization context and the request deadline', async () => {
    const ok: Response = await request(app.getHttpServer())
      .get('/internal/v1/samples')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Request-Timeout-Ms', '1500')
      .expect(200);
    const invalid: Response = await request(app.getHttpServer())
      .get('/internal/v1/samples?colour=red')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);

    const body: { limit: number; organizationId: string; budgetMs: number } = ok.body as {
      limit: number;
      organizationId: string;
      budgetMs: number;
    };
    expect(body.limit).toBe(50);
    expect(body.organizationId).toBe('0193a1f0-0000-7000-8000-00000000000a');
    expect(body.budgetMs).toBeGreaterThan(0);
    expect(body.budgetMs).toBeLessThanOrEqual(1500);
    expect(invalid.body).toMatchObject({ code: 'request.invalid' });
  });

  it('sets the entity tag, the request id and the body limit', async () => {
    const created: Response = await request(app.getHttpServer())
      .post('/internal/v1/samples')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Request-Id', 'gateway-req-0001')
      .send({ padding: 'p'.repeat(200_000) })
      .expect(201);
    const tooLarge: Response = await request(app.getHttpServer())
      .post('/internal/v1/samples')
      .set('Authorization', `Bearer ${token}`)
      .send({ padding: 'p'.repeat(1_100_000) })
      .expect(400);

    expect(created.headers.etag).toBe('"3"');
    expect(created.headers['x-request-id']).toBe('gateway-req-0001');
    expect(created.body).toEqual({ version: 3, size: 200_000 });
    expect(tooLarge.body).toMatchObject({ code: 'request.body-too-large' });
  });

  it('preserves the signed bytes across query strings and Express default path variants', async () => {
    const signed = '\r\n{ "label" : "équipe 👋", "enabled" : true }\n';
    const raw: Response = await request(app.getHttpServer())
      .post('/internal/v1/samples/WEBHOOK/?delivery=sample')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json; charset=utf-8')
      .send(signed)
      .expect(200);

    expect(raw.body).toEqual({ hex: Buffer.from(signed, 'utf8').toString('hex') });
  });

  it('leaves decoded JSON and fixed malformed-body errors on other paths and methods', async () => {
    const malformed = '{ "unsigned": }';
    const raw: Response = await request(app.getHttpServer())
      .post('/internal/v1/samples/webhook')
      .set('Authorization', `Bearer ${token}`)
      .type('json')
      .send(malformed)
      .expect(200);
    const nested: Response = await request(app.getHttpServer())
      .post('/internal/v1/samples/webhook/nested')
      .set('Authorization', `Bearer ${token}`)
      .send({ nested: true })
      .expect(200);
    const put: Response = await request(app.getHttpServer())
      .put('/internal/v1/samples/webhook')
      .set('Authorization', `Bearer ${token}`)
      .type('json')
      .send(malformed)
      .expect(400);

    expect(raw.body).toEqual({ hex: Buffer.from(malformed, 'utf8').toString('hex') });
    expect(nested.body).toEqual({ body: { nested: true } });
    expect(put.body).toMatchObject({ code: 'request.invalid' });
  });

  it('applies the configured JSON byte limit and refuses compressed webhook bodies', async () => {
    const limited = await createApplication(SampleModule, {
      service: 'sample-service',
      config: { LOG_LEVEL: 'silent' },
      internalTokenVerification: 'off',
      jsonBodyLimitBytes: 32,
      rawJsonPostPaths: ['/internal/v1/samples/webhook'],
    });
    await limited.listen(0, '127.0.0.1');
    try {
      const client = request(limited.getHttpServer());
      const overLimit: Response = await client
        .post('/internal/v1/samples/webhook')
        .type('json')
        .send('é'.repeat(17))
        .expect(400);
      const origin = await limited.getUrl();
      const compressedRequest = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
        body: Uint8Array.from(gzipSync('{}')),
      };
      const [compressed, decoded] = await Promise.all([
        fetch(new URL('/internal/v1/samples/webhook', origin), compressedRequest),
        fetch(new URL('/internal/v1/samples/webhook/nested', origin), compressedRequest),
      ]);
      expect(overLimit.body).toMatchObject({ code: 'request.body-too-large' });
      expect(compressed.status).toBe(400);
      expect(compressed.headers.get('content-type')).toMatch(/^application\/problem\+json/u);
      expect(await compressed.json()).toMatchObject({ code: 'http.bad-request' });
      expect(decoded.status).toBe(200);
      expect(await decoded.json()).toEqual({ body: {} });
    } finally {
      await limited.close();
    }
  });

  it('leaves webhook JSON decoding enabled by default', async () => {
    const standard = await createApplication(SampleModule, {
      service: 'sample-service',
      config: { LOG_LEVEL: 'silent' },
      internalTokenVerification: 'off',
    });
    await standard.init();
    try {
      const received: Response = await request(standard.getHttpServer())
        .post('/internal/v1/samples/webhook')
        .send({ event: true })
        .expect(200);
      expect(received.body).toEqual({ body: { event: true } });
    } finally {
      await standard.close();
    }
  });

  it('rejects a route pattern in the raw-body configuration', async () => {
    await expect(
      createApplication(SampleModule, {
        service: 'sample-service',
        internalTokenVerification: 'off',
        rawJsonPostPaths: ['/internal/v1/samples/:webhook'],
      }),
    ).rejects.toThrow('rawJsonPostPaths requires absolute literal paths');
  });

  it('writes structured lines with the identity of the application and of the caller', async () => {
    await request(app.getHttpServer())
      .get('/internal/v1/samples')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(lines.find((line) => line.msg === 'request completed')).toMatchObject({
      service: 'sample-service',
      version: '1.2.3',
      route: '/internal/v1/samples',
      status: 200,
      organizationId: '0193a1f0-0000-7000-8000-00000000000a',
      userId: 'user-camille',
    });
  });

  it('leaves the health probes open', async () => {
    await request(app.getHttpServer()).get('/health/ready').expect(200);
  });

  it('does not announce Express', async () => {
    const response: Response = await request(app.getHttpServer()).get('/health/live').expect(200);

    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('accepts the application module as a dynamic module', async () => {
    const other: NestExpressApplication = await createApplication(
      { module: SampleModule },
      {
        service: 'sample-service',
        config: { LOG_LEVEL: 'silent' },
        internalTokenVerification: 'off',
      },
    );
    await other.init();

    await request(other.getHttpServer()).get('/internal/v1/samples').expect(200);
    await other.close();
  });

  it('rejects with the error of a failing provider instead of aborting the process', async () => {
    /**
     * Class FailingModule
     *
     * @description
     * Module whose provider fails while the application is created.
     */
    @Module({
      providers: [
        {
          provide: 'broken',
          useFactory: (): never => {
            throw new Error('the broken provider failed');
          },
        },
      ],
    })
    class FailingModule {}

    await expect(
      createApplication(FailingModule, {
        service: 'sample-service',
        config: { LOG_LEVEL: 'silent' },
        internalTokenVerification: 'off',
      }),
    ).rejects.toThrow('the broken provider failed');
  });

  it('flushes telemetry when the application shuts down', async () => {
    let flushed: number = 0;
    registerTelemetryShutdown(() => {
      flushed += 1;
      return Promise.resolve();
    });
    const other: NestExpressApplication = await createApplication(SampleModule, {
      service: 'sample-service',
      config: { LOG_LEVEL: 'silent' },
      internalTokenVerification: 'off',
    });
    await other.init();

    await request(other.getHttpServer()).get('/internal/v1/samples').expect(200);
    await other.close();
    registerTelemetryShutdown(undefined);

    expect(flushed).toBe(1);
  });

  it('flushes telemetry after the application released its own resources, and survives a failed flush', async () => {
    const order: string[] = [];
    registerTelemetryShutdown(() => {
      order.push('telemetry');
      return Promise.reject(new Error('collector unreachable'));
    });

    /**
     * Class ResourceModule
     *
     * @description
     * Module of an application that closes a resource at shutdown, as the database module does.
     */
    @Module({ imports: [SampleModule] })
    class ResourceModule implements OnApplicationShutdown {
      // #region Methods
      /**
       * Method onApplicationShutdown
       *
       * @description
       * Records when the application releases its resource.
       *
       * @returns {void}
       */
      public onApplicationShutdown(): void {
        order.push('application');
      }
      // #endregion
    }

    const other: NestExpressApplication = await createApplication(ResourceModule, {
      service: 'sample-service',
      config: { LOG_LEVEL: 'silent' },
      internalTokenVerification: 'off',
    });
    await other.init();
    await expect(other.close()).resolves.toBeUndefined();
    registerTelemetryShutdown(undefined);

    expect(order).toEqual(['application', 'telemetry']);
  });

  it('refuses to start without a verifier unless verification is turned off', async () => {
    await expect(createApplication(SampleModule, { service: 'sample-service' })).rejects.toThrow(
      /internalToken\.verifier is required/u,
    );
    await expect(
      createApplication(SampleModule, {
        service: 'sample-service',
        internalToken: {},
      }),
    ).rejects.toThrow(/internalToken\.verifier is required/u);
  });

  it('provides the configuration main.ts validated, without reading the environment again', async () => {
    /**
     * Class ConfiguredController
     *
     * @description
     * Route that answers with the injected configuration.
     */
    @Controller('internal/v1/configured')
    class ConfiguredController {
      // #region Constructor
      /**
       * Constructor
       *
       * @description
       * Receives the configuration provided by `createApplication`.
       *
       * @param {{ PORT: number; SAMPLE_FLAG: string }} config - Validated configuration.
       * @constructor
       */
      public constructor(
        @Inject(CONFIG) private readonly config: { PORT: number; SAMPLE_FLAG: string },
      ) {}
      // #endregion

      // #region Methods
      /**
       * Method read
       *
       * @description
       * Returns two values of the configuration.
       *
       * @returns {{ port: number; flag: string }} The values.
       */
      @Get()
      public read(): { port: number; flag: string } {
        return { port: this.config.PORT, flag: this.config.SAMPLE_FLAG };
      }
      // #endregion
    }

    /**
     * Class ConfiguredModule
     *
     * @description
     * Application module that injects `CONFIG` and imports no `ConfigModule`.
     */
    @Module({ controllers: [ConfiguredController] })
    class ConfiguredModule {}

    const config: { LOG_LEVEL: 'silent'; PORT: number; SAMPLE_FLAG: string } = Object.freeze({
      LOG_LEVEL: 'silent',
      PORT: 4321,
      SAMPLE_FLAG: 'from-main',
    });
    const configured: NestExpressApplication = await createApplication(ConfiguredModule, {
      service: 'sample-service',
      config,
      provideConfig: true,
      internalTokenVerification: 'off',
    });
    await configured.init();

    const response: Response = await request(configured.getHttpServer())
      .get('/internal/v1/configured')
      .expect(200);
    await configured.close();

    expect(response.body).toEqual({ port: 4321, flag: 'from-main' });
    await expect(
      createApplication(ConfiguredModule, {
        service: 'sample-service',
        provideConfig: true,
        internalTokenVerification: 'off',
      }),
    ).rejects.toThrow(/provideConfig needs the validated configuration/u);
  });

  it('ignores the timeout header of a caller when told not to accept it', async () => {
    const edge: NestExpressApplication = await createApplication(SampleModule, {
      service: 'sample-gateway',
      config: { LOG_LEVEL: 'silent' },
      internalTokenVerification: 'off',
      acceptIncomingRequestTimeout: false,
    });
    await edge.init();

    const response: Response = await request(edge.getHttpServer())
      .get('/internal/v1/samples')
      .set('X-Request-Timeout-Ms', '50')
      .expect(200);
    await edge.close();

    expect((response.body as { budgetMs: number }).budgetMs).toBeGreaterThan(5000);
  });
});

describe('readPackageVersion', () => {
  it('reads the version of the package in the given directory, or falls back', () => {
    expect(readPackageVersion(fileURLToPath(new URL('../../..', import.meta.url)))).toMatch(
      /^\d+\.\d+\.\d+/u,
    );
    expect(readPackageVersion('/nowhere/at/all')).toBe('0.0.0');
  });
});
