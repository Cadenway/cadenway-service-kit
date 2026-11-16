/**
 * Class JobsNotProvisionedError
 *
 * @description
 * Thrown at start-up when the database is not ready for the runtime: the pg-boss schema is
 * missing or at another version, the application role was not granted access to it, or a declared
 * queue does not exist. The fix is always the same: run `provisionJobs` as the migrator role, with
 * the same queue declarations, before starting the service.
 */
export class JobsNotProvisionedError extends Error {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Builds the error with the reason start-up was refused.
   *
   * @param {string} message - What is missing and how to provision it.
   * @param {ErrorOptions} [options] - Underlying error, as `cause`.
   * @constructor
   */
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'JobsNotProvisionedError';
  }
  // #endregion
}
