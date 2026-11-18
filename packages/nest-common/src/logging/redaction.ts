import { ClientRequest, IncomingMessage, OutgoingMessage, ServerResponse } from 'node:http';

import pino from 'pino';

import { routePatternOf } from '../http/routing/route.js';
import { requestIdOf } from './request-id.js';

/**
 * Constant REDACTED
 *
 * @description
 * Text written in place of a masked value.
 *
 * @type {string}
 */
export const REDACTED: string = '[REDACTED]';

/**
 * Constant DEFAULT_REDACTED_KEYS
 *
 * @description
 * Keys whose value is masked wherever they appear in a logged object: tokens, passwords,
 * cookies (the headers, and the session and trusted-device cookies by name, as in a parsed
 * cookie map), the `authorization` header, e-mail addresses, the secrets of two-step
 * verification (one-time and backup codes, the authenticator app secret and its `otpauth://`
 * URI, WebAuthn answers), key material and connection strings.
 * A key matches whatever its case and its separators: `accessToken`, `access_token` and
 * `Access-Token` are the same key. The `code` of an error logged under `err` is its machine
 * code, not a one-time code, and stays, as the Logs section of the package README describes.
 *
 * @type {readonly string[]}
 */
export const DEFAULT_REDACTED_KEYS: readonly string[] = [
  'authorization',
  'cookie',
  'set-cookie',
  '__Host-cw_session',
  '__Host-cw_trusted_device',
  'password',
  'currentPassword',
  'newPassword',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'sessionToken',
  'trustedDeviceToken',
  'secret',
  'otpauthUri',
  'code',
  'codes',
  'backupCodes',
  'credential',
  'clientSecret',
  'apiKey',
  'privateKey',
  'privateJwk',
  'internalTokenPrivateJwk',
  'databaseUrl',
  'connectionString',
  'email',
];

/**
 * Constant ERROR_CODE_KEY
 *
 * @description
 * Member of an `Error` that holds its machine code by the Node.js convention: the SQLSTATE of a
 * PostgreSQL error, a system error code such as `ECONNREFUSED`, a library code such as
 * `ERR_JWT_EXPIRED`. It stays on an error the error serializer handles although `code` is a
 * redacted key, which masks the one-time codes of request bodies in logged objects.
 *
 * @type {string}
 */
const ERROR_CODE_KEY: string = 'code';

/**
 * Constant ERROR_FIELD
 *
 * @description
 * Field of a line that holds the logged error, pino's `errorKey`, which the kit leaves at its
 * default. Pino takes the message of a line logged without one from the error in this field.
 *
 * @type {string}
 */
const ERROR_FIELD: string = 'err';

/**
 * Constant MESSAGE_FIELD
 *
 * @description
 * Field of a line that holds its message, pino's `messageKey`, which the kit leaves at its
 * default.
 *
 * @type {string}
 */
const MESSAGE_FIELD: string = 'msg';

/**
 * Constant SERIALIZED_FIELDS
 *
 * @description
 * Top-level fields of a line, or of the bindings of a logger, that the logger's own serializers
 * sanitize: the error under `err` (whose machine `code` stays) and the request and response
 * objects under `req` and `res`. The other fields go through `sanitizeLogValue`.
 *
 * @type {ReadonlySet<string>}
 */
const SERIALIZED_FIELDS: ReadonlySet<string> = new Set<string>([ERROR_FIELD, 'req', 'res']);

/**
 * Constant MAX_DEPTH
 *
 * @description
 * Number of nested levels of a logged object that are inspected. Anything deeper is masked
 * whole: a log line carries identifiers, not payloads.
 *
 * @type {number}
 */
const MAX_DEPTH: number = 6;

/**
 * Constant SQL_ERROR_KEYS
 *
 * @description
 * Members of a database error that carry SQL values and are dropped from a logged error: the
 * statement and parameters Drizzle attaches, and the `detail` and `where` texts of PostgreSQL,
 * which quote the offending row.
 *
 * @type {ReadonlySet<string>}
 */
const SQL_ERROR_KEYS: ReadonlySet<string> = new Set<string>([
  'query',
  'params',
  'parameters',
  'detail',
  'where',
  'internalQuery',
]);

/**
 * Constant EMAIL_PATTERN
 *
 * @description
 * Matches an e-mail address inside free text. Deliberately broad on the local part: masking a
 * look-alike costs nothing, leaking an address does. The last label of the domain must be
 * letters, as every top-level domain is: a version such as `nest-common@0.3.0` in a pnpm store
 * path of a stack trace is not an address and stays readable.
 *
 * @type {RegExp}
 */
const EMAIL_PATTERN: RegExp = /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}/gu;

/**
 * Constant SQLSTATE
 *
 * @description
 * Recognizes five-character SQLSTATE codes without copying arbitrary error codes to the log.
 *
 * @type {RegExp}
 */
const SQLSTATE: RegExp = /^[0-9A-Z]{5}$/u;
/**
 * Constant DATABASE_ERROR_MESSAGE
 *
 * @description
 * Replaces database diagnostics in the log without quoting query inputs.
 *
 * @type {string}
 */
const DATABASE_ERROR_MESSAGE: string = 'Database operation failed.';

/**
 * Function normalizeKey
 *
 * @description
 * Reduces a key to lower-case letters and digits, so one entry covers every spelling of it.
 *
 * @param {string} key - Key of a logged object.
 * @returns {string} The key without case or separators.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

/**
 * Function redactedKeySet
 *
 * @description
 * Builds the set of normalized keys to mask from the defaults and the keys an application adds.
 *
 * @param {readonly string[]} extraKeys - Keys masked in addition to the defaults.
 * @returns {ReadonlySet<string>} The normalized keys.
 */
export function redactedKeySet(extraKeys: readonly string[] = []): ReadonlySet<string> {
  return new Set<string>([...DEFAULT_REDACTED_KEYS, ...extraKeys].map(normalizeKey));
}

/**
 * Function maskEmails
 *
 * @description
 * Replaces every e-mail address found in a text by the redaction marker.
 *
 * @param {string} text - Log message or error text.
 * @returns {string} The text without e-mail addresses.
 */
export function maskEmails(text: string): string {
  return text.replace(EMAIL_PATTERN, REDACTED);
}

/**
 * Function httpMessageSummary
 *
 * @description
 * Describes an HTTP message found in a logged value by what the completion line of a request
 * already shows. Walking the object instead would write its raw headers (the cookies and the
 * bearer token of `rawHeaders`), its raw path and query string, the socket and its addresses,
 * and thousands of members of the server around it.
 *
 * @param {IncomingMessage | OutgoingMessage} message - Request or response object being logged.
 * @returns {Record<string, unknown>} `id`, `method` and `route` of a request, `statusCode` of a response, `method` of an outgoing request.
 */
function httpMessageSummary(message: IncomingMessage | OutgoingMessage): Record<string, unknown> {
  if (message instanceof IncomingMessage) {
    return { id: requestIdOf(message), method: message.method, route: routePatternOf(message) };
  }
  if (message instanceof ServerResponse) {
    return { statusCode: message.statusCode };
  }
  return message instanceof ClientRequest ? { method: message.method } : {};
}

/**
 * Function sanitizeLogValue
 *
 * @description
 * Returns a copy of a logged value that is safe to write: the value of every redacted key is
 * masked at any depth, e-mail addresses are masked inside every string, and whatever sits deeper
 * than six levels is masked whole. An `Error` found at any depth is written as `err` is, by
 * `sanitizeSerializedError`, and an HTTP request or response object as its `httpMessageSummary`.
 *
 * @param {unknown} value - Value about to be logged.
 * @param {ReadonlySet<string>} keys - Normalized keys to mask, from `redactedKeySet`.
 * @param {number} depth - Current nesting level; callers leave the default.
 * @returns {unknown} The sanitized copy.
 */
export function sanitizeLogValue(
  value: unknown,
  keys: ReadonlySet<string>,
  depth: number = 0,
): unknown {
  if (typeof value === 'string') {
    return maskEmails(value);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return REDACTED;
  }
  if (value instanceof Error) {
    return sanitizeSerializedError(pino.stdSerializers.err(value), keys, depth);
  }
  if (value instanceof IncomingMessage || value instanceof OutgoingMessage) {
    return httpMessageSummary(value);
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => sanitizeLogValue(item, keys, depth + 1));
  }
  if (value instanceof Date) {
    return value;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    sanitized[key] = keys.has(normalizeKey(key))
      ? REDACTED
      : sanitizeLogValue(member, keys, depth + 1);
  }
  return sanitized;
}

/**
 * Function sanitizeLogFields
 *
 * @description
 * Sanitizes the top-level fields of a line, or the bindings given to `child()` and
 * `setBindings()`, as `sanitizeLogValue` sanitizes an object, except the fields of
 * `SERIALIZED_FIELDS`, kept for the serializers pino applies right after: the error under `err`
 * keeps its machine `code` that way.
 *
 * @param {Readonly<Record<string, unknown>>} fields - Fields of the line or bindings.
 * @param {ReadonlySet<string>} keys - Normalized keys to mask, from `redactedKeySet`.
 * @returns {Record<string, unknown>} The sanitized copy.
 */
export function sanitizeLogFields(
  fields: Readonly<Record<string, unknown>>,
  keys: ReadonlySet<string>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(fields)) {
    if (keys.has(normalizeKey(key))) {
      sanitized[key] = REDACTED;
    } else {
      sanitized[key] = SERIALIZED_FIELDS.has(key) ? member : sanitizeLogValue(member, keys, 1);
    }
  }
  return sanitized;
}

/**
 * Function sanitizeHttpField
 *
 * @description
 * Serializer of the `req` and `res` fields. pino-http hands it the output of pino's standard
 * request or response serializer, which keeps the original object on `raw`: an HTTP message is
 * written as its `httpMessageSummary`, anything else is sanitized as a logged value.
 *
 * @param {unknown} value - Serialized request or response, or whatever was logged under the field.
 * @param {ReadonlySet<string>} keys - Normalized keys to mask, from `redactedKeySet`.
 * @returns {unknown} The sanitized field.
 */
export function sanitizeHttpField(value: unknown, keys: ReadonlySet<string>): unknown {
  const original: unknown =
    isRecord(value) &&
    (value.raw instanceof IncomingMessage || value.raw instanceof OutgoingMessage)
      ? value.raw
      : value;
  return sanitizeLogValue(original, keys);
}

/**
 * Function isRecord
 *
 * @description
 * Distinguishes a non-null object from primitive serialized values.
 *
 * @param {unknown} value - Value to inspect before reading its fields.
 * @returns {value is Record<string, unknown>} True for a non-null object that can be inspected by field name.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Function databaseErrorOf
 *
 * @description
 * Keeps the PostgreSQL adapters optional by recognizing their error shapes.
 *
 * @param {Record<string, unknown>} error - Database error fields available without importing an optional adapter.
 * @returns {boolean} True for a recognized PostgreSQL or Drizzle error shape.
 */
function databaseErrorOf(error: Record<string, unknown>): boolean {
  const type: unknown = error instanceof Error ? error.constructor.name : error.type;
  return (
    type === 'DatabaseError' ||
    type === 'DrizzleQueryError' ||
    (typeof error.query === 'string' && Array.isArray(error.params)) ||
    (typeof error.code === 'string' &&
      SQLSTATE.test(error.code) &&
      typeof error.severity === 'string')
  );
}

/**
 * Interface DatabaseFailure
 *
 * @description
 * What `databaseFailureIn` found in the cause chain of an error.
 */
interface DatabaseFailure {
  // #region Properties
  /**
   * Property sqlState
   *
   * @description
   * First SQLSTATE of the chain, the machine code kept on the logged error, when one is known.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly sqlState: string | undefined;
  // #endregion
}

/**
 * Function databaseFailureIn
 *
 * @description
 * Looks for a database error in an error and its causes, the chain pino folds into the message
 * and the stack it serializes. A cycle among the causes ends the walk.
 *
 * @param {Record<string, unknown>} error - Error, or its fields, to inspect.
 * @returns {DatabaseFailure | undefined} The failure found, or `undefined` when no error of the chain is a database error.
 */
function databaseFailureIn(error: Record<string, unknown>): DatabaseFailure | undefined {
  const visited: Set<object> = new Set<object>();
  let found: boolean = false;
  let sqlState: string | undefined;
  for (let cause: unknown = error; isRecord(cause) && !visited.has(cause); cause = cause.cause) {
    visited.add(cause);
    if (databaseErrorOf(cause)) {
      found = true;
      if (typeof cause.code === 'string' && SQLSTATE.test(cause.code)) {
        sqlState ??= cause.code;
      }
    }
  }
  return found ? { sqlState } : undefined;
}

/**
 * Function databaseStack
 *
 * @description
 * Removes the entire error heading, whose message can span multiple lines.
 *
 * @param {Record<string, unknown>} error - Error record whose heading may contain query inputs.
 * @returns {string} The safe heading and available stack frames, or only the heading.
 */
function databaseStack(error: Record<string, unknown>): string {
  const { stack, message } = error;
  const name: unknown = error.name ?? error.type;
  if (typeof stack === 'string' && typeof message === 'string' && typeof name === 'string') {
    const heading: string = `${name}: ${message}\n`;
    if (stack.startsWith(heading)) {
      return `${DATABASE_ERROR_MESSAGE}\n${stack.slice(heading.length)}`;
    }
  }
  return DATABASE_ERROR_MESSAGE;
}

/**
 * Function sanitizeNestedError
 *
 * @description
 * Sanitizes a serialized error held by another one, at its nesting level in the logged line, so
 * the six-level limit counts from the outer error.
 *
 * @param {Record<string, unknown>} serialized - Serialized error held by a member of another error.
 * @param {ReadonlySet<string>} keys - Normalized field names to mask in the log.
 * @param {number} depth - Nesting level of the serialized error in the logged value.
 * @returns {unknown} The sanitized error, or the redaction marker past the depth limit.
 */
function sanitizeNestedError(
  serialized: Record<string, unknown>,
  keys: ReadonlySet<string>,
  depth: number,
): unknown {
  return depth >= MAX_DEPTH ? REDACTED : sanitizeSerializedError(serialized, keys, depth);
}

/**
 * Function sanitizeSerializedError
 *
 * @description
 * Sanitizes a serialized error as `sanitizeLogValue` sanitizes a logged value, and redacts SQL
 * errors, including causes that Pino folds into the outer message and stack. The `code` of an
 * `Error` Pino serialized, and of the errors Pino serialized inside it (`Error`-valued members
 * and `aggregateErrors`), is its machine code and stays, e-mail addresses masked; the `code` of a
 * plain object logged under `err`, or of a plain object among an error's members, is masked.
 *
 * @param {unknown} serialized - Raw Pino serialized error, which may retain the original error as a cause source.
 * @param {ReadonlySet<string>} keys - Normalized field names to mask in the log.
 * @param {number} depth - Nesting level of the error in the logged value; callers leave the default.
 * @returns {Record<string, unknown>} The sanitized fields suitable for serialization to the log.
 */
export function sanitizeSerializedError(
  serialized: unknown,
  keys: ReadonlySet<string>,
  depth: number = 0,
): Record<string, unknown> {
  if (!isRecord(serialized)) {
    return {};
  }
  const original: Record<string, unknown> = isRecord(serialized.raw) ? serialized.raw : serialized;
  const keepsCode: boolean = serialized.raw instanceof Error;
  const failure: DatabaseFailure | undefined = databaseFailureIn(original);
  const databaseError: boolean = failure !== undefined;
  const kept: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(serialized)) {
    if (SQL_ERROR_KEYS.has(key)) {
      continue;
    }
    if (keepsCode && key === ERROR_CODE_KEY) {
      kept[key] = sanitizeLogValue(member, keys, depth + 1);
    } else if (keys.has(normalizeKey(key))) {
      kept[key] = REDACTED;
    } else if (typeof member === 'string' && databaseError && key === 'message') {
      kept[key] = DATABASE_ERROR_MESSAGE;
    } else if (typeof member === 'string' && databaseError && key === 'stack') {
      kept[key] = maskEmails(databaseStack(original));
    } else if (isRecord(member) && member.raw instanceof Error) {
      kept[key] = sanitizeNestedError(member, keys, depth + 1);
    } else if (key === 'aggregateErrors' && Array.isArray(member)) {
      kept[key] =
        depth + 1 >= MAX_DEPTH
          ? REDACTED
          : member.map((item: unknown) =>
              isRecord(item)
                ? sanitizeNestedError(item, keys, depth + 2)
                : sanitizeLogValue(item, keys, depth + 2),
            );
    } else {
      kept[key] = sanitizeLogValue(member, keys, depth + 1);
    }
  }
  if (failure?.sqlState !== undefined) {
    kept.code = failure.sqlState;
  }
  return kept;
}

/**
 * Function sanitizeErrorMessage
 *
 * @description
 * Returns the message of an error as the `message` of a logged error is written: the fixed
 * database message when the error or one of its causes is a database error, the message with
 * e-mail addresses masked otherwise. Unlike the logged `message`, the messages of the causes are
 * not appended: pino writes the error's own message when it takes the message of a line from it.
 *
 * @param {Record<string, unknown>} error - Error, or error-like object, whose message is written.
 * @param {ReadonlySet<string>} keys - Normalized keys to mask, from `redactedKeySet`.
 * @returns {unknown} The sanitized message; a message that is not a string is sanitized as a logged value.
 */
function sanitizeErrorMessage(error: Record<string, unknown>, keys: ReadonlySet<string>): unknown {
  const { message } = error;
  if (typeof message !== 'string') {
    return sanitizeLogValue(message, keys);
  }
  return databaseFailureIn(error) === undefined ? maskEmails(message) : DATABASE_ERROR_MESSAGE;
}

/**
 * Function errorOfMergeObject
 *
 * @description
 * Finds the error pino takes the message of a line from when the line has none: the first
 * argument itself when it is an `Error`, otherwise its `err` field when it has no `msg` field.
 *
 * @param {unknown} mergeObject - First argument of the log call.
 * @returns {Record<string, unknown> | undefined} The error, or `undefined` when pino would take no message from one.
 */
function errorOfMergeObject(mergeObject: unknown): Record<string, unknown> | undefined {
  if (mergeObject instanceof Error) {
    return mergeObject as unknown as Record<string, unknown>;
  }
  if (!isRecord(mergeObject) || mergeObject[MESSAGE_FIELD] !== undefined) {
    return undefined;
  }
  const error: unknown = mergeObject[ERROR_FIELD];
  return isRecord(error) ? error : undefined;
}

/**
 * Function sanitizeInterpolatedValue
 *
 * @description
 * Sanitizes a value that pino may interpolate into the message (`%s`, `%d`, `%j`, `%o`, `%O`) or
 * write as the message itself: a string with its e-mail addresses masked, an `Error` as its name
 * and sanitized message (the text `%s` gives), anything else as a logged value.
 *
 * @param {unknown} value - Argument of the log call after the first one.
 * @param {ReadonlySet<string>} keys - Normalized keys to mask, from `redactedKeySet`.
 * @returns {unknown} The sanitized argument.
 */
function sanitizeInterpolatedValue(value: unknown, keys: ReadonlySet<string>): unknown {
  if (!(value instanceof Error)) {
    return sanitizeLogValue(value, keys);
  }
  const message: unknown = sanitizeErrorMessage(value as unknown as Record<string, unknown>, keys);
  return [maskEmails(value.name), message]
    .filter((part: unknown) => typeof part === 'string' && part !== '')
    .join(': ');
}

/**
 * Function sanitizeLogArguments
 *
 * @description
 * Sanitizes the arguments of a log call before pino formats them, for the `logMethod` hook. The
 * first argument stays when it is an object: the `log` formatter and the serializers sanitize the
 * fields of the line. Every other argument is a message or a value interpolated into it, and is
 * sanitized by `sanitizeInterpolatedValue`. When the call has no message and pino would take it
 * from an error, the sanitized message of that error is passed as the message instead.
 *
 * @param {readonly unknown[]} args - Arguments of the log call.
 * @param {ReadonlySet<string>} keys - Normalized keys to mask, from `redactedKeySet`.
 * @returns {unknown[]} The arguments to hand to pino.
 */
export function sanitizeLogArguments(
  args: readonly unknown[],
  keys: ReadonlySet<string>,
): unknown[] {
  const sanitized: unknown[] = args.map((argument: unknown, index: number) => {
    if (typeof argument === 'string') {
      return maskEmails(argument);
    }
    return index === 0 ? argument : sanitizeInterpolatedValue(argument, keys);
  });
  if (sanitized[1] === undefined) {
    const error: Record<string, unknown> | undefined = errorOfMergeObject(args[0]);
    const message: unknown = error === undefined ? undefined : sanitizeErrorMessage(error, keys);
    if (message !== undefined) {
      sanitized[1] = message;
    }
  }
  return sanitized;
}
