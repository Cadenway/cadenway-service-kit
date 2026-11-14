import { setTimeout as delay } from 'node:timers/promises';

import { Controller, Get, Post, type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { HealthModule } from '../health/health.module.js';
import { LoggingModule } from '../logging/logging.module.js';
import { ProblemFilter } from '../problem/problem.filter.js';
import { generateSigningJwk, publicJwkOf } from '../testing/internal-token-keys.js';
import { InternalAccess } from './internal-token.guard.js';
import { InternalTokenSigner, type Ed25519PrivateJwk } from './internal-token.js';
import { InternalTokenModule } from './internal-token.module.js';
import {
  getOrganizationContext,
  requireOrganizationId,
  type OrganizationContext,
} from './organization-context.js';

/**
 * Type LogLine
 *
 * @description
 * One parsed JSON log line.
 *
 * @type {Record<string, unknown>}
 */
type LogLine = Record<string, unknown>;

/**
 * Constant lines
 *
 * @description
 * Lines written by the application under test, in order.
 *
 * @type {LogLine[]}
 */
const lines: LogLine[] = [];

/**
 * Class TaskController
 *
 * @description
 * Internal routes of a fictional task service, one per access declaration.
 */
@Controller('internal/v1')
class TaskController {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Receives the request-scoped logger.
   *
   * @param {PinoLogger} logger - Logger bound to the current request.
   * @constructor
   */
  public constructor(private readonly logger: PinoLogger) {}
  // #endregion

  // #region Methods
  /**
   * Method listTasks
   *
   * @description
   * Route with the default access: an organization and an identified actor. It waits before
   * reading the context, so concurrent requests overlap.
   *
   * @returns {Promise<{ organizationId: string; context: OrganizationContext | undefined }>} What the handler sees.
   */
  @Get('tasks')
  public async listTasks(): Promise<{
    organizationId: string;
    context: OrganizationContext | undefined;
  }> {
    await delay(20);
    this.logger.info('listing tasks');
    return { organizationId: requireOrganizationId(), context: getOrganizationContext() };
  }

  /**
   * Method signUp
   *
   * @description
   * Route with no user and no organization, open to an anonymous subject.
   *
   * @returns {{ context: OrganizationContext | undefined }} What the handler sees.
   */
  @Post('sign-ups')
  @InternalAccess({ actors: ['anonymous'], organization: 'optional' })
  public signUp(): { context: OrganizationContext | undefined } {
    return { context: getOrganizationContext() };
  }

  /**
   * Method runAction
   *
   * @description
   * Route reserved to one issuer.
   *
   * @returns {{ ok: boolean }} A fixed body.
   */
  @Post('actions')
  @InternalAccess({ issuers: ['automation-service'], actors: ['automation'] })
  public runAction(): { ok: boolean } {
    return { ok: true };
  }
  // #endregion
}

describe('InternalTokenGuard', () => {
  let app: INestApplication<App>;
  let gatewayJwk: Ed25519PrivateJwk;
  let gateway: InternalTokenSigner;
  let automation: InternalTokenSigner;

  beforeAll(async () => {
    gatewayJwk = await generateSigningJwk('gateway-2026-11');
    const automationJwk: Ed25519PrivateJwk = await generateSigningJwk('automation-2026-11');
    gateway = await InternalTokenSigner.create({ issuer: 'api-gateway', privateJwk: gatewayJwk });
    automation = await InternalTokenSigner.create({
      issuer: 'automation-service',
      privateJwk: automationJwk,
    });
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        LoggingModule.forRoot({
          service: 'task-service',
          version: '0.0.0',
          destination: {
            write: (line: string): void => {
              lines.push(JSON.parse(line) as LogLine);
            },
          },
        }),
        InternalTokenModule.forRoot({
          verifier: {
            audience: 'task-service',
            trustedIssuers: {
              'api-gateway': [publicJwkOf(gatewayJwk)],
              'automation-service': [publicJwkOf(automationJwk)],
            },
          },
        }),
        HealthModule,
      ],
      controllers: [TaskController],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new ProblemFilter());
    await app.init();
  });

  beforeEach(() => {
    lines.length = 0;
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses a token whose aud names another service', async () => {
    const token: string = await gateway.sign('billing-service', {
      actor: { type: 'user', id: 'user-camille' },
      organizationId: 'org-atelier-nord',
    });

    const response: Response = await request(app.getHttpServer())
      .get('/internal/v1/tasks')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);

    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/u);
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(response.body).toEqual({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      code: 'auth.token-invalid',
      detail: 'The internal token is not valid for this service.',
      details: { reason: 'audience' },
    });
  });

  it('refuses a request without a token or with another scheme', async () => {
    const missing: Response = await request(app.getHttpServer())
      .get('/internal/v1/tasks')
      .expect(401);
    const basic: Response = await request(app.getHttpServer())
      .get('/internal/v1/tasks')
      .set('Authorization', 'Basic dXNlcjpwYXNz')
      .expect(401);

    expect(missing.body).toMatchObject({ code: 'auth.token-missing' });
    expect(basic.body).toMatchObject({ code: 'auth.token-missing' });
  });

  it('derives the organization context from the verified token only', async () => {
    const token: string = await gateway.sign('task-service', {
      actor: { type: 'user', id: 'user-camille' },
      organizationId: 'org-atelier-nord',
      role: 'admin',
      scopes: ['tasks:read'],
    });

    const response: Response = await request(app.getHttpServer())
      .get('/internal/v1/tasks?organizationId=org-other')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Organization-Id', 'org-other')
      .expect(200);

    expect(response.body).toEqual({
      organizationId: 'org-atelier-nord',
      context: {
        organizationId: 'org-atelier-nord',
        actor: { type: 'user', id: 'user-camille' },
        role: 'admin',
        scopes: ['tasks:read'],
      },
    });
  });

  it('keeps the contexts of concurrent requests apart', async () => {
    const organizations: string[] = ['org-a', 'org-b', 'org-c', 'org-d'];

    const responses: Response[] = await Promise.all(
      organizations.map(async (organizationId: string) =>
        request(app.getHttpServer())
          .get('/internal/v1/tasks')
          .set(
            'Authorization',
            `Bearer ${await gateway.sign('task-service', {
              actor: { type: 'user', id: `user-of-${organizationId}` },
              organizationId,
            })}`,
          ),
      ),
    );

    expect(
      responses.map((response) => (response.body as { organizationId: string }).organizationId),
    ).toEqual(organizations);
  });

  it('writes organizationId and userId on the lines of the request', async () => {
    const token: string = await gateway.sign('task-service', {
      actor: { type: 'user', id: 'user-camille' },
      organizationId: 'org-atelier-nord',
    });

    await request(app.getHttpServer())
      .get('/internal/v1/tasks')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(lines.find((line) => line.msg === 'listing tasks')).toMatchObject({
      organizationId: 'org-atelier-nord',
      userId: 'user-camille',
    });
    expect(lines.find((line) => line.msg === 'request completed')).toMatchObject({
      route: '/internal/v1/tasks',
      status: 200,
      organizationId: 'org-atelier-nord',
      userId: 'user-camille',
    });
  });

  it('refuses an anonymous subject and a missing organization on a default route', async () => {
    const anonymous: string = await gateway.sign('task-service', {
      actor: { type: 'anonymous', id: null },
      organizationId: null,
    });
    const noOrganization: string = await gateway.sign('task-service', {
      actor: { type: 'user', id: 'user-camille' },
      organizationId: null,
    });

    const first: Response = await request(app.getHttpServer())
      .get('/internal/v1/tasks')
      .set('Authorization', `Bearer ${anonymous}`)
      .expect(403);
    const second: Response = await request(app.getHttpServer())
      .get('/internal/v1/tasks')
      .set('Authorization', `Bearer ${noOrganization}`)
      .expect(403);

    expect(first.body).toMatchObject({ code: 'auth.actor-not-allowed' });
    expect(second.body).toMatchObject({ code: 'auth.organization-required' });
  });

  it('lets an anonymous subject reach a route that declares it, and still needs a token', async () => {
    const anonymous: string = await gateway.sign('task-service', {
      actor: { type: 'anonymous', id: null },
      organizationId: null,
    });

    const response: Response = await request(app.getHttpServer())
      .post('/internal/v1/sign-ups')
      .set('Authorization', `Bearer ${anonymous}`)
      .expect(201);
    await request(app.getHttpServer()).post('/internal/v1/sign-ups').expect(401);

    expect(response.body).toEqual({
      context: {
        organizationId: null,
        actor: { type: 'anonymous', id: null },
        role: null,
        scopes: [],
      },
    });
  });

  it('restricts a route to the issuers it declares', async () => {
    const claims: { actor: { type: 'automation'; id: string }; organizationId: string } = {
      actor: { type: 'automation', id: 'rule-42' },
      organizationId: 'org-atelier-nord',
    };

    await request(app.getHttpServer())
      .post('/internal/v1/actions')
      .set('Authorization', `Bearer ${await automation.sign('task-service', claims)}`)
      .expect(201);
    const refused: Response = await request(app.getHttpServer())
      .post('/internal/v1/actions')
      .set('Authorization', `Bearer ${await gateway.sign('task-service', claims)}`)
      .expect(403);

    expect(refused.body).toMatchObject({ code: 'auth.issuer-not-allowed' });
  });

  it('leaves the health probes open', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200);
    await request(app.getHttpServer()).get('/health/ready').expect(200);
  });
});
