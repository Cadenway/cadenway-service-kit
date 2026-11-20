import type { JobsTransaction } from '../../jobs/database/jobs-transaction.js';
import type {
  JobEnqueueOptions,
  JobEnqueueResult,
} from '../../jobs/enqueue/job-enqueue-options.js';

/**
 * Class JobProducer
 *
 * @description
 * Injectable API for writing jobs in the caller's PostgreSQL transaction.
 */
export abstract class JobProducer {
  // #region Methods
  /**
   * Method enqueue
   *
   * @description
   * Inserts a job into a declared queue. The job becomes visible when the caller's transaction
   * commits. An occurrence key deduplicates enqueues while the matching job remains stored.
   *
   * @param {JobsTransaction} tx - Open use-case transaction and its organization.
   * @param {string} queue - Declared queue that receives the job.
   * @param {unknown} payload - JSON-serializable data delivered to the handler.
   * @param {JobEnqueueOptions} [options] - Occurrence key and earliest start, if supplied.
   * @returns {Promise<JobEnqueueResult>} Job identifier and whether its occurrence was already stored.
   * @throws {Error} When the producer capability is disabled, the runtime is unavailable, or the
   * queue, occurrence key or start date is invalid.
   */
  public abstract enqueue(
    tx: JobsTransaction,
    queue: string,
    payload: unknown,
    options?: JobEnqueueOptions,
  ): Promise<JobEnqueueResult>;
  // #endregion
}
