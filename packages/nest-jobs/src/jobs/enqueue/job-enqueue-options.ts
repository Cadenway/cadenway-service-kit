/**
 * Interface JobEnqueueOptions
 *
 * @description
 * Options of one enqueue.
 */
export interface JobEnqueueOptions {
  // #region Properties
  /**
   * Property occurrenceKey
   *
   * @description
   * Key that identifies the occurrence within its queue and its organization, such as
   * `<reminder id>:<occurrence>`. A second enqueue with the same queue, organization and key
   * inserts nothing while the first job row exists. Without a key every enqueue creates a job.
   * Defaults to none.
   *
   * @type {string}
   * @readonly
   */
  readonly occurrenceKey?: string;
  // #endregion
}

/**
 * Interface JobEnqueueResult
 *
 * @description
 * Outcome of one enqueue.
 */
export interface JobEnqueueResult {
  // #region Properties
  /**
   * Property jobId
   *
   * @description
   * Id of the job: the one just inserted, or the one already stored for the occurrence key.
   *
   * @type {string}
   * @readonly
   */
  readonly jobId: string;

  /**
   * Property duplicate
   *
   * @description
   * `true` when a job already existed for the occurrence key and nothing was inserted.
   *
   * @type {boolean}
   * @readonly
   */
  readonly duplicate: boolean;
  // #endregion
}
