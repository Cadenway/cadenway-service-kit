import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InternalPrincipal } from '../../auth/context/internal-principal.js';
import { InternalTokenSigner } from '../../auth/internal-token/internal-token-signer.js';
import { InternalTokenVerifier } from '../../auth/internal-token/internal-token-verifier.js';
import type { Ed25519PrivateJwk } from '../../auth/internal-token/internal-token.js';
import {
  runWithOrganizationContext,
  type OrganizationContext,
} from '../../auth/context/organization-context.js';
import { ProblemException, type Problem } from '../../problem/problem.js';
import { generateSigningJwk, publicJwkOf } from '../../testing/internal-token-keys.js';
import { InternalHttpClient, type InternalHttpClientOptions } from './internal-http-client.js';
import { requestDeadlineMiddleware, runWithDeadline } from '../deadline/request-deadline.js';

/**
 * Interface Reply
 *
 * @description
 * What the fake service answers to one call.
 */
interface Reply {
  // #region Properties
  /**
   * Property status
   *
   * @description
   * HTTP status of the answer.
   *
   * @type {number}
   * @readonly
   */
  readonly status: number;

  /**
   * Property body
   *
   * @description
   * JSON body of the answer; an empty object by default.
   *
   * @type {unknown}
   * @readonly
   */
  readonly body?: unknown;

  /**
   * Property delayMs
   *
   * @description
   * Time the fake service waits before answering, in milliseconds.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly delayMs?: number;

  /**
   * Property contentType
   *
   * @description
   * Content type of the answer; JSON by default.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly contentType?: string;
  // #endregion
}

/**
 * Constant context
 *
 * @description
 * Organization context of a member of Atelier Nord.
 *
 * @type {OrganizationContext}
 */
const context: OrganizationContext = {
  organizationId: '0193a1f0-0000-7000-8000-00000000000a',
  actor: { type: 'user', id: 'user-camille' },
  role: 'member',
  scopes: ['tasks:write'],
};

/**
 * Function problemOf
 *
 * @description
 * Awaits a call expected to fail and returns the problem it throws.
 *
 * @param {Promise<unknown>} call - Pending call.
 * @returns {Promise<Problem>} The thrown problem.
 */
async function problemOf(call: Promise<unknown>): Promise<Problem> {
  try {
    await call;
  } catch (error) {
    if (error instanceof ProblemException) {
      return error.problem;
    }
    throw error;
  }
  throw new Error('Expected the call to fail.');
}

describe('InternalHttpClient', () => {
  let server: Server;
  let baseUrl: string;
  let signer: InternalTokenSigner;
  let verifier: InternalTokenVerifier;
  let replies: Reply[];
  let received: IncomingMessage[];

  /**
   * Function client
   *
   * @description
   * Builds a client of the fake service with a fresh circuit breaker.
   *
   * @param {Partial<InternalHttpClientOptions>} overrides - Options to change.
   * @returns {InternalHttpClient} The client.
   */
  function client(overrides: Partial<InternalHttpClientOptions> = {}): InternalHttpClient {
    return new InternalHttpClient({ service: 'task-service', baseUrl, signer, ...overrides });
  }

  beforeAll(async () => {
    const jwk: Ed25519PrivateJwk = await generateSigningJwk('gateway-2026-11');
    signer = await InternalTokenSigner.create({ issuer: 'api-gateway', privateJwk: jwk });
    verifier = await InternalTokenVerifier.create({
      audience: 'task-service',
      trustedIssuers: { 'api-gateway': [publicJwkOf(jwk)] },
    });
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      received.push(request);
      const reply: Reply = replies.shift() ?? { status: 200, body: { ok: true } };
      void delay(reply.delayMs ?? 0).then(() => {
        response
          .writeHead(reply.status, { 'content-type': reply.contentType ?? 'application/json' })
          .end(JSON.stringify(reply.body ?? {}));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  beforeEach(() => {
    replies = [];
    received = [];
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  it('sends an internal token for the called service, built from the organization context', async () => {
    const response: Response = await runWithOrganizationContext(context, () =>
      client().fetch('/internal/v1/tasks/CAD-482'),
    );

    const authorization: string = received[0]?.headers.authorization ?? '';
    const principal: InternalPrincipal = await verifier.verify(
      authorization.slice('Bearer '.length),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(received[0]?.url).toBe('/internal/v1/tasks/CAD-482');
    expect(principal).toMatchObject({
      issuer: 'api-gateway',
      audience: 'task-service',
      organizationId: '0193a1f0-0000-7000-8000-00000000000a',
      actor: { type: 'user', id: 'user-camille' },
      scopes: ['tasks:write'],
    });
  });

  it('uses explicit claims, and refuses to call without any identity', async () => {
    await client().fetch('/internal/v1/tokens/introspect', {
      method: 'POST',
      body: '{}',
      claims: { actor: { type: 'system', id: null }, organizationId: null },
    });

    const authorization: string = received[0]?.headers.authorization ?? '';
    expect(await verifier.verify(authorization.slice('Bearer '.length))).toMatchObject({
      actor: { type: 'system', id: null },
      organizationId: null,
    });
    await expect(client().fetch('/internal/v1/tasks')).rejects.toThrow(
      /outside an organization context/u,
    );
    expect(received).toHaveLength(1);
  });

  it('grants a call the time left to the request, two seconds at most, and forwards the request id', async () => {
    await runWithOrganizationContext(context, () => client().fetch('/a'));
    await new Promise<void>((resolve) => {
      requestDeadlineMiddleware({ budgetMs: 10_000 })(
        { id: 'gateway-req-0001', headers: { 'x-request-timeout-ms': '300' } },
        undefined,
        () => {
          void runWithOrganizationContext(context, () => client().fetch('/b')).then(() => {
            resolve();
          });
        },
      );
    });

    expect(received[0]?.headers['x-request-timeout-ms']).toBe('2000');
    expect(received[0]?.headers['x-request-id']).toBeUndefined();
    expect(Number(received[1]?.headers['x-request-timeout-ms'])).toBeGreaterThan(0);
    expect(Number(received[1]?.headers['x-request-timeout-ms'])).toBeLessThanOrEqual(300);
    expect(received[1]?.headers['x-request-id']).toBe('gateway-req-0001');
  });

  it('gives up when the deadline passes, and does not call once it is exhausted', async () => {
    replies = [{ status: 200, delayMs: 400 }];
    const started: number = performance.now();
    const late: Problem = await problemOf(
      runWithDeadline(100, () =>
        runWithOrganizationContext(context, () => client().fetch('/slow', { method: 'POST' })),
      ),
    );
    const elapsed: number = performance.now() - started;
    const exhausted: Problem = await problemOf(
      runWithDeadline(0, () => runWithOrganizationContext(context, () => client().fetch('/c'))),
    );

    expect(late).toMatchObject({
      status: 503,
      code: 'upstream.timeout',
      details: { service: 'task-service' },
    });
    expect(elapsed).toBeLessThan(350);
    expect(exhausted).toMatchObject({ status: 503, code: 'upstream.deadline-exceeded' });
    expect(received).toHaveLength(1);
  });

  it('retries an idempotent call once after a 503, and only then', async () => {
    replies = [{ status: 503 }, { status: 200, body: { second: true } }];
    const response: Response = await runWithOrganizationContext(context, () =>
      client().fetch('/tasks'),
    );
    replies = [{ status: 503 }, { status: 503 }, { status: 200 }];
    const twice: Problem = await problemOf(
      runWithOrganizationContext(context, () => client().fetch('/tasks')),
    );

    expect(await response.json()).toEqual({ second: true });
    expect(twice).toMatchObject({ status: 503, code: 'upstream.unavailable' });
    expect(received).toHaveLength(4);
  });

  it.each(['fails', 'stalls'])('counts 503 failures when body cancellation %s', async (cleanup) => {
    let attempts: number = 0;
    let cancellations: number = 0;
    const upstream: InternalHttpClient = client({
      breakerThreshold: 2,
      fetch: (): Promise<Response> => {
        attempts += 1;
        const body = new ReadableStream<Uint8Array>({
          cancel(): Promise<void> {
            cancellations += 1;
            return cleanup === 'fails'
              ? Promise.reject(new Error('body cleanup failed'))
              : new Promise<void>(() => undefined);
          },
        });
        return Promise.resolve(new Response(body, { status: 503 }));
      },
    });

    const failed: Problem = await problemOf(
      runWithOrganizationContext(context, () => upstream.fetch('/tasks')),
    );
    const blocked: Problem = await problemOf(
      runWithOrganizationContext(context, () => upstream.fetch('/tasks')),
    );

    expect(failed).toMatchObject({ status: 503, code: 'upstream.unavailable' });
    expect(blocked).toMatchObject({ status: 503, code: 'upstream.circuit-open' });
    expect(attempts).toBe(2);
    expect(cancellations).toBe(2);
  });

  it('does not retry a call that may not be sent twice, nor another server error', async () => {
    replies = [{ status: 503 }];
    const post: Problem = await problemOf(
      runWithOrganizationContext(context, () =>
        client().fetch('/tasks', { method: 'POST', body: '{}' }),
      ),
    );
    replies = [{ status: 500 }];
    const failed: Problem = await problemOf(
      runWithOrganizationContext(context, () => client().fetch('/tasks')),
    );
    replies = [{ status: 503 }, { status: 201 }];
    const declared: Response = await runWithOrganizationContext(context, () =>
      client().fetch('/tasks', {
        method: 'POST',
        body: '{}',
        headers: { 'Idempotency-Key': 'key-0001' },
      }),
    );

    expect(post.code).toBe('upstream.unavailable');
    expect(failed).toMatchObject({ status: 503, code: 'upstream.failed' });
    expect(declared.status).toBe(201);
    expect(received).toHaveLength(4);
  });

  it('retries once after a connection error', async () => {
    let attempts: number = 0;
    const unreachable: Problem = await problemOf(
      runWithOrganizationContext(context, () =>
        client({
          fetch: (): Promise<Response> => {
            attempts += 1;
            return Promise.reject(new TypeError('fetch failed'));
          },
        }).fetch('/tasks'),
      ),
    );

    expect(unreachable).toMatchObject({ status: 503, code: 'upstream.unreachable' });
    expect(attempts).toBe(2);
  });

  it('opens the circuit after consecutive failures, fails fast, then closes on a successful trial', async () => {
    const guarded: InternalHttpClient = client({ breakerThreshold: 3, breakerHalfOpenAfterMs: 80 });
    replies = [{ status: 500 }, { status: 500 }, { status: 500 }];
    for (let call: number = 0; call < 3; call += 1) {
      await problemOf(
        runWithOrganizationContext(context, () => guarded.fetch('/tasks', { method: 'POST' })),
      );
    }

    const open: Problem = await problemOf(
      runWithOrganizationContext(context, () => guarded.fetch('/tasks')),
    );
    await delay(120);
    const trial: Response = await runWithOrganizationContext(context, () =>
      guarded.fetch('/tasks'),
    );
    const closed: Response = await runWithOrganizationContext(context, () =>
      guarded.fetch('/tasks'),
    );

    expect(open).toMatchObject({
      status: 503,
      code: 'upstream.circuit-open',
      details: { service: 'task-service' },
    });
    expect(trial.status).toBe(200);
    expect(closed.status).toBe(200);
    expect(received).toHaveLength(5);
  });

  it('relays a client error as the problem of the called service, without tripping the breaker', async () => {
    const guarded: InternalHttpClient = client({ breakerThreshold: 2 });
    const notFound: Reply = {
      status: 404,
      contentType: 'application/problem+json',
      body: {
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        code: 'task.not-found',
        detail: 'No such task in this organization.',
        details: { taskId: 'CAD-999' },
      },
    };
    replies = [notFound, notFound, notFound, { status: 200 }];
    const problems: Problem[] = [];
    for (let call: number = 0; call < 3; call += 1) {
      problems.push(
        await problemOf(runWithOrganizationContext(context, () => guarded.fetch('/tasks/CAD-999'))),
      );
    }
    const after: Response = await runWithOrganizationContext(context, () =>
      guarded.fetch('/tasks/CAD-482'),
    );

    expect(problems[0]).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      code: 'task.not-found',
      detail: 'No such task in this organization.',
      details: { taskId: 'CAD-999', service: 'task-service' },
    });
    expect(after.status).toBe(200);
  });

  it.each([undefined, '1', '65537'])(
    'cancels an oversized problem when content-length is %s',
    async (length) => {
      const chunk: Uint8Array = new Uint8Array(32_768);
      let cancelled: boolean = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller): void {
          controller.enqueue(chunk);
        },
        cancel(): void {
          cancelled = true;
        },
      });
      const upstream: InternalHttpClient = client({
        fetch: (): Promise<Response> =>
          Promise.resolve(
            new Response(body, {
              status: 404,
              headers: length === undefined ? {} : { 'content-length': length },
            }),
          ),
      });

      const problem: Problem = await problemOf(
        runWithOrganizationContext(context, () => upstream.fetch('/tasks/CAD-999')),
      );

      expect(problem).toMatchObject({
        status: 404,
        code: 'upstream.error',
        details: { service: 'task-service' },
      });
      expect(cancelled).toBe(true);
    },
  );

  it('cancels a stalled problem body at the attempt deadline', async () => {
    let cancelled: boolean = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode('{"code":"task.not-found"'));
      },
      cancel(): void {
        cancelled = true;
      },
    });
    const upstream: InternalHttpClient = client({
      callTimeoutMs: 25,
      fetch: (): Promise<Response> => Promise.resolve(new Response(body, { status: 404 })),
    });

    const problem: Problem = await problemOf(
      runWithOrganizationContext(context, () => upstream.fetch('/tasks/CAD-999')),
    );

    expect(problem).toMatchObject({ status: 404, code: 'upstream.error' });
    expect(cancelled).toBe(true);
  });

  it('refuses a path that would send the internal token to another origin', async () => {
    for (const path of [
      'https://evil.example/steal',
      '//evil.example/steal',
      '/\\evil.example',
      'tasks',
    ]) {
      await expect(runWithOrganizationContext(context, () => client().fetch(path))).rejects.toThrow(
        /must be a path of that service/u,
      );
    }
    expect(received).toHaveLength(0);
  });

  it('does not let timeouts caused by a short request budget open the circuit', async () => {
    const guarded: InternalHttpClient = client({ breakerThreshold: 2 });
    replies = [
      { status: 200, delayMs: 150 },
      { status: 200, delayMs: 150 },
      { status: 200, delayMs: 150 },
    ];
    for (let call: number = 0; call < 3; call += 1) {
      const problem: Problem = await problemOf(
        runWithDeadline(40, () =>
          runWithOrganizationContext(context, () => guarded.fetch('/slow', { method: 'POST' })),
        ),
      );
      expect(problem.code).toBe('upstream.timeout');
    }
    await delay(200);

    const after: Response = await runWithOrganizationContext(context, () =>
      guarded.fetch('/tasks'),
    );

    expect(after.status).toBe(200);
  });

  it('turns a refused internal token and an unknown client error into safe problems', async () => {
    replies = [
      { status: 401, body: { code: 'auth.token-invalid', details: { reason: 'audience' } } },
      { status: 418, contentType: 'text/plain' },
    ];
    const unauthorized: Problem = await problemOf(
      runWithOrganizationContext(context, () => client().fetch('/tasks')),
    );
    const unknown: Problem = await problemOf(
      runWithOrganizationContext(context, () => client().fetch('/tasks')),
    );

    expect(unauthorized).toMatchObject({ status: 503, code: 'upstream.unauthorized' });
    expect(unknown).toMatchObject({
      status: 400,
      code: 'upstream.error',
      details: { service: 'task-service' },
    });
  });

  it('does not wait for the body or for cancellation when an upstream rejects the token', async () => {
    let finishCancellation: () => void = () => undefined;
    const cancellation = new Promise<void>((resolve) => {
      finishCancellation = resolve;
    });
    const cancel = vi.fn(() => cancellation);
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const upstream = client({
      fetch: () => Promise.resolve(new Response(body, { status: 401 })),
    });

    try {
      await expect(
        problemOf(runWithOrganizationContext(context, () => upstream.fetch('/tasks'))),
      ).resolves.toMatchObject({ status: 503, code: 'upstream.unauthorized' });
      expect(pull).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      finishCancellation();
    }
  });
});
