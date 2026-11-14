import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';

import { PROBLEM_CONTENT_TYPE, ProblemException, statusTitle, type Problem } from './problem.js';

/**
 * Interface ProblemResponse
 *
 * @description
 * Part of the Express response the filter uses.
 */
interface ProblemResponse {
  // #region Properties
  /**
   * Property headersSent
   *
   * @description
   * Whether the response already started; nothing can be written then.
   *
   * @type {boolean}
   * @readonly
   */
  readonly headersSent: boolean;

  /**
   * Property err
   *
   * @description
   * Error read by the request logger, which then writes it on the completion line.
   *
   * @type {unknown}
   */
  err?: unknown;
  // #endregion

  // #region Methods
  /**
   * Method status
   *
   * @description
   * Sets the HTTP status.
   *
   * @param {number} code - HTTP status.
   * @returns {ProblemResponse} The response, for chaining.
   */
  status(code: number): ProblemResponse;

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

  /**
   * Method json
   *
   * @description
   * Serializes and sends the body, keeping a content type that was already set.
   *
   * @param {unknown} body - Response body.
   * @returns {unknown} Ignored.
   */
  json(body: unknown): unknown;
  // #endregion
}

/**
 * Constant DEFAULT_CODES
 *
 * @description
 * Code given to an error that carries a status but no code of its own.
 *
 * @type {Readonly<Record<number, string>>}
 */
const DEFAULT_CODES: Readonly<Record<number, string>> = {
  400: 'http.bad-request',
  401: 'http.unauthorized',
  403: 'http.forbidden',
  404: 'http.not-found',
  409: 'http.conflict',
  412: 'http.precondition-failed',
  422: 'http.unprocessable-content',
  429: 'http.too-many-requests',
  500: 'internal.unexpected',
  503: 'http.service-unavailable',
};

/**
 * Function allowedStatus
 *
 * @description
 * Maps any HTTP status to one a Cadenway error response may carry: an unknown client error
 * becomes 400, an unknown server error 503. 500 is kept for the unexpected failure, which is a
 * defect and must not look retryable.
 *
 * @param {number} status - Status carried by the error.
 * @returns {number} A status of the allowed set, or 500.
 */
function allowedStatus(status: number): number {
  if (status in DEFAULT_CODES) {
    return status;
  }
  return status >= 400 && status < 500 ? 400 : 503;
}

/**
 * Function externalStatus
 *
 * @description
 * Reads the status of an error raised by an Express middleware, such as the body parser, which
 * is not an `HttpException`.
 *
 * @param {unknown} exception - Error caught by the filter.
 * @returns {number | undefined} Its client error status, or `undefined` when it carries none.
 */
function externalStatus(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null) {
    return undefined;
  }
  const status: unknown =
    (exception as { status?: unknown }).status ??
    (exception as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : undefined;
}

/**
 * Function toProblem
 *
 * @description
 * Converts anything thrown into the problem sent to the caller. The text of an unexpected error
 * never leaves the process: only a `ProblemException` and a client-error `HttpException` speak
 * to the caller.
 *
 * @param {unknown} exception - Error caught by the filter.
 * @returns {Problem} The response body.
 */
export function toProblem(exception: unknown): Problem {
  if (exception instanceof ProblemException) {
    return exception.problem;
  }
  const raw: number | undefined =
    exception instanceof HttpException ? exception.getStatus() : externalStatus(exception);
  if (raw === 413) {
    return {
      type: 'about:blank',
      title: statusTitle(400),
      status: 400,
      code: 'request.body-too-large',
      detail: 'The request body exceeds the size limit.',
    };
  }
  const status: number = raw === undefined ? 500 : allowedStatus(raw);
  return {
    type: 'about:blank',
    title: statusTitle(status),
    status,
    code: DEFAULT_CODES[status] ?? 'internal.unexpected',
    ...(exception instanceof HttpException && status < 500 ? { detail: exception.message } : {}),
  };
}

/**
 * Class ProblemFilter
 *
 * @description
 * Turns every error of an HTTP request into an `application/problem+json` response (RFC 9457)
 * with a stable `code`.
 *
 * | Thrown                                 | Response                                              |
 * | -------------------------------------- | ----------------------------------------------------- |
 * | `ProblemException`                     | Its problem, as is                                    |
 * | `HttpException` with an allowed status | That status, an `http.*` code, the message as detail  |
 * | `HttpException` with another status    | 400 for a client error, 503 for a server error        |
 * | Body larger than the limit             | 400 `request.body-too-large`                          |
 * | Anything else                          | 500 `internal.unexpected`, with no detail             |
 *
 * A stack trace is never sent. A response from 500 hands its error to the request logger, which
 * writes it on the completion line. Outside HTTP the error is thrown again untouched.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  // #region Methods
  /**
   * Method catch
   *
   * @description
   * Writes the problem response, unless the response already started.
   *
   * @param {unknown} exception - Error thrown while handling the request.
   * @param {ArgumentsHost} host - Execution context of the request.
   * @returns {void}
   */
  public catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      throw exception;
    }
    const response: ProblemResponse = host.switchToHttp().getResponse();
    const problem: Problem = toProblem(exception);
    if (problem.status >= 500) {
      response.err = exception;
    }
    if (response.headersSent) {
      return;
    }
    if (problem.status === 401) {
      response.setHeader('WWW-Authenticate', 'Bearer');
    }
    response.setHeader('Content-Type', PROBLEM_CONTENT_TYPE);
    response.status(problem.status).json(problem);
  }
  // #endregion
}
