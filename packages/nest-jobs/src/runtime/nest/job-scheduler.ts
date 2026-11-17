import type {
  JobScheduleOptions,
  JobUnscheduleOptions,
} from '../../jobs/scheduling/job-schedule-options.js';

/**
 * Class JobScheduler
 *
 * @description
 * Injectable API for managing durable cron schedules.
 */
export abstract class JobScheduler {
  // #region Methods
  /**
   * Method schedule
   *
   * @description
   * Creates or replaces the schedule identified by the queue and key.
   *
   * @param {string} queue - Declared queue that receives a job on each cron occurrence.
   * @param {string} cron - Cron expression evaluated in the requested time zone.
   * @param {JobScheduleOptions} options - Time zone, optional payload and optional schedule key.
   * @returns {Promise<void>} Resolves once the durable schedule is stored.
   * @throws {Error} When the scheduler capability is disabled, the queue is undeclared, or the
   * expression or time zone is invalid.
   */
  public abstract schedule(queue: string, cron: string, options: JobScheduleOptions): Promise<void>;

  /**
   * Method unschedule
   *
   * @description
   * Removes the schedule for the queue and key, even if the queue is no longer declared.
   *
   * @param {string} queue - Schedule's target queue, which may no longer be declared.
   * @param {JobUnscheduleOptions} [options] - Schedule key, with the empty key used when omitted.
   * @returns {Promise<void>} Resolves when the schedule has been removed or was already absent.
   * @throws {Error} When the scheduler capability is disabled or the queue name is invalid.
   */
  public abstract unschedule(queue: string, options?: JobUnscheduleOptions): Promise<void>;
  // #endregion
}
