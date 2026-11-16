/** Outcome of one pass of the relay. */
export interface RelayPass {
  // #region Properties
  /** Number of rows published and marked sent. */
  readonly published: number;

  /** Number of rows whose publish failed. They stay pending or are parked after 20 failures. */
  readonly failed: number;

  /** Whether a broker-wide failure interrupted the pass before the remaining rows could publish. */
  readonly interrupted: boolean;
  // #endregion
}
