/**
 * Class UpstreamFailure
 *
 * @description
 * Failed attempt, as counted by the circuit breaker: the called service did not answer, or
 * answered a server error.
 */
export class UpstreamFailure extends Error {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Records what went wrong with one attempt.
   *
   * @param {'unreachable' | 'timeout' | 'unavailable' | 'failed'} kind - Kind of failure; `unavailable` is a 503, `failed` another server error.
   * @param {boolean} counted - Whether the circuit breaker counts the failure against the called service.
   * @param {unknown | undefined} cause - Underlying error, kept for the logs.
   * @constructor
   */
  public constructor(
    public readonly kind: 'unreachable' | 'timeout' | 'unavailable' | 'failed',
    public readonly counted: boolean,
    cause?: unknown,
  ) {
    super(`upstream ${kind}`, { cause });
    this.name = 'UpstreamFailure';
  }
  // #endregion
}
