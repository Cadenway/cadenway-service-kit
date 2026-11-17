/**
 * Class RebuildFlushTimeoutError
 *
 * @description
 * Reports that the server did not confirm a rebuild flush within its timeout.
 */
export class RebuildFlushTimeoutError extends Error {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Reports how long the flush waited, in milliseconds.
   *
   * @param {number} timeoutMs - Configured time to wait for the server, in milliseconds.
   * @constructor
   */
  public constructor(timeoutMs: number) {
    super(`The server did not confirm the rebuild items within ${String(timeoutMs)} ms.`);
    this.name = 'RebuildFlushTimeoutError';
  }
  // #endregion
}
