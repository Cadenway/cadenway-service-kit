import { createHash } from 'node:crypto';

import {
  Injectable,
  SetMetadata,
  type CallHandler,
  type CustomDecorator,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, lastValueFrom, type Observable } from 'rxjs';

import { requestOrganizationContextOf } from '../../auth/context/request-organization-context.js';
import {
  getOrganizationContext,
  runWithOrganizationContext,
  type InternalActor,
  type OrganizationContext,
} from '../../auth/context/organization-context.js';
import { ProblemException } from '../../problem/problem.js';
import { SystemTransactionRunner } from '../transactions/system-transaction-runner.js';
import { TenantTransactionRunner } from '../transactions/tenant-transaction-runner.js';
import type {
  DatabaseSchema,
  TransactionOptions,
  TransactionScope,
} from '../transactions/transaction-contracts.js';
import {
  lockIdempotencyKey,
  readStoredResponse,
  storeResponse,
  type StoredResponse,
} from './idempotency-store.js';

export { purgeExpiredIdempotencyKeys } from './idempotency-maintenance.js';
export { IDEMPOTENCY_RETENTION_HOURS } from './idempotency-store.js';

/**
 * Constant IDEMPOTENCY_KEY_HEADER
 *
 * @description
 * Request header carrying the idempotency key (IETF draft `idempotency-key-header`).
 *
 * @type {string}
 */
export const IDEMPOTENCY_KEY_HEADER: string = 'Idempotency-Key';

/**
 * Constant IDEMPOTENT_REPLAYED_HEADER
 *
 * @description
 * Response header set to `true` when the response is a replay of a stored one.
 *
 * @type {string}
 */
export const IDEMPOTENT_REPLAYED_HEADER: string = 'Idempotent-Replayed';

/**
 * Interface IdempotentOptions
 *
 * @description
 * Options of `@Idempotent()`.
 */
export interface IdempotentOptions {
  // #region Properties
  /**
   * Property required
   *
   * @description
   * Refuses a request without the header. Defaults to `false`: without a key the route runs as
   * if it were not marked.
   *
   * @type {boolean | undefined}
   * @readonly
   */
  readonly required?: boolean;

  /**
   * Property isolationLevel
   *
   * @description
   * Isolation level of the transaction the interceptor opens around the handler. Defaults to
   * the PostgreSQL default, `read committed`. Set it when the use case of the route asks for a
   * stricter level: a use case joins this transaction and cannot raise its level afterwards.
   *
   * @type {'read committed' | 'repeatable read' | 'serializable' | undefined}
   * @readonly
   */
  readonly isolationLevel?: 'read committed' | 'repeatable read' | 'serializable';
  // #endregion
}

/**
 * Interface IdempotentRequest
 *
 * @description
 * Part of the Express request the interceptor reads.
 */
interface IdempotentRequest {
  // #region Properties
  /**
   * Property method
   *
   * @description
   * HTTP method.
   *
   * @type {string}
   * @readonly
   */
  readonly method: string;

  /**
   * Property originalUrl
   *
   * @description
   * Path and query string as received.
   *
   * @type {string}
   * @readonly
   */
  readonly originalUrl: string;

  /**
   * Property headers
   *
   * @description
   * Request headers, lower-cased by Node.
   *
   * @type {Readonly<Record<string, string | string[] | undefined>>}
   * @readonly
   */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;

  /**
   * Property body
   *
   * @description
   * Parsed request body.
   *
   * @type {unknown}
   * @readonly
   */
  readonly body?: unknown;
  // #endregion
}

/**
 * Interface IdempotentResponse
 *
 * @description
 * Part of the Express response the interceptor uses.
 */
interface IdempotentResponse {
  // #region Properties
  /**
   * Property statusCode
   *
   * @description
   * Status of the response, which NestJS sets from `@HttpCode()` or its default before the
   * interceptors run.
   *
   * @type {number}
   * @readonly
   */
  readonly statusCode: number;
  // #endregion

  // #region Methods
  /**
   * Method getHeader
   *
   * @description
   * Reads a response header set so far.
   *
   * @param {string} name - Header name.
   * @returns {unknown} Its value, or `undefined`.
   */
  getHeader(name: string): unknown;

  /**
   * Method setHeader
   *
   * @description
   * Sets a response header.
   *
   * @param {string} name - Header name.
   * @param {string} value - Header value.
   * @returns {unknown} Ignored.
   */
  setHeader(name: string, value: string): unknown;
  // #endregion
}

/**
 * Constant IDEMPOTENT_KEY
 *
 * @description
 * Metadata key of `@Idempotent()`.
 *
 * @type {string}
 */
const IDEMPOTENT_KEY: string = 'cadenway:idempotent';

/**
 * Constant KEY_PATTERN
 *
 * @description
 * Shape of an accepted key: 1 to 255 printable ASCII characters.
 *
 * @type {RegExp}
 */
const KEY_PATTERN: RegExp = /^[\x21-\x7e]{1,255}$/u;

/**
 * Constant REPLAYED_HEADERS
 *
 * @description
 * Response headers stored with the body and set again on a replay. `ETag` is not among them:
 * it is derived from the replayed body.
 *
 * @type {readonly string[]}
 */
const REPLAYED_HEADERS: readonly string[] = ['location'];

/**
 * Function Idempotent
 *
 * @description
 * Marks a route whose effect must happen once per `Idempotency-Key`: a creation, a send, a
 * payment. The handler then runs inside the transaction that stores the key, see
 * `IdempotencyInterceptor`.
 *
 * @param {IdempotentOptions} options - Whether the header is mandatory.
 * @returns {CustomDecorator} The method decorator.
 */
export function Idempotent(options: IdempotentOptions = {}): CustomDecorator {
  return SetMetadata(IDEMPOTENT_KEY, options);
}

/**
 * Function requestFingerprint
 *
 * @description
 * Computes what identifies a request besides its key: who sends it, the method, the path with
 * its query string, and the parsed body. The actor is part of it so that a key learnt by another
 * member, or by another anonymous caller, replays nothing: it answers 422.
 *
 * @param {IdempotentRequest} request - Incoming request.
 * @param {string} actor - Type and id of the verified actor.
 * @returns {string} A SHA-256 digest, in base64url.
 */
function requestFingerprint(request: IdempotentRequest, actor: string): string {
  return createHash('sha256')
    .update(
      `${actor}\n${request.method}\n${request.originalUrl}\n${JSON.stringify(request.body ?? null)}`,
    )
    .digest('base64url');
}

/**
 * Class IdempotencyInterceptor
 *
 * @description
 * Implements `Idempotency-Key` for the routes marked with `@Idempotent()`. The key and the
 * response are stored in the service's own database, in the same transaction as the use case:
 * the stored response exists if and only if the effect was committed.
 *
 * | Situation                                        | Answer                                    |
 * | ------------------------------------------------ | ----------------------------------------- |
 * | First request with a key                         | The handler runs; its response is stored  |
 * | Same key, same request, within 24 hours          | The stored response, `Idempotent-Replayed: true`; the handler does not run |
 * | Same key, another method, path or body           | 422 `idempotency.key-reused`              |
 * | Same key while the first request is still running | 409 `idempotency.in-progress`            |
 * | Handler fails                                    | Its error; nothing is stored, a retry runs again |
 * | No header                                        | The handler runs normally, or 400 `idempotency.key-required` with `required` |
 * | Malformed key                                    | 400 `idempotency.key-invalid`             |
 *
 * How it works: the interceptor opens the transaction (tenant runner for a request with an
 * organization, system runner otherwise), takes a transaction-level advisory lock on the key,
 * and runs the handler inside. The `run` of the use case joins that transaction. Consequences
 * for a marked route: the whole handler is in the transaction, so it must not call another
 * service before the use case; its status comes from `@HttpCode()` or the NestJS default, not
 * from a manual `response.status()`; and a use case that needs a stricter isolation level states
 * it on the route (`@Idempotent({ isolationLevel })`).
 *
 * A key belongs to the organization of the verified token. Requests without an organization
 * share one namespace: their keys must be unguessable, as a UUID is.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Receives the two runners and the metadata reader.
   *
   * @param {TenantTransactionRunner<DatabaseSchema>} tenant - Runner of requests with an organization.
   * @param {SystemTransactionRunner<DatabaseSchema>} system - Runner of requests without one.
   * @param {Reflector} reflector - Reader of the route declarations.
   * @constructor
   */
  public constructor(
    private readonly tenant: TenantTransactionRunner<DatabaseSchema>,
    private readonly system: SystemTransactionRunner<DatabaseSchema>,
    private readonly reflector: Reflector,
  ) {}
  // #endregion

  // #region Methods
  /**
   * Method intercept
   *
   * @description
   * Applies the idempotency protocol to a marked route; any other route passes through.
   *
   * @param {ExecutionContext} context - Execution context of the request.
   * @param {CallHandler} next - Rest of the request pipeline.
   * @returns {Observable<unknown>} The response stream, fresh or replayed.
   * @throws {ProblemException} 400, 409 or 422, as listed on the class.
   */
  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options: IdempotentOptions | undefined =
      context.getType() === 'http'
        ? this.reflector.get<IdempotentOptions | undefined>(IDEMPOTENT_KEY, context.getHandler())
        : undefined;
    if (options === undefined) {
      return next.handle();
    }
    const request: IdempotentRequest = context.switchToHttp().getRequest();
    const header: string | string[] | undefined = request.headers['idempotency-key'];
    if (header === undefined) {
      if (options.required === true) {
        throw new ProblemException({
          status: 400,
          code: 'idempotency.key-required',
          detail: 'This route requires an Idempotency-Key header.',
        });
      }
      return next.handle();
    }
    if (typeof header !== 'string' || !KEY_PATTERN.test(header)) {
      throw new ProblemException({
        status: 400,
        code: 'idempotency.key-invalid',
        detail: 'Idempotency-Key must be 1 to 255 printable ASCII characters.',
      });
    }
    return from(this.execute(context, next, request, header, options));
  }

  /**
   * Method execute
   *
   * @description
   * Opens the transaction of the request and runs the protocol inside it.
   *
   * @param {ExecutionContext} context - Execution context of the request.
   * @param {CallHandler} next - Rest of the request pipeline.
   * @param {IdempotentRequest} request - Incoming request.
   * @param {string} key - Validated idempotency key.
   * @param {IdempotentOptions} options - Declaration of the route.
   * @returns {Promise<unknown>} The response body, fresh or replayed.
   */
  private execute(
    context: ExecutionContext,
    next: CallHandler,
    request: IdempotentRequest,
    key: string,
    options: IdempotentOptions,
  ): Promise<unknown> {
    const transactionOptions: TransactionOptions =
      options.isolationLevel === undefined ? {} : { isolationLevel: options.isolationLevel };
    const identity: OrganizationContext | undefined = requestOrganizationContextOf(request);
    const organizationId: string | null = identity?.organizationId ?? null;
    const work: (scope: TransactionScope<DatabaseSchema>) => Promise<unknown> = (
      scope: TransactionScope<DatabaseSchema>,
    ) => this.runOnce(context, next, request, key, organizationId, scope);
    if (identity === undefined || organizationId === null) {
      return this.system.run(work, transactionOptions);
    }
    // The organization context interceptor may be registered after this one: open the context
    // from the same identity rather than depend on the order.
    return getOrganizationContext() === undefined
      ? runWithOrganizationContext(identity, () => this.tenant.run(work, transactionOptions))
      : this.tenant.run(work, transactionOptions);
  }

  /**
   * Method runOnce
   *
   * @description
   * Inside the transaction: locks the key, replays a stored response or runs the handler and
   * stores its response.
   *
   * @param {ExecutionContext} context - Execution context of the request.
   * @param {CallHandler} next - Rest of the request pipeline.
   * @param {IdempotentRequest} request - Incoming request.
   * @param {string} key - Validated idempotency key.
   * @param {string | null} organizationId - Organization of the verified token, if any.
   * @param {TransactionScope<DatabaseSchema>} scope - Scope of the transaction.
   * @returns {Promise<unknown>} The response body, fresh or replayed.
   */
  private async runOnce(
    context: ExecutionContext,
    next: CallHandler,
    request: IdempotentRequest,
    key: string,
    organizationId: string | null,
    scope: TransactionScope<DatabaseSchema>,
  ): Promise<unknown> {
    if (!(await lockIdempotencyKey(scope, organizationId, key))) {
      throw new ProblemException({
        status: 409,
        code: 'idempotency.in-progress',
        detail: 'A request with this Idempotency-Key is still running.',
      });
    }
    const actor: InternalActor | undefined = requestOrganizationContextOf(request)?.actor;
    const fingerprint: string = requestFingerprint(
      request,
      actor === undefined ? 'none' : `${actor.type}:${actor.id ?? ''}`,
    );
    const response: IdempotentResponse = context.switchToHttp().getResponse();
    const existing: StoredResponse | undefined = await readStoredResponse(
      scope,
      organizationId,
      key,
    );
    if (existing !== undefined && !existing.expired) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new ProblemException({
          status: 422,
          code: 'idempotency.key-reused',
          detail: 'This Idempotency-Key was already used for another request.',
        });
      }
      for (const [name, value] of Object.entries(existing.responseHeaders)) {
        response.setHeader(name, value);
      }
      response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
      return existing.responseBody ?? undefined;
    }
    const body: unknown = await lastValueFrom(next.handle(), { defaultValue: undefined });
    const headers: Record<string, string> = {};
    for (const name of REPLAYED_HEADERS) {
      const value: unknown = response.getHeader(name);
      if (typeof value === 'string') {
        headers[name] = value;
      }
    }
    await storeResponse(scope, organizationId, key, {
      requestFingerprint: fingerprint,
      responseStatus: response.statusCode,
      responseHeaders: headers,
      responseBody: body ?? null,
    });
    return body;
  }
  // #endregion
}
