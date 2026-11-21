import {
  createParamDecorator,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { tap, type Observable } from 'rxjs';

import { ProblemException } from '../../problem/problem.js';

/**
 * Type IfMatchCondition
 *
 * @description
 * Parsed `If-Match` header: the versions the caller accepts, `'*'` for any existing version, or
 * `undefined` when the header is absent.
 *
 * @type {readonly number[] | '*' | undefined}
 */
export type IfMatchCondition = readonly number[] | '*' | undefined;

/**
 * Interface VersionCheckOptions
 *
 * @description
 * Options of `assertVersionMatch`.
 */
export interface VersionCheckOptions {
  // #region Properties
  /**
   * Property required
   *
   * @description
   * Refuses a request without `If-Match`. Defaults to `false`: the header is optional, except on
   * routes that edit long texts, which set this.
   *
   * @type {boolean | undefined}
   * @readonly
   */
  readonly required?: boolean;
  // #endregion
}

/**
 * Function invalidIfMatch
 *
 * @description
 * Builds the problem answered to an `If-Match` header that is malformed, or absent where the
 * route requires it: `400 request.invalid`, the code the contracts declare for a request that
 * does not match its schema, with one `details.issues` entry on the header. The header value is
 * never quoted.
 *
 * @param {'invalid_format' | 'invalid_type'} code - Issue code: `invalid_format` for a malformed header, `invalid_type` for a missing one.
 * @param {string} message - Expectation the header did not meet.
 * @returns {ProblemException} A 400 `request.invalid` problem.
 */
function invalidIfMatch(
  code: 'invalid_format' | 'invalid_type',
  message: string,
): ProblemException {
  return new ProblemException({
    status: 400,
    code: 'request.invalid',
    detail: 'The request does not match its contract.',
    details: { issues: [{ in: 'header', path: 'If-Match', code, message }] },
  });
}

/**
 * Function formatEtag
 *
 * @description
 * Formats the version of an aggregate as its strong `ETag`.
 *
 * @param {number} version - Version of the aggregate, a non-negative integer.
 * @returns {string} The entity tag, such as `"7"`, quotes included.
 */
export function formatEtag(version: number): string {
  return `"${String(version)}"`;
}

/**
 * Function parseIfMatch
 *
 * @description
 * Parses an `If-Match` header into the versions the caller accepts. The list grammar
 * allows commas inside an opaque tag. A tag contributes a version only when it is strong
 * and exactly matches the decimal representation the kit emits.
 *
 * @param {string | undefined} header - Value of the `If-Match` header.
 * @returns {IfMatchCondition} The accepted versions, `'*'`, or `undefined` when the header is absent.
 * @throws {ProblemException} 400 `request.invalid`, with one issue `{ in: 'header', path: 'If-Match', code: 'invalid_format' }`, when the header is not a list of entity tags.
 */
export function parseIfMatch(header: string | undefined): IfMatchCondition {
  if (header === undefined || /^[ \t]*$/u.test(header)) {
    return undefined;
  }
  if (/^[ \t]*\*[ \t]*$/u.test(header)) {
    return '*';
  }
  const separators = /[ \t,]*/uy;
  const entityTag = /(W\/)?"([\x21\x23-\x7e\x80-\xff]*)"[ \t]*(?:,|$)/uy;
  const versions: number[] = [];
  let offset = 0;
  while (offset < header.length) {
    separators.lastIndex = offset;
    separators.exec(header);
    offset = separators.lastIndex;
    if (offset === header.length) {
      break;
    }
    entityTag.lastIndex = offset;
    const match: RegExpExecArray | null = entityTag.exec(header);
    if (match === null) {
      throw invalidIfMatch('invalid_format', 'Expected "*" or a list of quoted entity tags.');
    }
    offset = entityTag.lastIndex;
    const value: string = match[2] ?? '';
    if (match[1] === undefined && /^(?:0|[1-9]\d*)$/u.test(value)) {
      const version = Number(value);
      if (Number.isSafeInteger(version)) {
        versions.push(version);
      }
    }
  }
  return versions;
}

/**
 * Function assertVersionMatch
 *
 * @description
 * Checks the current version of an aggregate against the `If-Match` condition of the request.
 * Call it where the version is read, inside the transaction that writes and after the permission
 * check: a caller who may not read the aggregate must not learn its version.
 *
 * @param {IfMatchCondition} condition - Parsed `If-Match` header.
 * @param {number} currentVersion - Version of the aggregate as stored.
 * @param {VersionCheckOptions} options - Whether the header is mandatory.
 * @throws {ProblemException} 412 `request.version-mismatch`, with the stored version as `details.version`, when the versions differ; 400 `request.invalid`, with one issue `{ in: 'header', path: 'If-Match', code: 'invalid_type' }`, when the header is mandatory and absent.
 */
export function assertVersionMatch(
  condition: IfMatchCondition,
  currentVersion: number,
  options: VersionCheckOptions = {},
): void {
  if (condition === undefined) {
    if (options.required === true) {
      throw invalidIfMatch('invalid_type', 'This route requires an If-Match header.');
    }
    return;
  }
  if (condition !== '*' && !condition.includes(currentVersion)) {
    throw new ProblemException({
      status: 412,
      code: 'request.version-mismatch',
      detail: 'The resource changed since it was read.',
      details: { version: currentVersion },
    });
  }
}

/**
 * Constant IfMatch
 *
 * @description
 * Parameter decorator that hands the parsed `If-Match` header to a controller method:
 * `@IfMatch() condition: IfMatchCondition`. A malformed header answers 400.
 *
 * @type {() => ParameterDecorator}
 */
export const IfMatch: () => ParameterDecorator = createParamDecorator(
  (_data: unknown, context: ExecutionContext): IfMatchCondition => {
    const request: { headers: Record<string, string | string[] | undefined> } = context
      .switchToHttp()
      .getRequest();
    const header: string | string[] | undefined = request.headers['if-match'];
    return parseIfMatch(Array.isArray(header) ? header.join(',') : header);
  },
);

/**
 * Class EtagInterceptor
 *
 * @description
 * Sets the `ETag` header from the `version` of the returned aggregate: when a handler returns an
 * object whose `version` is a non-negative integer, the response carries `ETag: "<version>"`.
 * A list, a body without `version`, and a response that already has an `ETag` are left alone.
 */
@Injectable()
export class EtagInterceptor implements NestInterceptor {
  // #region Methods
  /**
   * Method intercept
   *
   * @description
   * Lets the handler run, then sets the header from its result.
   *
   * @param {ExecutionContext} context - Execution context of the request.
   * @param {CallHandler} next - Rest of the request pipeline.
   * @returns {Observable<unknown>} The response stream, unchanged.
   */
  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const response: {
      headersSent: boolean;
      getHeader(name: string): unknown;
      setHeader(name: string, value: string): unknown;
    } = context.switchToHttp().getResponse();
    return next.handle().pipe(
      tap((body: unknown) => {
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          return;
        }
        const version: unknown = (body as { version?: unknown }).version;
        if (
          typeof version === 'number' &&
          Number.isSafeInteger(version) &&
          version >= 0 &&
          !response.headersSent &&
          response.getHeader('ETag') === undefined
        ) {
          response.setHeader('ETag', formatEtag(version));
        }
      }),
    );
  }
  // #endregion
}
