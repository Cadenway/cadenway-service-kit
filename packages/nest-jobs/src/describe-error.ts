/**
 * Function describeError
 *
 * @description
 * Renders a thrown value for a log line: the name and the message of an error, never its
 * properties, so a payload attached to an error object does not reach the logs.
 *
 * @param {unknown} error - Value that was thrown.
 * @returns {string} A one-line description.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return typeof error === 'string' ? error : 'a non-error value was thrown';
}

/**
 * Function stackOf
 *
 * @description
 * Reads the stack of a thrown value, when it has one, for the stack argument of the logger.
 *
 * @param {unknown} error - Value that was thrown.
 * @returns {string | undefined} The stack trace, or `undefined` for a value that is not an error.
 */
export function stackOf(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}
