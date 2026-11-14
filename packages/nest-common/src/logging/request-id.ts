import { randomUUID } from 'node:crypto';

/**
 * Constant REQUEST_ID_HEADER
 *
 * @description
 * Header that carries the request id: read on the request, always set on the response, and shown
 * by the web application as the error reference.
 *
 * @type {string}
 */
export const REQUEST_ID_HEADER: string = 'X-Request-Id';

/**
 * Constant REQUEST_ID_PATTERN
 *
 * @description
 * Shape an incoming request id must have to be kept: 8 to 128 characters among letters, digits,
 * `.`, `_`, `:` and `-`. Anything else is replaced, so a caller cannot inject text into the logs.
 *
 * @type {RegExp}
 */
const REQUEST_ID_PATTERN: RegExp = /^[A-Za-z0-9._:-]{8,128}$/u;

/**
 * Function resolveRequestId
 *
 * @description
 * Returns the id of a request: the incoming header when it is accepted and well formed, a new
 * random UUID otherwise.
 *
 * @param {string | readonly string[] | undefined} incoming - Value of the incoming `X-Request-Id` header.
 * @param {boolean} acceptIncoming - Whether a caller-supplied id may be kept; defaults to `true`.
 * @returns {string} The request id.
 */
export function resolveRequestId(
  incoming: string | readonly string[] | undefined,
  acceptIncoming: boolean = true,
): string {
  if (acceptIncoming && typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)) {
    return incoming;
  }
  return randomUUID();
}

/**
 * Function requestIdOf
 *
 * @description
 * Reads the id the logging middleware attached to a request.
 *
 * @param {object} request - Incoming request, as seen by a guard, an interceptor or a filter.
 * @returns {string | undefined} The request id, or `undefined` when the logging module is not installed.
 */
export function requestIdOf(request: object): string | undefined {
  const id: unknown = (request as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}
