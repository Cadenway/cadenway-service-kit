import type { Logger } from '@nestjs/common';
import type { JobWithMetadata, PgBoss } from 'pg-boss';

import { describeError, stackOf } from '../../jobs/diagnostics/describe-error.js';
import { readJobEnvelope, type JobEnvelope } from '../../jobs/execution/job-envelope.js';
import type { ResolvedJobQueue } from '../../jobs/queues/job-queue.js';
import type { Job, JobHandler, JobWorkOptions } from '../../jobs/execution/job.js';
import type { ResolvedJobsModuleOptions } from '../../jobs/configuration/jobs-options.js';

/**
 * Constant DEFAULT_POLLING_INTERVAL_SECONDS
 *
 * @description
 * Seconds between two fetches of an idle queue when a worker sets none.
 *
 * @type {number}
 */
const DEFAULT_POLLING_INTERVAL_SECONDS: number = 2;

/**
 * Constant MIN_POLLING_INTERVAL_SECONDS
 *
 * @description
 * Shortest polling interval pg-boss accepts, in seconds.
 *
 * @type {number}
 */
const MIN_POLLING_INTERVAL_SECONDS: number = 0.5;

/**
 * Constant EXPIRY_LOG_MARGIN_MS
 *
 * @description
 * Milliseconds the expiration log waits past `expireInSeconds`. pg-boss fails the attempt with a
 * timer of its own at `expireInSeconds`; logging a moment later means that a handler still running
 * then was really failed, and that one finishing right on time is not reported.
 *
 * @type {number}
 */
const EXPIRY_LOG_MARGIN_MS: number = 100;

/**
 * Interface RunningAttempt
 *
 * @description
 * What the runtime remembers about an attempt whose handler has not settled yet, so it can say
 * what happens to the job when the attempt is failed without the handler rejecting.
 */
interface RunningAttempt {
  // #region Properties
  /**
   * Property id
   *
   * @description
   * The stored job id shared by all attempts of the job.
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
   * Property attempt
   *
   * @description
   * One-based number of the running attempt.
   *
   * @type {number}
   * @readonly
   */
  readonly attempt: number;

  /**
   * Property attempts
   *
   * @description
   * Number of attempts the job is allowed, `retryLimit + 1`.
   *
   * @type {number}
   * @readonly
   */
  readonly attempts: number;

  /**
   * Property deadLetter
   *
   * @description
   * Dead-letter queue the job moves to once its last attempt failed.
   *
   * @type {string}
   * @readonly
   */
  readonly deadLetter: string;

  /**
   * Property expiry
   *
   * @description
   * Diagnostic timer that reports a handler still running just after expiry.
   *
   * @type {NodeJS.Timeout}
   * @readonly
   */
  readonly expiry: NodeJS.Timeout;

  /**
   * Property interruption
   *
   * @description
   * Cancellation owned by this runtime and independent of pg-boss's cleanup.
   *
   * @type {AbortController}
   * @readonly
   */
  readonly interruption: AbortController;

  /**
   * Property reported
   *
   * @description
   * Prevents expiry, shutdown and handler rejection from logging the same failure twice.
   *
   * @type {boolean}
   */
  reported: boolean;
  // #endregion
}

/**
 * Function waitForHandler
 *
 * @description
 * Lets pg-boss fail the attempt when grace expires even if the handler does not settle.
 *
 * @param {() => Promise<void>} work - Handler invocation whose settlement normally completes the attempt.
 * @param {AbortSignal} interruption - Signal that ends the attempt when the shutdown grace expires.
 * @returns {Promise<void>} Settles with the handler or rejects when shutdown interrupts it.
 */
async function waitForHandler(work: () => Promise<void>, interruption: AbortSignal): Promise<void> {
  let abort: () => void = (): void => undefined;
  const interrupted: Promise<never> = new Promise<never>((_resolve, reject): void => {
    abort = (): void => {
      const reason: unknown = interruption.reason;
      reject(
        reason instanceof Error
          ? reason
          : new Error('The application shut down before the handler finished.'),
      );
    };
    interruption.addEventListener('abort', abort, { once: true });
  });
  try {
    await Promise.race([work(), interrupted]);
  } finally {
    interruption.removeEventListener('abort', abort);
  }
}

/**
 * Class JobWorkers
 *
 * @description
 * Registers workers and records failures once across handler errors, expiry and shutdown.
 */
export class JobWorkers {
  // #region Properties
  /**
   * Property workedQueues
   *
   * @description
   * Queues that already have a worker in this process. A queue accepts one registration.
   *
   * @type {Set<string>}
   * @readonly
   */
  private readonly workedQueues: Set<string> = new Set<string>();

  /**
   * Property running
   *
   * @description
   * Attempts whose handlers have not settled yet. A retry can start while its expired handler
   * is still running, so every invocation has its own entry.
   *
   * @type {Set<RunningAttempt>}
   * @readonly
   */
  private readonly running: Set<RunningAttempt> = new Set<RunningAttempt>();

  /**
   * Property shutdownError
   *
   * @description
   * Expired shutdown grace. Stops a claim that only reaches the worker after the deadline.
   *
   * @type {Error | undefined}
   */
  private shutdownError: Error | undefined;
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Uses the application organization context and the runtime logger.
   *
   * @param {Pick<ResolvedJobsModuleOptions, 'runInOrganization'>} options - Organization scope provider.
   * @param {Logger} logger - Logger scoped to the jobs service.
   * @constructor
   */
  public constructor(
    private readonly options: Pick<ResolvedJobsModuleOptions, 'runInOrganization'>,
    private readonly logger: Logger,
  ) {}
  // #endregion

  // #region Methods
  /**
   * Method register
   *
   * @description
   * Registers the handler of a declared queue, once per queue and per process: raise `concurrency`
   * for more parallel jobs. Jobs are handled one at a time per unit of `concurrency`, each call
   * wrapped in `runInOrganization`.
   *
   * A handler that rejects, or runs longer than the queue's `expireInSeconds`, fails the attempt.
   * The job is retried after the queue's delay, with exponential backoff when enabled, up to
   * `retryLimit` times; then it is copied to the dead-letter queue. A failed attempt is logged as a
   * warning and the last one as an error. Logs identify the job by id. The failure stored with
   * the job is a fresh error whose message carries the original name and message.
   *
   * @param {PgBoss} boss - Running pg-boss instance.
   * @param {ResolvedJobQueue} declared - Declared queue to consume.
   * @param {JobHandler<TPayload>} handler - Idempotent handler of one job.
   * @param {JobWorkOptions} [options] - Concurrency and polling interval.
   * @returns {Promise<void>} Resolves once the worker polls the queue.
   * @throws {Error} When the queue already has a worker or an option is out of bounds.
   */
  public async register<TPayload>(
    boss: PgBoss,
    declared: ResolvedJobQueue,
    handler: JobHandler<TPayload>,
    options: JobWorkOptions = {},
  ): Promise<void> {
    const concurrency: number =
      options.concurrency ?? (declared.organizationConcurrency === undefined ? 1 : 2);
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('concurrency must be an integer of at least 1.');
    }
    const pollingIntervalSeconds: number =
      options.pollingIntervalSeconds ?? DEFAULT_POLLING_INTERVAL_SECONDS;
    if (
      !Number.isFinite(pollingIntervalSeconds) ||
      pollingIntervalSeconds < MIN_POLLING_INTERVAL_SECONDS
    ) {
      throw new Error('pollingIntervalSeconds must be a number of at least 0.5.');
    }
    if (this.workedQueues.has(declared.name)) {
      throw new Error(
        `Queue "${declared.name}" already has a worker in this process: register one handler per queue and raise concurrency instead.`,
      );
    }
    this.workedQueues.add(declared.name);
    try {
      await boss.work(
        declared.name,
        {
          includeMetadata: true,
          batchSize: 1,
          localConcurrency: concurrency,
          ...(declared.organizationConcurrency === undefined
            ? {}
            : { groupConcurrency: declared.organizationConcurrency }),
          pollingIntervalSeconds,
        },
        async (jobs: JobWithMetadata<unknown>[]): Promise<void> => {
          for (const job of jobs) {
            await this.handle(declared, job, handler);
          }
        },
      );
    } catch (error) {
      this.workedQueues.delete(declared.name);
      throw error;
    }
  }

  /**
   * Method interruptRunning
   *
   * @description
   * Aborts and reports active handlers when the runtime's shutdown grace expires.
   *
   * @param {number} timeoutMs - The configured grace period.
   */
  public interruptRunning(timeoutMs: number): void {
    if (this.shutdownError !== undefined) {
      return;
    }
    const reason: string = `it was still running when the shutdown timeout of ${String(timeoutMs)} ms passed`;
    this.shutdownError = new Error(reason);
    for (const attempt of this.running) {
      this.reportFailedAttempt(attempt, reason);
      attempt.interruption.abort(this.shutdownError);
    }
  }

  /**
   * Method reportFailedAttempt
   *
   * @description
   * Logs that an attempt failed and what happens to its job: an error when it was the last attempt
   * and the job moves to the dead-letter queue, a warning when it will be retried. An attempt is
   * reported once, whichever of the handler, the expiration or the shutdown fails it first.
   *
   * @param {RunningAttempt} attempt - The attempt that failed.
   * @param {string} reason - Why it failed: the error of the handler, or what stopped it.
   * @param {string} [stack] - Stack of the error, for the last attempt.
   */
  private reportFailedAttempt(attempt: RunningAttempt, reason: string, stack?: string): void {
    if (attempt.reported) {
      return;
    }
    attempt.reported = true;
    clearTimeout(attempt.expiry);
    const progress: string = `${String(attempt.attempt)} of ${String(attempt.attempts)}`;
    if (attempt.attempt >= attempt.attempts) {
      this.logger.error(
        `Job ${attempt.id} of queue "${attempt.queue}" failed its last attempt (${progress}) and moves to the dead-letter queue "${attempt.deadLetter}": ${reason}`,
        stack,
      );
    } else {
      this.logger.warn(
        `Job ${attempt.id} of queue "${attempt.queue}" failed attempt ${progress} and will be retried: ${reason}`,
      );
    }
  }

  /**
   * Method handle
   *
   * @description
   * Runs one attempt of one job: reads its envelope, calls the handler inside `runInOrganization`
   * and, when the attempt fails, logs it and lets pg-boss apply the retry policy.
   *
   * A timer logs the attempt at `expireInSeconds` when the handler is still running: pg-boss fails
   * the attempt itself at that moment, without the handler rejecting. A handler that returns after
   * its signal was aborted is logged the same way, since its attempt was failed before it returned.
   *
   * The failure is rethrown on purpose: pg-boss then moves the job to `retry`, or to `failed` and
   * the dead-letter queue when no retry is left. What is rethrown is a plain error carrying the
   * name and the message of the original one, because pg-boss stores the thrown error whole, with
   * its properties and its causes, on the job row and on the dead letter.
   *
   * @param {ResolvedJobQueue} queue - Declaration of the queue being consumed.
   * @param {JobWithMetadata<unknown>} job - Job as pg-boss fetched it.
   * @param {JobHandler<TPayload>} handler - Handler registered for the queue.
   * @returns {Promise<void>} Resolves when the handler did; the job is then completed.
   */
  private async handle<TPayload>(
    queue: ResolvedJobQueue,
    job: JobWithMetadata<unknown>,
    handler: JobHandler<TPayload>,
  ): Promise<void> {
    if (this.shutdownError !== undefined) {
      throw this.shutdownError;
    }
    const expireInMs: number = job.expireInSeconds * 1_000;
    const startedAt: number = Date.now();
    const endedBecause: () => string = (): string =>
      Date.now() - startedAt >= expireInMs - EXPIRY_LOG_MARGIN_MS
        ? `it ran longer than the ${String(job.expireInSeconds)} seconds of expireInSeconds`
        : 'the application shut down before it finished';
    let failure: string | null = null;
    const attempt: RunningAttempt = {
      id: job.id,
      queue: queue.name,
      attempt: job.retryCount + 1,
      attempts: job.retryLimit + 1,
      deadLetter: job.deadLetter,
      expiry: setTimeout((): void => {
        this.reportFailedAttempt(attempt, endedBecause());
      }, expireInMs + EXPIRY_LOG_MARGIN_MS),
      interruption: new AbortController(),
      reported: false,
    };
    attempt.expiry.unref();
    this.running.add(attempt);
    try {
      const envelope: JobEnvelope = readJobEnvelope(job.data);
      const context: Job<TPayload> = {
        id: job.id,
        queue: queue.name,
        payload: envelope.payload as TPayload,
        organizationId: envelope.organizationId,
        attempt: attempt.attempt,
        signal: AbortSignal.any([job.signal, attempt.interruption.signal]),
      };
      await waitForHandler(
        (): Promise<void> =>
          this.options.runInOrganization(envelope.organizationId, (): Promise<void> => {
            context.signal.throwIfAborted();
            return handler(context);
          }),
        attempt.interruption.signal,
      );
      attempt.interruption.signal.throwIfAborted();
      if (job.signal.aborted) {
        // pg-boss aborts the signal when it fails the attempt itself. A handler that stopped on
        // the signal and returned did not complete the job: the attempt is already failed.
        this.reportFailedAttempt(attempt, endedBecause());
      }
    } catch (error) {
      this.reportFailedAttempt(
        attempt,
        job.signal.aborted ? `${endedBecause()} (${describeError(error)})` : describeError(error),
        stackOf(error),
      );
      failure = describeError(error);
    } finally {
      clearTimeout(attempt.expiry);
      this.running.delete(attempt);
    }
    if (failure !== null) {
      // Thrown outside the catch, and without the original error as its cause, on purpose: pg-boss
      // would store the cause chain with the job.
      throw new Error(failure);
    }
  }
  // #endregion
}
