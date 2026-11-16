import type { JobsTransaction } from '../../jobs/database/jobs-transaction.js';
import type {
  JobEnqueueOptions,
  JobEnqueueResult,
} from '../../jobs/enqueue/job-enqueue-options.js';
import type { JobHandler, JobWorkOptions } from '../../jobs/execution/job.js';
import type {
  JobScheduleOptions,
  JobUnscheduleOptions,
} from '../../jobs/scheduling/job-schedule-options.js';

/** Injectable API for placing jobs in the caller's transaction. */
export abstract class JobProducer {
  // #region Methods
  /** Enqueues a job for a declared queue, with an optional idempotent occurrence key. */
  public abstract enqueue(
    tx: JobsTransaction,
    queue: string,
    payload: unknown,
    options?: JobEnqueueOptions,
  ): Promise<JobEnqueueResult>;
  // #endregion
}

/** Injectable API for starting workers that handle jobs in this process. */
export abstract class JobWorkerRegistry {
  // #region Methods
  /** Registers one idempotent handler for a declared queue. */
  public abstract work<TPayload>(
    queue: string,
    handler: JobHandler<TPayload>,
    options?: JobWorkOptions,
  ): Promise<void>;
  // #endregion
}

/** Injectable API for managing durable cron schedules. */
export abstract class JobScheduler {
  // #region Methods
  /** Creates or replaces the cron schedule identified by the queue and key. */
  public abstract schedule(queue: string, cron: string, options: JobScheduleOptions): Promise<void>;

  /** Removes the schedule identified by the queue and optional key. */
  public abstract unschedule(queue: string, options?: JobUnscheduleOptions): Promise<void>;
  // #endregion
}
