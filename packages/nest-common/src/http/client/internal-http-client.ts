import { trace } from '@opentelemetry/api';
import {
  BrokenCircuitError,
  circuitBreaker,
  ConsecutiveBreaker,
  handleWhen,
  type CircuitBreakerPolicy,
} from 'cockatiel';

import type { InternalTokenSigner } from '../../auth/internal-token/internal-token-signer.js';
import type { InternalTokenClaims } from '../../auth/internal-token/internal-token.js';
import {
  getOrganizationContext,
  type OrganizationContext,
} from '../../auth/context/organization-context.js';
import { REQUEST_ID_HEADER, requestIdOf } from '../../logging/request-id.js';
import {
  PROBLEM_CONTENT_TYPE,
  ProblemException,
  type ProblemStatus,
} from '../../problem/problem.js';
import {
  currentRequest,
  remainingBudgetMs,
  REQUEST_TIMEOUT_HEADER,
} from '../deadline/request-deadline.js';
import { readUpstreamProblem } from './read-upstream-problem.js';
import { UpstreamFailure } from './upstream-failure.js';

/**
 * Constant MAX_CALL_TIMEOUT_MS
 *
 * @description
 * Longest ordinary call timeout, in milliseconds. For streams it bounds the response headers.
 *
 * @type {number}
 */
export const MAX_CALL_TIMEOUT_MS: number = 2000;

/**
 * Constant MAX_STREAM_TIMEOUT_MS
 *
 * @description
 * Longest total deadline for a call that explicitly requests a streaming response, in milliseconds.
 *
 * @type {number}
 */
const MAX_STREAM_TIMEOUT_MS: number = 120_000;

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
   * Longest time one ordinary call or the response headers of a streaming call may take, in
   * milliseconds. Defaults to 2000 and cannot exceed it; the current request may shorten it.
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
 * Options of one call: those of `fetch`, its internal identity, its retry policy and the optional
 * total deadline for a streaming response.
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

  /**
   * Property streamTimeoutMs
   *
   * @description
   * Opts in to a total deadline through consumption of the response body. The value must be a
   * positive safe integer in milliseconds; the client caps it at 120 000 and the current request
   * may shorten it. Response headers still have the ordinary call timeout. Omission keeps the
   * ordinary call timeout for both headers and body.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly streamTimeoutMs?: number;
  // #endregion
}

/**
 * Function streamExpiration
 *
 * @description
 * Opens the deadline shared by all attempts of a streaming call.
 *
 * @param {number} timeoutMs - Requested total deadline in milliseconds.
 * @returns {number} Expiration on the monotonic clock.
 * @throws {RangeError} When the requested deadline is not a positive safe integer.
 */
function streamExpiration(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('streamTimeoutMs must be a positive safe integer.');
  }
  return performance.now() + Math.min(timeoutMs, MAX_STREAM_TIMEOUT_MS);
}

/**
 * Type AttemptResponse
 *
 * @description
 * The response and the signal that still bounds reading its body.
 *
 * @type {readonly [ response: Response, signal: AbortSignal ]}
 */
type AttemptResponse = readonly [response: Response, signal: AbortSignal];

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
 * Function isRelayedStatus
 *
 * @description
 * Identifies client-error statuses the caller may receive unchanged.
 *
 * @param {number} status - HTTP status received from the called service.
 * @returns {status is ProblemStatus} True when the status can be relayed without changing it.
 */
function isRelayedStatus(status: number): status is ProblemStatus {
  return RELAYED_STATUSES.has(status);
}

/**
 * Constant RELAYED_STATUSES
 *
 * @description
 * Limits the upstream client errors returned with their original HTTP status.
 *
 * @type {ReadonlySet<number>}
 */
const RELAYED_STATUSES: ReadonlySet<number> = new Set([
  400, 403, 404, 409, 412, 422, 429,
] satisfies ProblemStatus[]);

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
 * | Deadline        | The request budget caps each call and is forwarded in `X-Request-Timeout-Ms`; ordinary calls get 2 seconds at most, streaming calls can opt in to a longer body deadline |
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
   * Longest time one ordinary call or the response headers of a streaming call may take.
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
   * @param {InternalRequestInit} init - Options of `fetch` with the internal call settings.
   * @returns {Promise<Response>} The response, whose status is below 400.
   * @throws {ProblemException} For failures reported before returning the response.
   * @throws {Error} When there is neither `claims` nor an organization context: a programming error.
   * @throws {RangeError} When `streamTimeoutMs` is present and invalid.
   */
  public async fetch(path: string, init: InternalRequestInit = {}): Promise<Response> {
    const { streamTimeoutMs, ...requestInit } = init;
    const streamExpiresAt: number | undefined =
      streamTimeoutMs === undefined ? undefined : streamExpiration(streamTimeoutMs);
    const remainingAttemptMs = (): number => {
      const limit: number =
        streamExpiresAt === undefined ? this.callTimeoutMs : streamExpiresAt - performance.now();
      return Math.floor(Math.min(limit, remainingBudgetMs() ?? limit));
    };

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
      let timeoutMs: number = remainingAttemptMs();
      if (timeoutMs <= 0) {
        throw this.unavailable(failure === undefined ? 'deadline-exceeded' : failure.kind, failure);
      }
      headers.set(
        'Authorization',
        `Bearer ${await this.options.signer.sign(this.options.service, claims)}`,
      );
      if (streamExpiresAt !== undefined) {
        timeoutMs = remainingAttemptMs();
        if (timeoutMs <= 0) {
          throw this.unavailable(
            failure === undefined ? 'deadline-exceeded' : failure.kind,
            failure,
          );
        }
      }
      headers.set(REQUEST_TIMEOUT_HEADER, String(timeoutMs));
      let result: AttemptResponse;
      try {
        result = await this.breaker.execute(() =>
          this.attempt(url, { ...requestInit, method, headers }, timeoutMs),
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
      const [response, signal]: AttemptResponse = result;
      if (response.status >= 400) {
        throw await this.clientError(response, signal);
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
   * Sends the call once. A disarmable header deadline enforces the ordinary timeout when the
   * attempt has a larger total budget. The native timeout and caller cancellation still bound
   * the body after the fetch resolves.
   *
   * @param {URL} url - Address of the route, already checked against the base URL.
   * @param {RequestInit} init - Options of `fetch`, with the final headers.
   * @param {number} timeoutMs - Time granted to this attempt, in milliseconds.
   * @returns {Promise<AttemptResponse>} The response below 500 and its signal.
   * @throws {UpstreamFailure} When the service did not answer or answered a server error.
   */
  private async attempt(url: URL, init: RequestInit, timeoutMs: number): Promise<AttemptResponse> {
    const timeout: AbortSignal = AbortSignal.timeout(timeoutMs);
    const caller: AbortSignal | null | undefined = init.signal;
    const headerDeadline: AbortController | undefined =
      timeoutMs > this.callTimeoutMs ? new AbortController() : undefined;
    const signals: AbortSignal[] = [timeout];
    if (caller !== undefined && caller !== null) {
      signals.push(caller);
    }
    if (headerDeadline !== undefined) {
      signals.push(headerDeadline.signal);
    }
    const signal: AbortSignal = signals.length === 1 ? timeout : AbortSignal.any(signals);
    const headerExpiresAt: number = performance.now() + this.callTimeoutMs;
    const headerTimer: NodeJS.Timeout | undefined =
      headerDeadline === undefined
        ? undefined
        : setTimeout(() => {
            headerDeadline.abort(new DOMException('Response headers timed out.', 'TimeoutError'));
          }, this.callTimeoutMs).unref();
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        ...init,
        // A redirect would carry the internal token to wherever it points.
        redirect: 'error',
        signal,
      });
    } catch (error) {
      if (caller?.aborted === true) {
        throw caller.reason;
      }
      if (timeout.aborted || headerDeadline?.signal.aborted === true) {
        throw new UpstreamFailure('timeout', timeoutMs >= this.callTimeoutMs, error);
      }
      throw new UpstreamFailure('unreachable', true, error);
    } finally {
      clearTimeout(headerTimer);
    }
    if (response.status >= 500) {
      // Classify the response even if the transport cannot release its body promptly.
      void response.body?.cancel().catch(() => undefined);
      throw new UpstreamFailure(response.status === 503 ? 'unavailable' : 'failed', true);
    }
    if (headerDeadline !== undefined && response.status >= 400) {
      const errorBudgetMs: number = Math.max(0, Math.floor(headerExpiresAt - performance.now()));
      return [response, AbortSignal.any([signal, AbortSignal.timeout(errorBudgetMs)])];
    }
    return [response, signal];
  }

  /**
   * Method unavailable
   *
   * @description
   * Builds the problem thrown when the called service could not serve the call.
   *
   * @param {string} reason - Last part of the `upstream.*` code.
   * @param {unknown | undefined} cause - Underlying error, kept for the logs.
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
   * Relays permitted client errors and masks an upstream internal-token rejection as a 503.
   *
   * @param {Response} response - Upstream response whose body may be read or canceled.
   * @param {AbortSignal} signal - Signal that cancels reading the upstream response body.
   * @returns {Promise<ProblemException>} The translated problem without the internal-token rejection body.
   */
  private async clientError(response: Response, signal: AbortSignal): Promise<ProblemException> {
    if (response.status === 401) {
      void response.body?.cancel().catch(() => undefined);
      return this.unavailable('unauthorized');
    }
    const upstream: Record<string, unknown> = await readUpstreamProblem(response, signal);
    const upstreamDetails: unknown = upstream.details;
    return new ProblemException({
      status: isRelayedStatus(response.status) ? response.status : 400,
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
