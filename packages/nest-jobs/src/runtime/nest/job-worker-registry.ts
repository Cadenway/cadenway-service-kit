import type { JobHandler, JobWorkOptions } from '../../jobs/execution/job.js';

/**
 * Class JobWorkerRegistry
 *
 * @description
 * Injectable API for registering workers that run in this process.
 */
export abstract class JobWorkerRegistry {
  // #region Methods
  /**
   * Method work
   *
   * @description
   * Registers one idempotent handler per declared queue for at-least-once delivery.
   *
   * @param {string} queue - Declared queue to process in the worker.
   * @param {JobHandler<TPayload>} handler - Idempotent handler called in the job's organization context.
   * @param {JobWorkOptions} [options] - Concurrency and polling interval for this registration.
   * @returns {Promise<void>} Resolves when the local worker is registered.
   * @throws {Error} When the worker capability is disabled, the queue is undeclared or already
   * registered in this process, or the options are out of bounds.
   */
  public abstract work<TPayload>(
    queue: string,
    handler: JobHandler<TPayload>,
    options?: JobWorkOptions,
  ): Promise<void>;
  // #endregion
}
