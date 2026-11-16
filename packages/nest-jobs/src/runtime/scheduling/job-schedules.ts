import type { PgBoss } from 'pg-boss';

import { toJobEnvelope } from '../../jobs/execution/job-envelope.js';
import { assertQueueName } from '../../jobs/queues/job-queue.js';
import type {
  JobScheduleOptions,
  JobUnscheduleOptions,
} from '../../jobs/scheduling/job-schedule-options.js';
import { assertTimeZone } from '../../jobs/scheduling/time-zone.js';

/**
 * Function scheduleJob
 *
 * @description
 * Stores a cron schedule and its payload with pg-boss.
 *
 * @param {Pick<PgBoss, 'schedule'>} boss - Scheduler bound to the running pg-boss instance.
 * @param {string} queue - Validated queue name.
 * @param {string} cron - Cron expression.
 * @param {JobScheduleOptions} options - Time zone, payload and optional schedule key.
 * @returns {Promise<void>} Resolves once the schedule is stored.
 */
export async function scheduleJob(
  boss: Pick<PgBoss, 'schedule'>,
  queue: string,
  cron: string,
  options: JobScheduleOptions,
): Promise<void> {
  const timeZone: unknown = options.timeZone;
  assertTimeZone(timeZone);
  await boss.schedule(queue, cron, toJobEnvelope(null, options.payload), {
    tz: timeZone,
    ...(options.key === undefined ? {} : { key: options.key }),
  });
}

/**
 * Function unscheduleJob
 *
 * @description
 * Removes the stored schedule for a queue, including a queue no longer declared by the service.
 *
 * @param {Pick<PgBoss, 'unschedule'>} boss - Scheduler bound to the running pg-boss instance.
 * @param {string} queue - Name of the queue.
 * @param {JobUnscheduleOptions} options - Optional schedule key.
 * @returns {Promise<void>} Resolves once the schedule is removed, or was absent.
 */
export async function unscheduleJob(
  boss: Pick<PgBoss, 'unschedule'>,
  queue: string,
  options: JobUnscheduleOptions,
): Promise<void> {
  const name: unknown = queue;
  assertQueueName(name, 'Queue name');
  await boss.unschedule(name, options.key ?? '');
}
