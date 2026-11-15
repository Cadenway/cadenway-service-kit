import { fileURLToPath } from 'node:url';

import {
  Body,
  Controller,
  Get,
  Module,
  Post,
  Query,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { InternalTokenSigner, type Ed25519PrivateJwk } from '../auth/internal-token.js';
import { getOrganizationContext } from '../auth/organization-context.js';
import { HealthModule } from '../health/health.module.js';
import { remainingBudgetMs } from '../http-client/request-deadline.js';
import { pageQueryShape, type PageQuery } from '../pagination/cursor.js';
import { registerTelemetryShutdown } from '../telemetry/telemetry-handle.js';
import { generateSigningJwk, publicJwkOf } from '../testing/internal-token-keys.js';
import { zodDto } from '../validation/zod-validation.pipe.js';
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
    expect(readPackageVersion(fileURLToPath(new URL('../..', import.meta.url)))).toMatch(
      /^\d+\.\d+\.\d+/u,
    );
    expect(readPackageVersion('/nowhere/at/all')).toBe('0.0.0');
  });
});
