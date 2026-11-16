/**
 * Class RebuildConsumerUnavailableError
 *
 * @description
 * Reports that no consumer was listening when a rebuild item was sent in reply mode.
 */
export class RebuildConsumerUnavailableError extends Error {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Identifies the rebuild subject and retains the client failure as the cause.
   *
   * @param {string} subject - Rebuild subject with no responding receiver.
   * @param {unknown} cause - Underlying NATS error retained for callers.
   * @constructor
   */
  public constructor(subject: string, cause: unknown) {
    super(`No consumer listens on ${subject}.`, { cause });
    this.name = 'RebuildConsumerUnavailableError';
  }
  // #endregion
}
