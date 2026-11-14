import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Constant REQUEST_TIMEOUT_HEADER
 *
 * @description
 * Header carrying the time a caller still grants a call, in whole milliseconds. It is relative,
 * not a wall-clock instant, so it does not depend on the clocks of two hosts agreeing.
 *
 * @type {string}
 */
export const REQUEST_TIMEOUT_HEADER: string = 'X-Request-Timeout-Ms';

/**
 * Constant DEFAULT_REQUEST_BUDGET_MS
 *
 * @description
 * Time a request may take when its caller states nothing: the 10 seconds of a public route.
 *
 * @type {number}
 */
export const DEFAULT_REQUEST_BUDGET_MS: number = 10_000;

/**
 * Interface RequestDeadline
 *
 * @description
 * Deadline of the request being handled, and the request itself to read its id from.
 */
interface RequestDeadline {
  // #region Properties
  /**
   * Property expiresAt
   *
   * @description
   * Instant the budget of the request runs out, on the monotonic clock, in milliseconds.
   *
   * @type {number}
   * @readonly
   */
  readonly expiresAt: number;

  /**
   * Property request
   *
   * @description
   * Incoming request, when the deadline was opened by the HTTP middleware.
   *
   * @type {object | undefined}
   * @readonly
   */
  readonly request?: object;
  // #endregion
}

/**
 * Interface RequestDeadlineOptions
 *
 * @description
 * Options of `requestDeadlineMiddleware`.
 */
export interface RequestDeadlineOptions {
  // #region Properties
  /**
   * Property budgetMs
   *
   * @description
   * Largest time a request may take, in milliseconds. A caller can only shorten it. Defaults to
   * 10 000.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly budgetMs?: number;

  /**
   * Property acceptIncoming
   *
   * @description
   * Lets the caller shorten the budget with `X-Request-Timeout-Ms`. Defaults to `true`, for a
   * service called by a gateway; a public edge sets it to `false`, so a client cannot make its
   * own requests fail early.
   *
   * @type {boolean | undefined}
   * @readonly
   */
  readonly acceptIncoming?: boolean;
  // #endregion
}

/**
 * Constant storage
 *
 * @description
 * Carries the deadline along the asynchronous work of one request.
 *
 * @type {AsyncLocalStorage<RequestDeadline>}
 */
const storage: AsyncLocalStorage<RequestDeadline> = new AsyncLocalStorage<RequestDeadline>();

/**
 * Function runWithDeadline
 *
 * @description
 * Runs work under a time budget. Calls made by the internal HTTP client inside the work get the
 * time left, never more.
 *
 * @param {number} budgetMs - Time granted to the work, in milliseconds.
 * @param {() => TResult} work - Work to run.
 * @returns {TResult} What the work returns.
 */
export function runWithDeadline<TResult>(budgetMs: number, work: () => TResult): TResult {
  return storage.run({ expiresAt: performance.now() + budgetMs }, work);
}

/**
 * Function remainingBudgetMs
 *
 * @description
 * Returns the time left to the current request.
 *
 * @returns {number | undefined} Milliseconds left, zero or less once exhausted; `undefined` outside any deadline.
 */
export function remainingBudgetMs(): number | undefined {
  const deadline: RequestDeadline | undefined = storage.getStore();
  return deadline === undefined ? undefined : deadline.expiresAt - performance.now();
}

/**
 * Function currentRequest
 *
 * @description
 * Returns the incoming request the current work belongs to.
 *
 * @returns {object | undefined} The request, or `undefined` outside an HTTP request.
 */
export function currentRequest(): object | undefined {
  return storage.getStore()?.request;
}

/**
 * Function requestDeadlineMiddleware
 *
 * @description
 * Builds the Express middleware that opens the deadline of each request: the budget of the
 * application, shortened to `X-Request-Timeout-Ms` when the caller sends a smaller positive
 * integer. A missing, malformed or larger header leaves the budget unchanged.
 *
 * The middleware does not interrupt a handler that overruns: it only bounds the calls the
 * handler makes to other services.
 *
 * @param {RequestDeadlineOptions} options - Budget of the application.
 * @returns {(request: object, response: unknown, next: () => void) => void} The middleware.
 */
export function requestDeadlineMiddleware(
  options: RequestDeadlineOptions = {},
): (request: object, response: unknown, next: () => void) => void {
  const budgetMs: number = options.budgetMs ?? DEFAULT_REQUEST_BUDGET_MS;
  return (request: object, _response: unknown, next: () => void): void => {
    const header: unknown = (request as { headers?: Record<string, unknown> }).headers?.[
      REQUEST_TIMEOUT_HEADER.toLowerCase()
    ];
    const granted: number =
      options.acceptIncoming !== false &&
      typeof header === 'string' &&
      /^[1-9]\d{0,8}$/u.test(header)
        ? Number(header)
        : budgetMs;
    storage.run({ expiresAt: performance.now() + Math.min(budgetMs, granted), request }, next);
  };
}
