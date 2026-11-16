/**
 * Interface Job
 *
 * @description
 * What a handler receives for one attempt of one job.
 */
export interface Job<TPayload = unknown> {
  // #region Properties
  /**
   * Property id
   *
   * @description
   * Id of the job, stable across its attempts. Use it, or a business key from the payload, as the
   * idempotency key of the side effect.
   *
   * @type {string}
   * @readonly
   */
  readonly id: string;

  /**
   * Property queue
   *
   * @description
   * Queue the job was fetched from.
   *
   * @type {string}
   * @readonly
   */
  readonly queue: string;

  /**
   * Property payload
   *
   * @description
   * Payload given to `enqueue` or to `schedule`, after a JSON round trip; `null` for a schedule
   * registered without one.
   *
   * @type {TPayload}
   * @readonly
   */
  readonly payload: TPayload;

  /**
   * Property organizationId
   *
   * @description
   * Organization of the transaction that enqueued the job; `null` for a scheduled job or a job
   * enqueued outside any organization.
   *
   * @type {string | null}
   * @readonly
   */
  readonly organizationId: string | null;

  /**
   * Property attempt
   *
   * @description
   * One-based attempt number: 1 for the first run, up to `retryLimit + 1`.
   *
   * @type {number}
   * @readonly
   */
  readonly attempt: number;

  /**
   * Property signal
   *
   * @description
   * Aborted when the attempt can no longer succeed: it ran longer than the queue's
   * `expireInSeconds`, or the application shut down past `shutdownTimeoutMs`. The attempt is
   * failed at that moment whatever the handler does next, and the job may already run elsewhere.
   * Pass the signal to the calls that accept one and stop: a handler that never settles keeps its
   * worker slot busy.
   *
   * @type {AbortSignal}
   * @readonly
   */
  readonly signal: AbortSignal;
  // #endregion
}

/**
 * Type JobHandler
 *
 * @description
 * Processes one attempt of one job. Resolving completes the job; rejecting fails the attempt, which
 * is retried per the queue's policy. Delivery is at least once, so a handler must be idempotent.
 *
 * @type {(job: Job<TPayload>) => Promise<void>}
 * @param {Job<TPayload>} job - Job and cancellation signal for the current attempt.
 * @returns {Promise<void>} Resolves to complete the attempt or rejects to fail it.
 */
export type JobHandler<TPayload = unknown> = (job: Job<TPayload>) => Promise<void>;

/**
 * Interface JobWorkOptions
 *
 * @description
 * Options of one worker registration.
 */
export interface JobWorkOptions {
  // #region Properties
  /**
   * Property concurrency
   *
   * @description
   * Jobs of the queue this process handles at the same time, at least 1. Defaults to 1.
   *
   * @type {number}
   * @readonly
   */
  readonly concurrency?: number;

  /**
   * Property pollingIntervalSeconds
   *
   * @description
   * Seconds between two fetches when the queue is idle, at least 0.5. Defaults to 2.
   *
   * @type {number}
   * @readonly
   */
  readonly pollingIntervalSeconds?: number;
  // #endregion
}
