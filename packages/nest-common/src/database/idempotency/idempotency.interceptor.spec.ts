import type { OutgoingHttpHeader, OutgoingHttpHeaders } from 'node:http';

import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { defer, lastValueFrom, of, type Observable } from 'rxjs';
import { describe, expect, it } from 'vitest';

import type { OrganizationContext } from '../../auth/context/organization-context.js';
import { setRequestOrganizationContext } from '../../auth/context/request-organization-context.js';
import { ProblemException, type Problem } from '../../problem/problem.js';
import type { SystemTransactionRunner } from '../transactions/system-transaction-runner.js';
import type { TenantTransactionRunner } from '../transactions/tenant-transaction-runner.js';
import type {
  DatabaseSchema,
  TransactionOptions,
  TransactionScope,
} from '../transactions/transaction-contracts.js';
import { IdempotencyInterceptor, type IdempotentOptions } from './idempotency.interceptor.js';

/**
 * Interface FakeTable
 *
 * @description
 * In-memory state of the `idempotency_keys` table and of the advisory lock, as the fake
 * transaction scope sees it.
 */
interface FakeTable {
  // #region Properties
  /**
   * Property lockAvailable
   *
   * @description
   * Whether `pg_try_advisory_xact_lock` acquires the lock of the key.
   *
   * @type {boolean}
   */
  lockAvailable: boolean;

  /**
   * Property row
   *
   * @description
   * Last row written for the key, read back by the next request.
   *
   * @type {Record<string, unknown> | undefined}
   */
  row: Record<string, unknown> | undefined;

  /**
   * Property transactions
   *
   * @description
   * Number of transactions the interceptor opened.
   *
   * @type {number}
   */
  transactions: number;

  /**
   * Property transactionOptions
   *
   * @description
   * Options received by the outer transaction runner.
   *
   * @type {TransactionOptions | undefined}
   */
  transactionOptions?: TransactionOptions;
  // #endregion
}

/**
 * Class FakeResponse
 *
 * @description
 * Express response reduced to its status and case-insensitive headers.
 */
class FakeResponse {
  // #region Properties
  /**
   * Property headersSent
   *
   * @description
   * Fake handlers stage headers without writing them to a socket.
   *
   * @type {boolean}
   * @readonly
   */
  public readonly headersSent: boolean = false;

  /**
   * Property statusCode
   *
   * @description
   * Status NestJS applied before the interceptors run.
   *
   * @type {number}
   */
  public statusCode: number = 201;

  /**
   * Property headers
   *
   * @description
   * Headers set so far, keyed by their lower-case name.
   *
   * @type {Map<string, OutgoingHttpHeader>}
   * @readonly
   */
  public readonly headers: Map<string, OutgoingHttpHeader> = new Map<string, OutgoingHttpHeader>();
  // #endregion

  // #region Methods
  /**
   * Method getHeader
   *
   * @description
   * Reads a header set so far.
   *
   * @param {string} name - Header name, in any case.
   * @returns {OutgoingHttpHeader | undefined} Its value, or `undefined`.
   */
  public getHeader(name: string): OutgoingHttpHeader | undefined {
    return this.headers.get(name.toLowerCase());
  }

  /**
   * Method getHeaders
   *
   * @description
   * Reads a shallow copy of the staged headers, as the HTTP response does.
   *
   * @returns {OutgoingHttpHeaders} The staged headers.
   */
  public getHeaders(): OutgoingHttpHeaders {
    return Object.fromEntries(this.headers);
  }

  /**
   * Method getHeaderNames
   *
   * @description
   * Lists the names of the staged headers.
   *
   * @returns {string[]} The lower-cased names.
   */
  public getHeaderNames(): string[] {
    return [...this.headers.keys()];
  }

  /**
   * Method removeHeader
   *
   * @description
   * Discards a staged header.
   *
   * @param {string} name - Header name, in any case.
   */
  public removeHeader(name: string): void {
    this.headers.delete(name.toLowerCase());
  }

  /**
   * Method setHeader
   *
   * @description
   * Sets a header.
   *
   * @param {string} name - Header name, in any case.
   * @param {OutgoingHttpHeader} value - Header value.
   * @returns {void}
   */
  public setHeader(name: string, value: OutgoingHttpHeader): void {
    this.headers.set(name.toLowerCase(), value);
  }
  // #endregion
}

/**
 * Function scopeOf
 *
 * @description
 * Builds a transaction scope whose lock query and drizzle calls read and write a fake table.
 *
 * @param {FakeTable} table - State shared by the requests of a spec.
 * @returns {TransactionScope<DatabaseSchema>} The fake scope.
 */
function scopeOf(table: FakeTable): TransactionScope<DatabaseSchema> {
  const fake: object = {
    organizationId: null,
    client: {
      query: (): Promise<{ rows: unknown[] }> =>
        Promise.resolve({ rows: [{ acquired: table.lockAvailable }] }),
    },
    db: {
      select: () => ({
        from: () => ({
          where: (): Promise<unknown[]> =>
            Promise.resolve(table.row === undefined ? [] : [{ ...table.row, expired: false }]),
        }),
      }),
      insert: () => ({
        values: (row: Record<string, unknown>) => ({
          onConflictDoUpdate: (): Promise<void> => {
            table.row = row;
            return Promise.resolve();
          },
        }),
      }),
    },
  };
  return fake as TransactionScope<DatabaseSchema>;
}

/**
 * Function interceptorOf
 *
 * @description
 * Builds the interceptor with fake runners over a fake table and a fixed route declaration.
 *
 * @param {FakeTable} table - State shared by the requests of a spec.
 * @param {IdempotentOptions} options - Declaration of the route.
 * @param {number} attempts - Total attempts, simulating rollbacks before the final commit.
 * @param {Error | undefined} finalError - Simulated error when committing the final attempt.
 * @returns {IdempotencyInterceptor} The interceptor.
 */
function interceptorOf(
  table: FakeTable,
  options: IdempotentOptions = {},
  attempts: number = 1,
  finalError?: Error,
): IdempotencyInterceptor {
  const runner: object = {
    run: async (
      work: (scope: TransactionScope<DatabaseSchema>) => Promise<unknown>,
      transactionOptions: TransactionOptions,
    ): Promise<unknown> => {
      table.transactionOptions = transactionOptions;
      for (let attempt: number = 1; attempt < attempts; attempt += 1) {
        table.transactions += 1;
        await work(scopeOf(table));
        table.row = undefined;
      }
      table.transactions += 1;
      const result: unknown = await work(scopeOf(table));
      if (finalError === undefined) return result;
      table.row = undefined;
      throw finalError;
    },
  };
  const reflector: object = { get: (): IdempotentOptions => options };
  return new IdempotencyInterceptor(
    runner as TenantTransactionRunner<DatabaseSchema>,
    runner as SystemTransactionRunner<DatabaseSchema>,
    reflector as Reflector,
  );
}

/**
 * Function contextOf
 *
 * @description
 * Builds the execution context of an anonymous `POST /internal/v1/spaces`.
 *
 * @param {string | undefined} key - `Idempotency-Key` header, if any.
 * @param {FakeResponse} response - Response the handler and the interceptor write to.
 * @param {OrganizationContext | undefined} identity - Context established by the request guard.
 * @returns {ExecutionContext} The context.
 */
function contextOf(
  key: string | undefined,
  response: FakeResponse,
  identity?: OrganizationContext,
): ExecutionContext {
  const request: object = {
    method: 'POST',
    originalUrl: '/internal/v1/spaces',
    headers: key === undefined ? {} : { 'idempotency-key': key },
    body: { name: 'Produit' },
  };
  if (identity !== undefined) setRequestOrganizationContext(request, identity);
  const context: object = {
    getType: (): string => 'http',
    getHandler: (): (() => void) => (): void => undefined,
    switchToHttp: () => ({ getRequest: (): object => request, getResponse: () => response }),
  };
  return context as ExecutionContext;
}

/**
 * Function problemOf
 *
 * @description
 * Runs a function expected to throw a problem and returns it.
 *
 * @param {() => unknown} action - Function that throws.
 * @returns {Problem} The problem thrown.
 */
function problemOf(action: () => unknown): Problem {
  try {
    action();
  } catch (error) {
    if (error instanceof ProblemException) {
      return error.problem;
    }
    throw error;
  }
  throw new Error('Expected a ProblemException.');
}

describe('IdempotencyInterceptor', () => {
  /**
   * Function freshTable
   *
   * @description
   * Returns an empty table whose lock is free.
   *
   * @returns {FakeTable} The table.
   */
  function freshTable(): FakeTable {
    return { lockAvailable: true, row: undefined, transactions: 0 };
  }

  /**
   * Function creation
   *
   * @description
   * Handler of a creation that names the space, tags its version and sets a cookie.
   *
   * @param {FakeResponse} response - Response the handler writes to.
   * @param {{ runs: number }} counter - Counts the runs of the handler.
   * @returns {CallHandler} The handler.
   */
  function creation(response: FakeResponse, counter: { runs: number }): CallHandler {
    return {
      handle: (): Observable<unknown> =>
        defer(() => {
          counter.runs += 1;
          response.setHeader(
            'Location',
            '/internal/v1/spaces/0193a1f0-0000-7000-8000-000000000001',
          );
          response.setHeader('ETag', '"3"');
          response.setHeader('Set-Cookie', 'preference=compact');
          response.setHeader('X-Request-Id', 'request-0001');
          return of({ space: { id: '0193a1f0-0000-7000-8000-000000000001', version: 3 } });
        }),
    };
  }

  it.each([
    ['too long', 'k'.repeat(256)],
    ['empty', ''],
    ['with a space', 'key 0001'],
    ['with a non-ASCII character', 'clé-0001'],
  ])(
    'answers 400 request.invalid with an issue on the header to a key %s, without quoting it',
    (_case: string, key: string) => {
      const table: FakeTable = freshTable();

      const problem: Problem = problemOf(() =>
        interceptorOf(table).intercept(contextOf(key, new FakeResponse()), {
          handle: () => of(undefined),
        }),
      );

      expect(problem).toMatchObject({
        status: 400,
        code: 'request.invalid',
        detail: 'The request does not match its contract.',
        details: {
          issues: [
            {
              in: 'header',
              path: 'Idempotency-Key',
              code: 'invalid_format',
              message: 'Expected 1 to 255 printable ASCII characters.',
            },
          ],
        },
      });
      if (key !== '') {
        expect(JSON.stringify(problem)).not.toContain(key);
      }
      expect(table.transactions).toBe(0);
    },
  );

  it('accepts a key of 255 printable ASCII characters', async () => {
    const table: FakeTable = freshTable();
    const response: FakeResponse = new FakeResponse();
    const counter: { runs: number } = { runs: 0 };

    await lastValueFrom(
      interceptorOf(table).intercept(
        contextOf('~'.repeat(255), response),
        creation(response, counter),
      ),
    );

    expect(counter.runs).toBe(1);
    expect(table.transactions).toBe(1);
  });

  it('answers 409 idempotency.request-in-progress while another request holds the key', async () => {
    const table: FakeTable = { ...freshTable(), lockAvailable: false };
    const response: FakeResponse = new FakeResponse();
    const counter: { runs: number } = { runs: 0 };

    const failure: unknown = await lastValueFrom(
      interceptorOf(table).intercept(contextOf('key-0001', response), creation(response, counter)),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ProblemException);
    expect((failure as ProblemException).problem).toMatchObject({
      status: 409,
      code: 'idempotency.request-in-progress',
      detail: 'A request with this Idempotency-Key is still running.',
    });
    expect(counter.runs).toBe(0);
  });

  it('stores Location and ETag only, and replays them with the stored body', async () => {
    const table: FakeTable = freshTable();
    const counter: { runs: number } = { runs: 0 };
    const first: FakeResponse = new FakeResponse();
    const body: unknown = await lastValueFrom(
      interceptorOf(table).intercept(contextOf('key-0002', first), creation(first, counter)),
    );
    const replay: FakeResponse = new FakeResponse();

    const replayed: unknown = await lastValueFrom(
      interceptorOf(table).intercept(contextOf('key-0002', replay), creation(replay, counter)),
    );

    expect(table.row?.responseHeaders).toEqual({
      location: '/internal/v1/spaces/0193a1f0-0000-7000-8000-000000000001',
      etag: '"3"',
    });
    expect(replayed).toEqual(body);
    expect(Object.fromEntries(replay.headers)).toEqual({
      location: '/internal/v1/spaces/0193a1f0-0000-7000-8000-000000000001',
      etag: '"3"',
      'idempotent-replayed': 'true',
    });
    expect(counter.runs).toBe(1);
  });

  it('replays only Location and ETag of a row that holds other headers', async () => {
    const table: FakeTable = freshTable();
    const counter: { runs: number } = { runs: 0 };
    const first: FakeResponse = new FakeResponse();
    await lastValueFrom(
      interceptorOf(table).intercept(contextOf('key-0003', first), creation(first, counter)),
    );
    table.row = {
      ...table.row,
      responseHeaders: { location: '/internal/v1/spaces/1', 'set-cookie': 'session=first-caller' },
    };
    const replay: FakeResponse = new FakeResponse();

    await lastValueFrom(
      interceptorOf(table).intercept(contextOf('key-0003', replay), creation(replay, counter)),
    );

    expect(Object.fromEntries(replay.headers)).toEqual({
      location: '/internal/v1/spaces/1',
      'idempotent-replayed': 'true',
    });
    expect(counter.runs).toBe(1);
  });

  it('uses route isolation and attempt limits for the outer transaction', async () => {
    const table: FakeTable = freshTable();
    await lastValueFrom(
      interceptorOf(table, { isolationLevel: 'serializable', maxAttempts: 1 }).intercept(
        contextOf('route-option', new FakeResponse()),
        { handle: () => of(undefined) },
      ),
    );

    expect(table.transactionOptions).toEqual({ isolationLevel: 'serializable', maxAttempts: 1 });
  });

  it('uses a bounded storage namespace distinct from organization-scoped client keys', async () => {
    const table: FakeTable = freshTable();
    const key: string = 'x'.repeat(255);
    const identity: OrganizationContext = {
      actor: { type: 'user', id: 'user-camille' },
      organizationId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e01',
      role: null,
      scopes: [],
    };
    const response: FakeResponse = new FakeResponse();
    await lastValueFrom(
      interceptorOf(table, { scope: 'organization' }).intercept(
        contextOf(key, response, identity),
        { handle: () => of(undefined) },
      ),
    );
    expect(table.row?.key).toBe(key);

    const actorTable: FakeTable = freshTable();
    await lastValueFrom(
      interceptorOf(actorTable, { scope: 'actor' }).intercept(
        contextOf(key, new FakeResponse(), identity),
        { handle: () => of(undefined) },
      ),
    );
    const storageKey: unknown = actorTable.row?.key;
    expect(storageKey).toMatch(/^actor:v1 [A-Za-z0-9_-]{43}$/u);
    if (typeof storageKey !== 'string') throw new Error('Expected a stored actor key.');
    expect(
      problemOf(() =>
        interceptorOf(table).intercept(contextOf(storageKey, new FakeResponse(), identity), {
          handle: () => of(undefined),
        }),
      ),
    ).toMatchObject({ status: 400, code: 'request.invalid' });
  });

  it('refuses actor scoping without a verified identity before starting a transaction', async () => {
    const table: FakeTable = freshTable();
    const counter: { runs: number } = { runs: 0 };
    const response: FakeResponse = new FakeResponse();

    await expect(
      lastValueFrom(
        interceptorOf(table, { scope: 'actor' }).intercept(
          contextOf('actor-required', response),
          creation(response, counter),
        ),
      ),
    ).rejects.toMatchObject({ problem: { status: 403, code: 'auth.actor-not-allowed' } });
    expect(table.transactions).toBe(0);
    expect(counter.runs).toBe(0);
  });

  it('discards the staged status and headers from an aborted attempt before running the handler again', async () => {
    const table: FakeTable = freshTable();
    const response: FakeResponse = new FakeResponse();
    response.setHeader('Set-Cookie', ['preference=compact']);
    let runs: number = 0;
    const body: unknown = await lastValueFrom(
      interceptorOf(table, {}, 3).intercept(contextOf('retry-headers', response), {
        handle: () => {
          runs += 1;
          if (runs < 3) {
            response.statusCode = 200;
            response.setHeader('Location', '/internal/v1/spaces/discarded');
            response.setHeader('ETag', '"discarded"');
            const cookies = response.getHeader('Set-Cookie');
            if (Array.isArray(cookies)) cookies.push('preference=discarded');
          }
          return of({ attempt: runs });
        },
      }),
    );

    expect(body).toEqual({ attempt: 3 });
    expect(response.statusCode).toBe(201);
    expect(table.row?.responseStatus).toBe(201);
    expect(table.row?.responseHeaders).toEqual({});
    expect(response.getHeaders()).toEqual({ 'set-cookie': ['preference=compact'] });
  });

  it('restores the original status and headers when every attempt rolls back', async () => {
    const table: FakeTable = freshTable();
    const response: FakeResponse = new FakeResponse();
    response.setHeader('X-Request-Id', 'original-request');
    const failure = new Error('serialization failure after the handler', {
      cause: { code: '40001' },
    });
    let runs: number = 0;

    await expect(
      lastValueFrom(
        interceptorOf(table, {}, 3, failure).intercept(contextOf('failed-retries', response), {
          handle: () => {
            runs += 1;
            response.statusCode = 200;
            response.setHeader('Location', '/internal/v1/spaces/discarded');
            response.setHeader('ETag', '"discarded"');
            response.setHeader('Set-Cookie', 'preference=discarded');
            return of({ attempt: runs });
          },
        }),
      ),
    ).rejects.toBe(failure);
    expect(runs).toBe(3);
    expect(table.row).toBeUndefined();
    expect(response.statusCode).toBe(201);
    expect(response.getHeaders()).toEqual({ 'x-request-id': 'original-request' });
  });

  it('keeps answering 400 idempotency.key-required when a route requires the key', () => {
    const problem: Problem = problemOf(() =>
      interceptorOf(freshTable(), { required: true }).intercept(
        contextOf(undefined, new FakeResponse()),
        { handle: () => of(undefined) },
      ),
    );

    expect(problem).toMatchObject({ status: 400, code: 'idempotency.key-required' });
  });
});
