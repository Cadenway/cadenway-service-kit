import { HttpException } from '@nestjs/common';

/**
 * Constant PROBLEM_CONTENT_TYPE
 *
 * @description
 * Media type of every error response (RFC 9457).
 *
 * @type {string}
 */
export const PROBLEM_CONTENT_TYPE: string = 'application/problem+json';

/**
 * Type ProblemStatus
 *
 * @description
 * Error statuses the Cadenway contracts allow.
 *
 * @type {400 | 401 | 403 | 404 | 409 | 412 | 422 | 429 | 503}
 */
export type ProblemStatus = 400 | 401 | 403 | 404 | 409 | 412 | 422 | 429 | 503;

/**
 * Interface Problem
 *
 * @description
 * Body of an error response: an RFC 9457 problem with the Cadenway extensions `code` and
 * `details`. `type`, `title`, `status` and `code` are always present.
 */
export interface Problem {
  // #region Properties
  /**
   * Property type
   *
   * @description
   * URI reference of the problem type. `about:blank` unless the thrower names one.
   *
   * @type {string}
   * @readonly
   */
  readonly type: string;

  /**
   * Property title
   *
   * @description
   * Short human summary of the problem type, in English. Applications translate from `code`.
   *
   * @type {string}
   * @readonly
   */
  readonly title: string;

  /**
   * Property status
   *
   * @description
   * HTTP status of the response.
   *
   * @type {number}
   * @readonly
   */
  readonly status: number;

  /**
   * Property code
   *
   * @description
   * Stable machine code, `<domain>.<reason>` with each part in kebab-case.
   *
   * @type {string}
   * @readonly
   */
  readonly code: string;

  /**
   * Property detail
   *
   * @description
   * Human explanation of this occurrence. Never a stack trace or an internal message.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly detail?: string;

  /**
   * Property instance
   *
   * @description
   * URI reference of this occurrence, when the thrower names one.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly instance?: string;

  /**
   * Property details
   *
   * @description
   * Machine-readable data about this occurrence, such as the list of validation issues.
   *
   * @type {Readonly<Record<string, unknown>> | undefined}
   * @readonly
   */
  readonly details?: Readonly<Record<string, unknown>>;
  // #endregion
}

/**
 * Interface ProblemInit
 *
 * @description
 * What a thrower gives to build a `ProblemException`.
 */
export interface ProblemInit {
  // #region Properties
  /**
   * Property status
   *
   * @description
   * HTTP status of the response, among those the contracts allow.
   *
   * @type {ProblemStatus}
   * @readonly
   */
  readonly status: ProblemStatus;

  /**
   * Property code
   *
   * @description
   * Stable machine code, `<domain>.<reason>` with each part in kebab-case.
   *
   * @type {string}
   * @readonly
   */
  readonly code: string;

  /**
   * Property title
   *
   * @description
   * Short human summary of the problem type. Defaults to the standard phrase of the status.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly title?: string;

  /**
   * Property detail
   *
   * @description
   * Human explanation of this occurrence, safe to show to the caller.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly detail?: string;

  /**
   * Property type
   *
   * @description
   * URI reference of the problem type. Defaults to `about:blank`.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly type?: string;

  /**
   * Property instance
   *
   * @description
   * URI reference of this occurrence.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly instance?: string;

  /**
   * Property details
   *
   * @description
   * Machine-readable data about this occurrence.
   *
   * @type {Readonly<Record<string, unknown>> | undefined}
   * @readonly
   */
  readonly details?: Readonly<Record<string, unknown>>;

  /**
   * Property cause
   *
   * @description
   * Underlying error, kept for the logs and never sent to the caller.
   *
   * @type {unknown | undefined}
   * @readonly
   */
  readonly cause?: unknown;
  // #endregion
}

/**
 * Constant STATUS_TITLES
 *
 * @description
 * Standard phrase of each status a problem can carry, used as the default title.
 *
 * @type {Readonly<Record<number, string>>}
 */
const STATUS_TITLES: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  412: 'Precondition Failed',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/**
 * Function statusTitle
 *
 * @description
 * Returns the standard phrase of a status a problem can carry.
 *
 * @param {number} status - HTTP status.
 * @returns {string} The standard phrase, or `Error` for a status outside the allowed set.
 */
export function statusTitle(status: number): string {
  return STATUS_TITLES[status] ?? 'Error';
}

/**
 * Class ProblemException
 *
 * @description
 * Error that leaves the application as an `application/problem+json` response. Throw it from an
 * HTTP adapter, a guard, a pipe or an interceptor; the problem filter writes the body.
 *
 * It extends `HttpException`, so code that only knows NestJS still reads its status.
 */
export class ProblemException extends HttpException {
  // #region Properties
  /**
   * Property problem
   *
   * @description
   * Body the filter writes, complete and frozen.
   *
   * @type {Problem}
   * @readonly
   */
  public readonly problem: Problem;
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Builds the problem body, filling the default type and title.
   *
   * @param {ProblemInit} init - Status, code and optional members of the problem.
   * @constructor
   */
  public constructor(init: ProblemInit) {
    const problem: Problem = Object.freeze({
      type: init.type ?? 'about:blank',
      title: init.title ?? statusTitle(init.status),
      status: init.status,
      code: init.code,
      ...(init.detail === undefined ? {} : { detail: init.detail }),
      ...(init.instance === undefined ? {} : { instance: init.instance }),
      ...(init.details === undefined ? {} : { details: init.details }),
    });
    super(problem, init.status, { cause: init.cause });
    this.name = 'ProblemException';
    this.message = `${init.code}: ${problem.detail ?? problem.title}`;
    this.problem = problem;
  }
  // #endregion
}
