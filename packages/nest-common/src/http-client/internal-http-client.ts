import { trace } from '@opentelemetry/api';
import {
  BrokenCircuitError,
  circuitBreaker,
  ConsecutiveBreaker,
  handleWhen,
  type CircuitBreakerPolicy,
} from 'cockatiel';

import type { InternalTokenClaims, InternalTokenSigner } from '../auth/internal-token.js';
import { getOrganizationContext, type OrganizationContext } from '../auth/organization-context.js';
import { REQUEST_ID_HEADER, requestIdOf } from '../logging/request-id.js';
import { PROBLEM_CONTENT_TYPE, ProblemException, type ProblemStatus } from '../problem/problem.js';
import { currentRequest, remainingBudgetMs, REQUEST_TIMEOUT_HEADER } from './request-deadline.js';

/**
 * Constant MAX_CALL_TIMEOUT_MS
 *
 * @description
 * Longest time one call to another service may take, in milliseconds.
 *
 * @type {number}
 */
export const MAX_CALL_TIMEOUT_MS: number = 2000;

/**
 * Interface InternalHttpClientOptions
 *
 * @description
 * Options of an `InternalHttpClient`. Build one client per called service.
 */
export interface InternalHttpClientOptions {
  // #region Properties
  /**
   * Property service
   *
   * @description
   * Name of the called service, such as `task-service`: the `aud` of the tokens and the name of
   * the circuit breaker.
   *
   * @type {string}
   * @readonly
   */
  readonly service: string;

  /**
   * Property baseUrl
   *
   * @description
   * Base URL of the called service, from its `<SERVICE>_URL` variable.
   *
   * @type {string}
   * @readonly
   */
  readonly baseUrl: string;

  /**
   * Property signer
   *
   * @description
   * Signer of the internal token sent with every call.
   *
   * @type {InternalTokenSigner}
   * @readonly
   */
  readonly signer: InternalTokenSigner;

  /**
   * Property callTimeoutMs
   *
   * @description
   * Longest time one call may take, in milliseconds. Defaults to 2000 and cannot exceed it; the
   * time left to the current request shortens it further.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly callTimeoutMs?: number;

  /**
   * Property breakerThreshold
   *
   * @description
   * Consecutive failed calls that open the circuit. Defaults to 5.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly breakerThreshold?: number;

  /**
   * Property breakerHalfOpenAfterMs
   *
   * @description
   * How long the circuit stays open before one trial call is let through, in milliseconds.
   * Defaults to 10 000.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly breakerHalfOpenAfterMs?: number;

  /**
   * Property fetch
   *
   * @description
   * Fetch implementation. Defaults to the native `fetch` of Node; meant for tests.
   *
   * @type {typeof fetch | undefined}
   * @readonly
   */
  readonly fetch?: typeof fetch;
  // #endregion
}

/**
 * Interface InternalRequestInit
 *
 * @description
 * Options of one call: those of `fetch`, plus who the call is made for and whether it may be
 * sent twice.
 */
export interface InternalRequestInit extends RequestInit {
  // #region Properties
  /**
   * Property claims
   *
   * @description
   * Who the call is made for. Defaults to the current organization context; required outside
   * one, for instance for a call a service makes as itself.
   *
   * @type {InternalTokenClaims | undefined}
   * @readonly
   */
  readonly claims?: InternalTokenClaims;

  /**
   * Property idempotent
   *
   * @description
   * Declares that sending the call twice has the same effect as sending it once, which allows
   * the retry. Defaults to `true` for `GET`, `HEAD`, `PUT`, `DELETE` and `OPTIONS`, and for a
   * call that carries an `Idempotency-Key`; `false` otherwise.
   *
   * @type {boolean | undefined}
   * @readonly
   */
  readonly idempotent?: boolean;
  // #endregion
}

/**
 * Constant MAX_PROBLEM_BYTES
 *
 * @description
 * Largest error body of a called service that is parsed. A larger one is not a problem document
 * and is ignored.
 *
 * @type {number}
 */
const MAX_PROBLEM_BYTES: number = 65_536;

/**
 * Class UpstreamFailure
 *
 * @description
 * Failed attempt, as counted by the circuit breaker: the called service did not answer, or
 * answered a server error.
 */
class UpstreamFailure extends Error {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Records what went wrong with one attempt.
   *
   * @param {'unreachable' | 'timeout' | 'unavailable' | 'failed'} kind - Kind of failure; `unavailable` is a 503, `failed` another server error.
   * @param {boolean} counted - Whether the circuit breaker counts the failure against the called service.
   * @param {unknown} cause - Underlying error, kept for the logs.
   * @constructor
   */
  public constructor(
    public readonly kind: 'unreachable' | 'timeout' | 'unavailable' | 'failed',
    public readonly counted: boolean,
    cause?: unknown,
  ) {
    super(`upstream ${kind}`, { cause });
    this.name = 'UpstreamFailure';
  }
  // #endregion
}

/**
 * Constant IDEMPOTENT_METHODS
 *
 * @description
 * Methods whose calls may be sent twice by definition.
 *
 * @type {ReadonlySet<string>}
 */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set<string>([
  'GET',
  'HEAD',
  'PUT',
  'DELETE',
  'OPTIONS',
]);

/**
 * Constant RELAYED_STATUSES
 *
 * @description
 * Client-error statuses of a called service that are relayed to the caller as they are.
 *
 * @type {ReadonlySet<number>}
 */
const RELAYED_STATUSES: ReadonlySet<number> = new Set<number>([400, 403, 404, 409, 412, 422, 429]);

/**
 * Function claimsOf
 *
 * @description
 * Derives the claims of an outgoing call from the organization context of the current work.
 *
 * @param {OrganizationContext} context - Organization context of the current work.
 * @returns {InternalTokenClaims} The same identity, with the current trace id when there is one.
 */
function claimsOf(context: OrganizationContext): InternalTokenClaims {
  const traceId: string | undefined = trace.getActiveSpan()?.spanContext().traceId;
  return {
    actor: context.actor,
    organizationId: context.organizationId,
    role: context.role,
    scopes: context.scopes,
    ...(traceId === undefined ? {} : { traceId }),
  };
}

/**
 * Class InternalHttpClient
 *
 * @description
 * Calls one other Cadenway service over HTTP, on the native `fetch` of Node. It is the function
 * a generated client is given as its fetch implementation.
 *
 * | Concern         | Behavior                                                                                   |
 * | --------------- | ------------------------------------------------------------------------------------------ |
 * | Internal token  | Signed for the called service and sent on every call, for the current organization context |
 * | Deadline        | A call gets the time left to the current request, 2 seconds at most, and tells the called service in `X-Request-Timeout-Ms` |
 * | Retry           | One, for an idempotent call, after a connection error or a 503 only, when time is left     |
 * | Circuit breaker | One per client, opened by 5 consecutive failures, tried again after 10 seconds             |
 * | Request id      | The `X-Request-Id` of the current request is forwarded                                     |
 * | Failures        | Thrown as `ProblemException`; `fetch` only resolves with a response below 400              |
 *
 * | Outcome                                    | Thrown                                             |
 * | ------------------------------------------ | -------------------------------------------------- |
 * | 400, 403, 404, 409, 412, 422, 429          | The same status, with the code and details of the called service when it answered a problem |
 * | 401                                        | 503 `upstream.unauthorized`: the internal token was refused, a configuration defect |
 * | 503                                        | 503 `upstream.unavailable`                         |
 * | Another server error                       | 503 `upstream.failed`                              |
 * | No connection                              | 503 `upstream.unreachable`                         |
 * | No answer in time                          | 503 `upstream.timeout`                             |
 * | Circuit open                               | 503 `upstream.circuit-open`, without calling       |
 * | Time of the current request exhausted      | 503 `upstream.deadline-exceeded`, without calling  |
 *
 * Every problem names the called service in `details.service`. Connection errors, timeouts and
 * server errors count as failures for the breaker; client errors do not.
 */
export class InternalHttpClient {
  // #region Properties
  /**
   * Property breaker
   *
   * @description
   * Circuit breaker of the called service.
   *
   * @type {CircuitBreakerPolicy}
   * @readonly
   */
  private readonly breaker: CircuitBreakerPolicy;

  /**
   * Property callTimeoutMs
   *
   * @description
   * Longest time one call may take, in milliseconds.
   *
   * @type {number}
   * @readonly
   */
  private readonly callTimeoutMs: number;

  /**
   * Property fetchImplementation
   *
   * @description
   * Fetch implementation used for the calls.
   *
   * @type {typeof fetch}
   * @readonly
   */
  private readonly fetchImplementation: typeof fetch;
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Builds the client of one called service, with its own circuit breaker.
   *
   * @param {InternalHttpClientOptions} options - Called service, base URL, signer and limits.
   * @constructor
   */
  public constructor(private readonly options: InternalHttpClientOptions) {
    this.callTimeoutMs = Math.min(
      options.callTimeoutMs ?? MAX_CALL_TIMEOUT_MS,
      MAX_CALL_TIMEOUT_MS,
    );
    this.fetchImplementation = options.fetch ?? fetch;
    // Only failures of the called service open the circuit. A timeout cut short by the budget of
    // the incoming request, or a call its caller aborted, says nothing about that service: were
    // they counted, one caller sending a tiny budget could open the circuit for every tenant.
    this.breaker = circuitBreaker(
      handleWhen((error: unknown) => error instanceof UpstreamFailure && error.counted),
      {
        halfOpenAfter: options.breakerHalfOpenAfterMs ?? 10_000,
        breaker: new ConsecutiveBreaker(options.breakerThreshold ?? 5),
      },
    );
  }
  // #endregion

  // #region Methods
  /**
   * Method fetch
   *
   * @description
   * Calls a route of the service. Wrap it when handing it to a generated client:
   * `(path, init) => client.fetch(path, init)`.
   *
   * @param {string} path - Path of the route, relative to the base URL, such as `/internal/v1/tasks/CAD-482`.
   * @param {InternalRequestInit} init - Options of `fetch`, plus `claims` and `idempotent`.
   * @returns {Promise<Response>} The response, whose status is below 400.
   * @throws {ProblemException} For every failure, as listed on the class.
   * @throws {Error} When there is neither `claims` nor an organization context: a programming error.
   */
  public async fetch(path: string, init: InternalRequestInit = {}): Promise<Response> {
    const context: OrganizationContext | undefined = getOrganizationContext();
    const claims: InternalTokenClaims | undefined =
      init.claims ?? (context === undefined ? undefined : claimsOf(context));
    if (claims === undefined) {
      throw new Error(
        `Call to ${this.options.service} outside an organization context: pass explicit claims.`,
      );
    }
    const url: URL = this.resolve(path);
    const method: string = (init.method ?? 'GET').toUpperCase();
    const headers: Headers = new Headers(init.headers);
    const retryable: boolean =
      (init.idempotent ?? (IDEMPOTENT_METHODS.has(method) || headers.has('Idempotency-Key'))) &&
      (init.body === undefined || init.body === null || typeof init.body === 'string');
    const request: object | undefined = currentRequest();
    const requestId: string | undefined = request === undefined ? undefined : requestIdOf(request);
    if (requestId !== undefined) {
      headers.set(REQUEST_ID_HEADER, requestId);
    }
    if (!headers.has('Accept')) {
      headers.set('Accept', `application/json, ${PROBLEM_CONTENT_TYPE}`);
    }
    let failure: UpstreamFailure | undefined;
    for (let attempt: number = 1; attempt <= 2; attempt += 1) {
      const timeoutMs: number = Math.floor(
        Math.min(this.callTimeoutMs, remainingBudgetMs() ?? this.callTimeoutMs),
      );
      if (timeoutMs <= 0) {
        throw this.unavailable(failure === undefined ? 'deadline-exceeded' : failure.kind, failure);
      }
      headers.set(
        'Authorization',
        `Bearer ${await this.options.signer.sign(this.options.service, claims)}`,
      );
      headers.set(REQUEST_TIMEOUT_HEADER, String(timeoutMs));
      let response: Response;
      try {
        response = await this.breaker.execute(() =>
          this.attempt(url, { ...init, method, headers }, timeoutMs),
        );
      } catch (error) {
        if (error instanceof BrokenCircuitError) {
          throw this.unavailable('circuit-open', error);
        }
        if (!(error instanceof UpstreamFailure)) {
          throw error;
        }
        failure = error;
        if (
          retryable &&
          attempt === 1 &&
          (error.kind === 'unreachable' || error.kind === 'unavailable')
        ) {
          continue;
        }
        throw this.unavailable(error.kind, error);
      }
      if (response.status >= 400) {
        throw await this.clientError(response);
      }
      return response;
    }
    throw this.unavailable(failure?.kind ?? 'failed', failure);
  }

  /**
   * Method resolve
   *
   * @description
   * Resolves a route against the base URL and refuses anything that would leave the called
   * service: the internal token must never be sent to another origin.
   *
   * @param {string} path - Path of the route, starting with one slash.
   * @returns {URL} The address to call.
   * @throws {Error} When the path is not a path of the called service: a programming error.
   */
  private resolve(path: string): URL {
    const base: URL = new URL(this.options.baseUrl);
    const url: URL = new URL(path, base);
    if (!path.startsWith('/') || url.origin !== base.origin) {
      throw new Error(`Call to ${this.options.service}: the path must be a path of that service.`);
    }
    return url;
  }

  /**
   * Method attempt
   *
   * @description
   * Sends the call once. A connection error, a timeout and a server error reject, so the circuit
   * breaker counts them; a client error resolves.
   *
   * @param {URL} url - Address of the route, already checked against the base URL.
   * @param {RequestInit} init - Options of `fetch`, with the final headers.
   * @param {number} timeoutMs - Time granted to this attempt, in milliseconds.
   * @returns {Promise<Response>} The response, whose status is below 500.
   * @throws {UpstreamFailure} When the service did not answer or answered a server error.
   */
  private async attempt(url: URL, init: RequestInit, timeoutMs: number): Promise<Response> {
    const timeout: AbortSignal = AbortSignal.timeout(timeoutMs);
    const caller: AbortSignal | null | undefined = init.signal;
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        ...init,
        // A redirect would carry the internal token to wherever it points.
        redirect: 'error',
        signal:
          caller === undefined || caller === null ? timeout : AbortSignal.any([caller, timeout]),
      });
    } catch (error) {
      if (caller?.aborted === true) {
        throw caller.reason;
      }
      if (timeout.aborted) {
        throw new UpstreamFailure('timeout', timeoutMs >= this.callTimeoutMs, error);
      }
      throw new UpstreamFailure('unreachable', true, error);
    }
    if (response.status >= 500) {
      await response.body?.cancel();
      throw new UpstreamFailure(response.status === 503 ? 'unavailable' : 'failed', true);
    }
    return response;
  }

  /**
   * Method unavailable
   *
   * @description
   * Builds the problem thrown when the called service could not serve the call.
   *
   * @param {string} reason - Last part of the `upstream.*` code.
   * @param {unknown} cause - Underlying error, kept for the logs.
   * @returns {ProblemException} A 503 problem naming the called service.
   */
  private unavailable(reason: string, cause?: unknown): ProblemException {
    return new ProblemException({
      status: 503,
      code: `upstream.${reason}`,
      detail: 'A service this request depends on is not available.',
      details: { service: this.options.service },
      cause,
    });
  }

  /**
   * Method clientError
   *
   * @description
   * Converts a client-error response of the called service into the problem to throw: relayed
   * with its code when the status is one a caller may see, replaced by a 503 otherwise.
   *
   * @param {Response} response - Response whose status is between 400 and 499.
   * @returns {Promise<ProblemException>} The problem to throw.
   */
  private async clientError(response: Response): Promise<ProblemException> {
    let upstream: Record<string, unknown> = {};
    try {
      const parsed: unknown =
        Number(response.headers.get('content-length') ?? 0) > MAX_PROBLEM_BYTES
          ? undefined
          : await response.json();
      if (typeof parsed === 'object' && parsed !== null) {
        upstream = parsed as Record<string, unknown>;
      }
    } catch {
      upstream = {};
    }
    if (response.status === 401) {
      return this.unavailable('unauthorized');
    }
    const upstreamDetails: unknown = upstream.details;
    return new ProblemException({
      status: (RELAYED_STATUSES.has(response.status) ? response.status : 400) as ProblemStatus,
      code: typeof upstream.code === 'string' ? upstream.code : 'upstream.error',
      ...(typeof upstream.title === 'string' ? { title: upstream.title } : {}),
      ...(typeof upstream.detail === 'string' ? { detail: upstream.detail } : {}),
      details: {
        ...(typeof upstreamDetails === 'object' && upstreamDetails !== null ? upstreamDetails : {}),
        service: this.options.service,
      },
    });
  }
  // #endregion
}
