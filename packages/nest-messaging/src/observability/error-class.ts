/**
 * Function errorClassOf
 *
 * @description
 * Names the class of an error, such as `TimeoutError`: a short, stable label that never holds
 * the message of the error, which may quote a payload. It is what the kit stores in
 * `last_error`, records on spans and attaches to rate-limited logs.
 *
 * @param {unknown} error - Error to name.
 * @returns {string} The name of its class, at most 100 characters, or `UnknownError` for a value that is not an error.
 */
export function errorClassOf(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'UnknownError';
  }
  const name: string = error.name === 'Error' ? error.constructor.name : error.name;
  return name.slice(0, 100);
}
