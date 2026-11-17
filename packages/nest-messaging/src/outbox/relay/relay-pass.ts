/**
 * Interface RelayPass
 *
 * @description
 * Outcome of one pass of the relay.
 */
export interface RelayPass {
  // #region Properties
  /**
   * Property published
   *
   * @description
   * Number of rows published and marked sent.
   *
   * @type {number}
   * @readonly
   */
  readonly published: number;

  /**
   * Property failed
   *
   * @description
   * Number of rows whose publish failed. They stay pending or are parked after 20 failures.
   *
   * @type {number}
   * @readonly
   */
  readonly failed: number;

  /**
   * Property interrupted
   *
   * @description
   * Whether a broker-wide failure calls for relay backoff.
   *
   * @type {boolean}
   * @readonly
   */
  readonly interrupted: boolean;
  // #endregion
}
