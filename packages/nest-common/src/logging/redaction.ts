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
 * Function sanitizeLogValue
 *
 * @description
 * Returns a copy of a logged value that is safe to write: the value of every redacted key is
 * masked at any depth, e-mail addresses are masked inside every string, and whatever sits deeper
 * than six levels is masked whole. An `Error` is returned untouched: the error serializer
 * handles it.
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
  if (typeof value !== 'object' || value === null || value instanceof Error) {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return REDACTED;
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
  const visited: Set<object> = new Set<object>();
  let databaseError: boolean = false;
  let sqlState: string | undefined;
  for (let cause: unknown = original; isRecord(cause) && !visited.has(cause); cause = cause.cause) {
    visited.add(cause);
    if (databaseErrorOf(cause)) {
      databaseError = true;
      if (typeof cause.code === 'string' && SQLSTATE.test(cause.code)) {
        sqlState ??= cause.code;
      }
    }
  }
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
  if (sqlState !== undefined) {
    kept.code = sqlState;
  }
  return kept;
}
