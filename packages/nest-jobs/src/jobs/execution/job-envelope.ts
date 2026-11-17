/**
 * Interface JobEnvelope
 *
 * @description
 * What this package stores as the data of every job: the payload of the caller and the
 * organization it belongs to, so the worker can restore the organization context. It is a stored
 * format: a job written by one version of the package is read by the next, so fields are only
 * ever added.
 */
export interface JobEnvelope {
  // #region Properties
  /**
   * Property organizationId
   *
   * @description
   * Organization the job was enqueued for, or `null` for a scheduled job or a job enqueued outside
   * any organization.
   *
   * @type {string | null}
   * @readonly
   */
  readonly organizationId: string | null;

  /**
   * Property payload
   *
   * @description
   * Payload of the caller, as JSON; `null` when none was given.
   *
   * @type {unknown}
   * @readonly
   */
  readonly payload: unknown;
  // #endregion
}

/**
 * Function toJobEnvelope
 *
 * @description
 * Wraps a payload for storage. An absent payload is stored as `null`, because JSON drops an
 * `undefined` field and the envelope would then read back as malformed.
 *
 * @param {unknown} organizationId - Organization of the enqueuing transaction, or `null`.
 * @param {unknown} payload - Payload of the caller.
 * @returns {JobEnvelope} The data to store on the job.
 * @throws {Error} When the organization id is neither a string nor `null`.
 */
export function toJobEnvelope(organizationId: unknown, payload: unknown): JobEnvelope {
  if (organizationId !== null && typeof organizationId !== 'string') {
    throw new Error('organizationId must be a string or null.');
  }
  return { organizationId, payload: payload === undefined ? null : payload };
}

/**
 * Function readJobEnvelope
 *
 * @description
 * Reads the data of a fetched job back into an envelope.
 *
 * @param {unknown} data - Data stored on the job.
 * @returns {JobEnvelope} The envelope the job was enqueued with.
 * @throws {Error} When the data was not written by this package; the attempt then fails and
 *   follows the queue's retry policy to the dead-letter queue.
 */
export function readJobEnvelope(data: unknown): JobEnvelope {
  if (
    typeof data !== 'object' ||
    data === null ||
    !('organizationId' in data) ||
    !('payload' in data) ||
    (data.organizationId !== null && typeof data.organizationId !== 'string')
  ) {
    throw new Error('The job data is not an envelope written by @cadenway/nest-jobs.');
  }
  return { organizationId: data.organizationId, payload: data.payload };
}
