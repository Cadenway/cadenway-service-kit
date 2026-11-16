import { setTimeout as delay } from 'node:timers/promises';

import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Query,
  UseGuards,
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Observable } from 'rxjs';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApplication } from '../../bootstrap/create-application.js';
import { InternalHttpClient } from '../../http-client/internal-http-client.js';
import { ProblemException } from '../../problem/problem.js';
import { generateSigningJwk, publicJwkOf } from '../../testing/internal-token-keys.js';
import type { InternalPrincipal } from '../context/internal-principal.js';
import { setRequestOrganizationContext } from '../context/request-organization-context.js';
import {
  InternalTokenSigner,
  InternalTokenVerifier,
  type Ed25519PrivateJwk,
} from './internal-token.js';
import {
  getOrganizationContext,
  type OrganizationContext,
} from '../context/organization-context.js';

/**
 * Constant camille
 *
 * @description
 * Identity of a member of Atelier Nord, as the session introspection returns it.
 *
 * @type {OrganizationContext}
 */
const camille: OrganizationContext = {
  organizationId: '0193a1f0-0000-7000-8000-00000000000a',
  actor: { type: 'user', id: 'user-camille' },
  role: 'member',
  scopes: ['tasks:write'],
};

/**
 * Constant sessions
 *
 * @description
 * What the fake session introspection of the gateway knows, by session id: the identity it
 * verified, never anything read from the request.
 *
 * @type {ReadonlyMap<string, OrganizationContext>}
 */
const sessions: ReadonlyMap<string, OrganizationContext> = new Map<string, OrganizationContext>([
  ['session-camille', camille],
  [
    'session-hugo',
    {
      organizationId: '0193a1f0-0000-7000-8000-00000000000b',
      actor: { type: 'user', id: 'user-hugo' },
      role: 'admin',
      scopes: [],
    },
  ],
]);

/**
 * Constant TASK_CLIENT
 *
 * @description
 * Injection token of the client of the fictional task service.
 *
 * @type {symbol}
 */
const TASK_CLIENT: unique symbol = Symbol('task-client');

/**
 * Class SessionGuard
 *
 * @description
 * Stands for the guard of a public gateway: it verifies the session the caller presents and
 * attaches the identity the verification returned.
 */
@Injectable()
class SessionGuard implements CanActivate {
  // #region Methods
  /**
   * Method canActivate
   *
   * @description
   * Looks the session up and attaches its context; refuses an unknown session.
   *
   * @param {ExecutionContext} context - Execution context of the request.
   * @returns {boolean} `true` once the context is attached.
   * @throws {ProblemException} 401 for an unknown session.
   */
  public canActivate(context: ExecutionContext): boolean {
    const incoming: { headers: Record<string, string | string[] | undefined> } = context
      .switchToHttp()
      .getRequest();
    const header: string | string[] | undefined = incoming.headers.authorization;
    const verified: OrganizationContext | undefined =
      typeof header === 'string' ? sessions.get(header.replace(/^Session /u, '')) : undefined;
    if (verified === undefined) {
      throw new ProblemException({ status: 401, code: 'auth.session-invalid' });
    }
    setRequestOrganizationContext(incoming, verified);
    return true;
  }
  // #endregion
}

/**
 * Class GatewayController
 *
 * @description
 * Route of the fictional gateway: reports the context its handler sees and what the called
 * service received in the internal token.
 */
@Controller('v1')
@UseGuards(SessionGuard)
class GatewayController {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Receives the client of the called service.
   *
   * @param {InternalHttpClient} tasks - Client of the task service.
   * @constructor
   */
  public constructor(@Inject(TASK_CLIENT) private readonly tasks: InternalHttpClient) {}
  // #endregion

  // #region Methods
  /**
   * Method me
   *
   * @description
   * Waits, then reads the context and calls the task service.
   *
   * @param {string | undefined} waitMs - Time to wait before reading the context, in milliseconds.
   * @returns {Promise<{ context: OrganizationContext | null; forwarded: unknown }>} The observations.
   */
  @Get('me')
  public async me(
    @Query('waitMs') waitMs: string | undefined,
  ): Promise<{ context: OrganizationContext | null; forwarded: unknown }> {
    await delay(Number(waitMs ?? '0'));
    const context: OrganizationContext | null = getOrganizationContext() ?? null;
    const forwarded: unknown = await (await this.tasks.fetch('/internal/v1/whoami')).json();
    return { context, forwarded };
  }
  // #endregion
}

/**
 * Class ContextProbeInterceptor
 *
 * @description
 * Global interceptor registered by the module of the application, as `DatabaseModule` registers
 * the `Idempotency-Key` interceptor: records the organization it sees when it runs, to show that
 * the context is already open around it.
 */
@Injectable()
class ContextProbeInterceptor implements NestInterceptor {
  // #region Properties
  /**
   * Property seen
   *
   * @description
   * Organization of the context at each interception, `null` without one.
   *
   * @type {(string | null)[]}
   * @readonly
   */
  public static readonly seen: (string | null)[] = [];
  // #endregion

  // #region Methods
  /**
   * Method intercept
   *
   * @description
   * Records the current organization and lets the request go on.
   *
   * @param {ExecutionContext} _context - Execution context of the request.
   * @param {CallHandler} next - Rest of the request pipeline.
   * @returns {Observable<unknown>} The response stream.
   */
  public intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    ContextProbeInterceptor.seen.push(getOrganizationContext()?.organizationId ?? null);
    return next.handle();
  }
  // #endregion
}

/**
 * Class AttachingGuard
 *
 * @description
 * Guard of a service that wrongly tries to attach a second identity to a request that already
 * carries a verified internal token. Records the refusal, then lets it fail the request.
 */
@Injectable()
class AttachingGuard implements CanActivate {
  // #region Properties
  /**
   * Property refusals
   *
   * @description
   * Messages of the errors `setRequestOrganizationContext` threw.
   *
   * @type {string[]}
   * @readonly
   */
  public static readonly refusals: string[] = [];
  // #endregion

  // #region Methods
  /**
   * Method canActivate
   *
   * @description
   * Attaches the context of a session to the request, which must throw.
   *
   * @param {ExecutionContext} context - Execution context of the request.
   * @returns {boolean} Never: the attachment throws.
   */
  public canActivate(context: ExecutionContext): boolean {
    try {
      setRequestOrganizationContext(context.switchToHttp().getRequest<object>(), camille);
    } catch (error) {
      AttachingGuard.refusals.push((error as Error).message);
      throw error;
    }
    return true;
  }
  // #endregion
}

/**
 * Class AttachingController
 *
 * @description
 * Route of a service guarded by `AttachingGuard`.
 */
@Controller('internal/v1/attaching')
@UseGuards(AttachingGuard)
class AttachingController {
  // #region Methods
  /**
   * Method read
   *
   * @description
   * Never reached.
   *
   * @returns {{ reached: boolean }} A marker.
   */
  @Get()
  public read(): { reached: boolean } {
    return { reached: true };
  }
  // #endregion
}

// The gateway is the first application of this file: nestjs-pino keeps one pino-http instance
// per process, so only the first application created writes to its own log destination.
describe('setRequestOrganizationContext in a gateway that verifies its callers itself', () => {
  let gateway: NestExpressApplication;
  let jwk: Ed25519PrivateJwk;
  const lines: Record<string, unknown>[] = [];

  beforeAll(async () => {
    jwk = await generateSigningJwk('gateway-2026-11');
    const signer: InternalTokenSigner = await InternalTokenSigner.create({
      issuer: 'api-gateway',
      privateJwk: jwk,
    });
    const verifier: InternalTokenVerifier = await InternalTokenVerifier.create({
      audience: 'task-service',
      trustedIssuers: { 'api-gateway': [publicJwkOf(jwk)] },
    });
    // The called service: it verifies the internal token and echoes who the call was made for.
    const calledService: typeof fetch = async (
      _input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const authorization: string = new Headers(init?.headers).get('authorization') ?? '';
      const principal: InternalPrincipal = await verifier.verify(
        authorization.replace(/^Bearer /u, ''),
      );
      return new globalThis.Response(
        JSON.stringify({
          organizationId: principal.organizationId,
          actor: principal.actor,
          role: principal.role,
          scopes: principal.scopes,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const tasks: InternalHttpClient = new InternalHttpClient({
      service: 'task-service',
      baseUrl: 'http://task-service.internal',
      signer,
      fetch: calledService,
    });

    /**
     * Class GatewayModule
     *
     * @description
     * Module of the fictional gateway: its route, the client of the task service and a global
     * interceptor of its own.
     */
    @Module({
      controllers: [GatewayController],
      providers: [
        { provide: TASK_CLIENT, useValue: tasks },
        { provide: APP_INTERCEPTOR, useClass: ContextProbeInterceptor },
      ],
    })
    class GatewayModule {}

    gateway = await createApplication(GatewayModule, {
      service: 'sample-gateway',
      internalTokenVerification: 'off',
      logDestination: {
        write: (line: string): void => {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    });
    await gateway.init();
  });

  beforeEach(() => {
    lines.length = 0;
  });

  afterAll(async () => {
    await gateway.close();
  });

  it('runs the handler in the attached context and signs the outgoing calls from it', async () => {
    ContextProbeInterceptor.seen.length = 0;
    const response: Response = await request(gateway.getHttpServer())
      .get('/v1/me')
      .set('Authorization', 'Session session-camille')
      .expect(200);

    expect(response.body).toEqual({ context: camille, forwarded: camille });
    // The interceptors of the application module run inside the context, as the
    // Idempotency-Key interceptor of DatabaseModule must.
    expect(ContextProbeInterceptor.seen).toEqual(['0193a1f0-0000-7000-8000-00000000000a']);
  });

  it('writes the attached identity on the completion line', async () => {
    await request(gateway.getHttpServer())
      .get('/v1/me')
      .set('Authorization', 'Session session-camille')
      .expect(200);

    expect(lines.find((line) => line.msg === 'request completed')).toMatchObject({
      service: 'sample-gateway',
      route: '/v1/me',
      organizationId: '0193a1f0-0000-7000-8000-00000000000a',
      userId: 'user-camille',
    });
  });

  it('keeps the contexts of concurrent requests apart', async () => {
    const [slow, fast]: Response[] = await Promise.all([
      request(gateway.getHttpServer())
        .get('/v1/me?waitMs=80')
        .set('Authorization', 'Session session-camille'),
      request(gateway.getHttpServer())
        .get('/v1/me?waitMs=5')
        .set('Authorization', 'Session session-hugo'),
    ]);

    expect(slow?.body).toEqual({ context: camille, forwarded: camille });
    expect(fast?.body).toMatchObject({
      context: { organizationId: '0193a1f0-0000-7000-8000-00000000000b' },
      forwarded: {
        organizationId: '0193a1f0-0000-7000-8000-00000000000b',
        actor: { type: 'user', id: 'user-hugo' },
        role: 'admin',
      },
    });
  });

  it('runs nothing for a caller its guard refused', async () => {
    const response: Response = await request(gateway.getHttpServer())
      .get('/v1/me')
      .set('Authorization', 'Session unknown')
      .expect(401);

    expect(response.body).toMatchObject({ code: 'auth.session-invalid' });
  });

  it('refuses a second identity on a request that carries a verified internal token', async () => {
    const signer: InternalTokenSigner = await InternalTokenSigner.create({
      issuer: 'api-gateway',
      privateJwk: jwk,
    });

    /**
     * Class AttachingModule
     *
     * @description
     * Module of a service whose route guard tries to attach a context.
     */
    @Module({ controllers: [AttachingController] })
    class AttachingModule {}

    const service: NestExpressApplication = await createApplication(AttachingModule, {
      service: 'sample-service',
      internalToken: {
        verifier: {
          audience: 'sample-service',
          trustedIssuers: { 'api-gateway': [publicJwkOf(jwk)] },
        },
      },
    });
    await service.init();
    const token: string = await signer.sign('sample-service', {
      actor: { type: 'user', id: 'user-hugo' },
      organizationId: '0193a1f0-0000-7000-8000-00000000000b',
    });

    const response: Response = await request(service.getHttpServer())
      .get('/internal/v1/attaching')
      .set('Authorization', `Bearer ${token}`)
      .expect(500);
    await service.close();

    expect(response.body).toMatchObject({ code: 'internal.unexpected' });
    expect(AttachingGuard.refusals).toHaveLength(1);
    expect(AttachingGuard.refusals[0]).toMatch(/carries a verified internal token/u);
  });
});
