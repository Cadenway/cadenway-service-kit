/**
 * Interface JobsQueryResult
 *
 * @description
 * The part of a query result this package reads: the returned rows.
 */
export interface JobsQueryResult {
  // #region Properties
  /**
   * Property rows
   *
   * @description
   * Rows returned by the statement.
   *
   * @type {unknown[]}
   */
  rows: unknown[];
  // #endregion
}

/**
 * Interface JobsTransactionClient
 *
 * @description
 * A database client bound to an open transaction. A `pg` client satisfies it; the interface is
 * structural so this package depends on no particular driver wrapper.
 */
export interface JobsTransactionClient {
  // #region Methods
  /**
   * Method query
   *
   * @description
   * Runs one parameterized statement on the connection that holds the transaction.
   *
   * @param {string} text - SQL text with `$1`-style placeholders.
   * @param {unknown[]} [values] - Values bound to the placeholders.
   * @returns {Promise<JobsQueryResult>} The rows returned by the statement.
   */
  query(text: string, values?: unknown[]): Promise<JobsQueryResult>;
  // #endregion
}

/**
 * Interface JobsTransaction
 *
 * @description
 * The transaction scope of a use case, as `@cadenway/nest-common` hands it to use cases: a client
 * inside an open transaction and the organization the use case runs for. Declared structurally so
 * this package does not depend on `@cadenway/nest-common`.
 */
export interface JobsTransaction {
  // #region Properties
  /**
   * Property client
   *
   * @description
   * Client inside the open transaction. The job row is inserted through it, so the job commits or
   * rolls back with the data of the use case.
   *
   * @type {JobsTransactionClient}
   * @readonly
   */
  readonly client: JobsTransactionClient;

  /**
   * Property organizationId
   *
   * @description
   * Organization the use case runs for, or `null` outside any organization. Stored with the job
   * and given back to the handler.
   *
   * @type {string | null}
   * @readonly
   */
  readonly organizationId: string | null;
  // #endregion
}

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

/**
 * Interface JobScheduleOptions
 *
 * @description
 * Options of one cron schedule.
 */
export interface JobScheduleOptions {
  // #region Properties
  /**
   * Property timeZone
   *
   * @description
   * IANA time zone the cron expression is evaluated in, such as `Europe/Paris` or `UTC`.
   * Mandatory: a schedule never follows the local time of the server.
   *
   * @type {string}
   * @readonly
   */
  readonly timeZone: string;

  /**
   * Property payload
   *
   * @description
   * JSON-serializable payload of every job the schedule creates. Defaults to `null`.
   *
   * @type {unknown}
   * @readonly
   */
  readonly payload?: unknown;

  /**
   * Property key
   *
   * @description
   * Distinguishes several schedules on one queue: letters, digits, underscores, hyphens, periods
   * and forward slashes. Registering the same queue and key again replaces the schedule. Defaults
   * to the empty key.
   *
   * @type {string}
   * @readonly
   */
  readonly key?: string;
  // #endregion
}

/**
 * Interface JobUnscheduleOptions
 *
 * @description
 * Options that designate the schedule to remove.
 */
export interface JobUnscheduleOptions {
  // #region Properties
  /**
   * Property key
   *
   * @description
   * Key the schedule was registered with. Defaults to the empty key.
   *
   * @type {string}
   * @readonly
   */
  readonly key?: string;
  // #endregion
}
