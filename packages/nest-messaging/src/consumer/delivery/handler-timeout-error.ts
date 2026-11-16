/**
 * Class HandlerTimeoutError
 *
 * @description
 * Signals that an event handler exceeded its delivery deadline.
 */
export class HandlerTimeoutError extends Error {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Reports the deadline in milliseconds.
   *
   * @param {number} timeoutMs - Configured handler deadline, in milliseconds.
   * @constructor
   */
  public constructor(timeoutMs: number) {
    super(`The event handler did not finish within ${String(timeoutMs)} ms.`);
    this.name = 'HandlerTimeoutError';
  }
  // #endregion
}
