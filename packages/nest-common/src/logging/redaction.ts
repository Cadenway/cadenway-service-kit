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
 * Keys whose value is masked wherever they appear in the first three levels of a logged object:
 * tokens, passwords, cookies, the `authorization` header and e-mail addresses.
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
  'email',
];

/**
 * Constant REDACTION_DEPTH
 *
 * @description
 * Number of object levels the key-based redaction covers. pino matches paths, not keys at any
 * depth, so each key is expanded once per level.
 *
 * @type {number}
 */
const REDACTION_DEPTH: number = 3;

/**
 * Constant EMAIL_PATTERN
 *
 * @description
 * Matches an e-mail address inside free text. Deliberately broad: masking a look-alike costs
 * nothing, leaking an address does.
 *
 * @type {RegExp}
 */
const EMAIL_PATTERN: RegExp = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/gu;

/**
 * Function redactionPaths
 *
 * @description
 * Expands keys into the pino redaction paths that mask them at the root of a logged object and
 * one and two levels below.
 *
 * @param {readonly string[]} keys - Keys to mask.
 * @returns {string[]} The pino redaction paths.
 */
export function redactionPaths(keys: readonly string[]): string[] {
  const paths: string[] = [];
  for (const key of new Set(keys)) {
    const segment: string = `[${JSON.stringify(key)}]`;
    for (let depth: number = 0; depth < REDACTION_DEPTH; depth += 1) {
      paths.push(`${Array.from({ length: depth }, () => '*').join('.')}${segment}`);
    }
  }
  return paths;
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
