import type { IncomingMessage, ServerResponse } from 'node:http';

import bodyParser from 'body-parser';

import { ProblemException } from '../../problem/problem.js';
import type { ValidationIssue } from '../../validation/zod-validation.pipe.js';

/**
 * Constant JSON_BODY_LIMIT_BYTES
 *
 * @description
 * Largest JSON request body accepted: 1 MB, the limit of the contract style.
 *
 * @type {number}
 */
export const JSON_BODY_LIMIT_BYTES: number = 1_048_576;

/**
 * Constant JSON_PARSE_FAILURE
 *
 * @description
 * `type` the body parser of Express gives the error of a body that is not valid JSON. That error
 * carries the text of `JSON.parse`, which quotes the characters around the faulty token, and the
 * whole body in its `body` member.
 *
 * @type {string}
 */
const JSON_PARSE_FAILURE: string = 'entity.parse.failed';

/**
 * Constant MALFORMED_JSON_DETAIL
 *
 * @description
 * Detail of the problem a body that is not valid JSON receives, the same for every body.
 *
 * @type {string}
 */
const MALFORMED_JSON_DETAIL: string = 'The request body is not valid JSON.';

/**
 * Constant MALFORMED_JSON_ISSUE
 *
 * @description
 * The single `details.issues` entry of that problem: the body itself, with no path.
 *
 * @type {ValidationIssue}
 */
const MALFORMED_JSON_ISSUE: ValidationIssue = Object.freeze({
  in: 'body',
  path: '',
  code: 'invalid_json',
  message: 'Expected valid JSON.',
});

/**
 * Type JsonBodyMiddleware
 *
 * @description
 * Express middleware that reads the JSON body of a request.
 *
 * @type {(request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => void}
 */
type JsonBodyMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => void;

/**
 * Interface BodyParserHost
 *
 * @description
 * Part of the NestJS Express application used to register the JSON body parser.
 */
export interface BodyParserHost {
  // #region Methods
  /**
   * Method use
   *
   * @description
   * Registers an Express middleware on the application. A NestJS Express application has it;
   * `applyJsonBodyLimit` then registers the parser of this package, which never hands on the
   * text of a malformed body.
   *
   * @param {(request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => void} handler - Middleware to register.
   * @returns {unknown} Ignored.
   */
  use?(
    handler: (
      request: IncomingMessage,
      response: ServerResponse,
      next: (error?: unknown) => void,
    ) => void,
  ): unknown;

  /**
   * Method useBodyParser
   *
   * @description
   * Registers a body parser of Express on the application. `applyJsonBodyLimit` calls it only on
   * a host without `use`: the parser NestJS builds then refuses a malformed body, `ProblemFilter`
   * answers it with the same fixed problem, but the parser error, with its text, still reaches
   * the span of the Express instrumentation.
   *
   * @param {'json'} type - Parser to register.
   * @param {{ limit: number; }} options - Options of the parser.
   * @returns {unknown} Ignored.
   */
  useBodyParser(type: 'json', options: { limit: number }): unknown;
  // #endregion
}

/**
 * Function isJsonParseFailure
 *
 * @description
 * Tells whether an error is the body parser refusing a body that is not valid JSON, including a
 * top-level value its strict mode refuses.
 *
 * @param {unknown} error - Error to inspect.
 * @returns {boolean} `true` for that refusal only; a body over the limit, an unsupported charset or an aborted request is another error.
 */
export function isJsonParseFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { type?: unknown }).type === JSON_PARSE_FAILURE
  );
}

/**
 * Function malformedJsonBody
 *
 * @description
 * Builds the problem a body that is not valid JSON receives: 400 `request.invalid`, the code the
 * contracts declare for a body that does not match its schema, with a fixed detail and one
 * `details.issues` entry for the body itself. Nothing of the body or of the parser error goes in
 * it, not even as its cause: the parser error holds the body.
 *
 * @returns {ProblemException} A new exception, so its stack is that of the current request.
 */
export function malformedJsonBody(): ProblemException {
  return new ProblemException({
    status: 400,
    code: 'request.invalid',
    detail: MALFORMED_JSON_DETAIL,
    details: { issues: [MALFORMED_JSON_ISSUE] },
  });
}

/**
 * Function jsonBodyParser
 *
 * @description
 * Builds the JSON body parser of Express (`body-parser`, as NestJS registers it) with a size limit,
 * and replaces its refusal of a body that is not valid JSON with `malformedJsonBody()` before
 * handing it on. Everything downstream then sees the fixed problem only: the NestJS exception
 * layer, `ProblemFilter`, and the span the Express instrumentation opens around this middleware,
 * which records the error the middleware hands on. Every other outcome, a body over the limit
 * included, is handed on unchanged.
 *
 * The middleware is named `jsonParser`, like the parser of `body-parser`: NestJS looks for that
 * name in the router before it adds its own JSON parser, with a lower limit. The Express
 * instrumentation wraps the handler under another name, so with telemetry on NestJS adds its
 * parser after this one anyway; it finds the body already read and hands on without parsing,
 * and after a refusal Express skips it.
 *
 * @param {number} limitBytes - Largest accepted body, in bytes.
 * @returns {JsonBodyMiddleware} The middleware.
 */
function jsonBodyParser(limitBytes: number): JsonBodyMiddleware {
  const parse: JsonBodyMiddleware = bodyParser.json({ limit: limitBytes });
  return function jsonParser(
    request: IncomingMessage,
    response: ServerResponse,
    next: (error?: unknown) => void,
  ): void {
    parse(request, response, (error?: unknown): void => {
      if (error === undefined || error === null) {
        next();
        return;
      }
      next(isJsonParseFailure(error) ? malformedJsonBody() : error);
    });
  };
}

/**
 * Function applyJsonBodyLimit
 *
 * @description
 * Registers the JSON body parser with the Cadenway size limit. Call it before the application
 * is initialized, so the parser runs before the JSON parser NestJS adds, whose limit is lower.
 *
 * - A larger body is refused by the parser and answered 400 `request.body-too-large` by the
 *   problem filter.
 * - A body that is not valid JSON is answered 400 `request.invalid` with a fixed detail; the
 *   text of the parser error, which quotes part of the body, reaches neither the response nor
 *   the logs nor the trace.
 *
 * On a host with `use`, such as a NestJS Express application, the parser is the one of this
 * package. It does not keep the raw body: the `rawBody` option of NestJS has no effect on JSON
 * bodies. A host without `use` gets the parser of NestJS through `useBodyParser`, as before: its
 * response is the same, but the trace records the parser text.
 *
 * @param {BodyParserHost} app - NestJS application on the Express platform.
 * @param {number} limitBytes - Largest accepted body, in bytes; defaults to `JSON_BODY_LIMIT_BYTES`.
 */
export function applyJsonBodyLimit(
  app: BodyParserHost,
  limitBytes: number = JSON_BODY_LIMIT_BYTES,
): void {
  if (app.use === undefined) {
    app.useBodyParser('json', { limit: limitBytes });
    return;
  }
  app.use(jsonBodyParser(limitBytes));
}
