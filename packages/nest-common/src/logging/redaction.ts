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
 * cookies, the `authorization` header, e-mail addresses, key material and connection strings.
 * A key matches whatever its case and its separators: `accessToken`, `access_token` and
 * `Access-Token` are the same key.
 *
 * @type {readonly string[]}
 */
export const DEFAULT_REDACTED_KEYS: readonly string[] = [
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'currentPassword',
  'newPassword',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'sessionToken',
  'secret',
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
 * Constant SQL_PARAMETERS_PATTERN
 *
 * @description
 * Matches the `params: ...` line Drizzle appends to the message of a failed query.
 *
 * @type {RegExp}
 */
const SQL_PARAMETERS_PATTERN: RegExp = /\nparams: [^\n]*/gu;

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
 * Function sanitizeSerializedError
 *
 * @description
 * Makes a serialized error safe to write. SQL values never reach the logs: the statement and
 * parameters of a failed Drizzle query and the `detail` and `where` of a PostgreSQL error are
 * dropped, and the `params:` line is cut from the message and the stack. The rest goes through
 * `sanitizeLogValue`.
 *
 * @param {Record<string, unknown>} serialized - Error as serialized by pino.
 * @param {ReadonlySet<string>} keys - Normalized keys to mask, from `redactedKeySet`.
 * @returns {Record<string, unknown>} The sanitized error.
 */
export function sanitizeSerializedError(
  serialized: Record<string, unknown>,
  keys: ReadonlySet<string>,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(serialized)) {
    if (SQL_ERROR_KEYS.has(key)) {
      continue;
    }
    kept[key] =
      typeof member === 'string' && (key === 'message' || key === 'stack')
        ? member.replace(SQL_PARAMETERS_PATTERN, '')
        : member;
  }
  return sanitizeLogValue(kept, keys) as Record<string, unknown>;
}
