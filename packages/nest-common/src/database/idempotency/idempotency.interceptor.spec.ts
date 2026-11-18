import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { defer, lastValueFrom, of, type Observable } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { ProblemException, type Problem } from '../../problem/problem.js';
import type { SystemTransactionRunner } from '../transactions/system-transaction-runner.js';
import type { TenantTransactionRunner } from '../transactions/tenant-transaction-runner.js';
import type { DatabaseSchema, TransactionScope } from '../transactions/transaction-contracts.js';
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
   * @type {Map<string, string>}
   * @readonly
   */
  public readonly headers: Map<string, string> = new Map<string, string>();
  // #endregion

  // #region Methods
  /**
   * Method getHeader
   *
   * @description
   * Reads a header set so far.
   *
   * @param {string} name - Header name, in any case.
   * @returns {string | undefined} Its value, or `undefined`.
   */
  public getHeader(name: string): string | undefined {
    return this.headers.get(name.toLowerCase());
  }

  /**
   * Method setHeader
   *
   * @description
   * Sets a header.
   *
   * @param {string} name - Header name, in any case.
   * @param {string} value - Header value.
   * @returns {void}
   */
  public setHeader(name: string, value: string): void {
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
 * @returns {IdempotencyInterceptor} The interceptor.
 */
function interceptorOf(table: FakeTable, options: IdempotentOptions = {}): IdempotencyInterceptor {
  const runner: object = {
    run: (
      work: (scope: TransactionScope<DatabaseSchema>) => Promise<unknown>,
    ): Promise<unknown> => {
      table.transactions += 1;
      return work(scopeOf(table));
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
 * @returns {ExecutionContext} The context.
 */
function contextOf(key: string | undefined, response: FakeResponse): ExecutionContext {
  const request: object = {
    method: 'POST',
    originalUrl: '/internal/v1/spaces',
    headers: key === undefined ? {} : { 'idempotency-key': key },
    body: { name: 'Produit' },
  };
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
