import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
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
import {
  resolveJobsModuleOptions,
  type JobsModuleOptions,
} from '../../jobs/configuration/jobs-options.js';
import { JobsRuntime } from '../lifecycle/jobs-runtime.js';
import { JOBS_MODULE_OPTIONS } from './jobs-module-options.js';

/**
 * Service JobsService
 *
 * @description
 * Runtime of the durable background jobs of a service, on top of pg-boss, with the application
 * role.
 *
 * It starts with the module and fails the start-up of the application when the database was not
 * provisioned or when it is connected as a role that can run DDL in the pg-boss schema. It never
 * runs DDL. Its pool holds two connections, apart from the application pool. Delivery is at least
 * once: a job can run again after a crash, a timeout or a shutdown, so every handler must be
 * idempotent.
 */
@Injectable()
export class JobsService implements OnModuleInit, BeforeApplicationShutdown {
  // #region Properties
  /**
   * Property runtime
   *
   * @description
   * Application-role runtime and lifecycle behind this Nest provider.
   *
   * @type {JobsRuntime}
   * @readonly
   */
  private readonly runtime: JobsRuntime;
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Validates the module options and applies their defaults. No connection is opened here.
   *
   * @param {JobsModuleOptions} options - Options given to `JobsModule`.
   * @throws {Error} When an option or a queue declaration is invalid.
   * @constructor
   */
  public constructor(@Inject(JOBS_MODULE_OPTIONS) options: JobsModuleOptions) {
    this.runtime = new JobsRuntime(resolveJobsModuleOptions(options), new Logger(JobsService.name));
  }
  // #endregion

  // #region Methods
  /**
   * Method onModuleInit
   *
   * @description
   * Starts pg-boss with the application role, refuses a role that can create objects in the
   * pg-boss schema, checks that the schema and every declared queue were provisioned, warns about
   * stored schedules of queues that are no longer declared, and starts the dead-letter watch. The
   * module is global, so this runs before the `onModuleInit` of the modules that register workers.
   *
   * @returns {Promise<void>} Resolves once jobs can be enqueued and workers registered.
   * @throws {JobsNotProvisionedError} When the schema, a grant or a declared queue is missing.
   * @throws {Error} When the connected role can create objects in the schema and
   * `allowPrivilegedRole` is not set.
   */
  public async onModuleInit(): Promise<void> {
    await this.runtime.start();
  }

  /**
   * Method beforeApplicationShutdown
   *
   * @description
   * Stops the dead-letter watch, stops fetching jobs, lets running handlers finish for
   * `shutdownTimeoutMs`, fails the attempts still running after that, logs each of them with its
   * job id, then closes the pool. A failed attempt uses one retry of its job. It runs before the
   * `onApplicationShutdown` hooks, where an application usually closes its own resources.
   *
   * @returns {Promise<void>} Resolves once pg-boss is stopped.
   */
  public async beforeApplicationShutdown(): Promise<void> {
    await this.runtime.stop();
  }

  /**
   * Method enqueue
   *
   * @description
   * Inserts a job through the client of the caller's transaction: the job exists if and only if the
   * transaction commits.
   *
   * With an occurrence key the job id is derived from the queue, the organization of the
   * transaction and the key, and a second enqueue of the same triple inserts nothing while the
   * first job row exists, whatever its state. The row is deleted `deleteAfterSeconds` after the job
   * finished, or `retentionSeconds` after it was last due if it never started, so the business
   * table stays the source of truth beyond that.
   *
   * A failed insert aborts the caller's transaction, like any failed statement in it.
   *
   * @param {JobsTransaction} tx - Open transaction of the use case and its organization.
   * @param {string} queue - Declared queue to enqueue in.
   * @param {unknown} payload - JSON-serializable payload given back to the handler.
   * @param {JobEnqueueOptions} [options] - Occurrence key, if any.
   * @returns {Promise<JobEnqueueResult>} The job id and whether the occurrence already existed.
   * @throws {Error} When the runtime is not started, the queue is not declared or the key is empty.
   */
  public async enqueue(
    tx: JobsTransaction,
    queue: string,
    payload: unknown,
    options: JobEnqueueOptions = {},
  ): Promise<JobEnqueueResult> {
    return this.runtime.enqueue(tx, queue, payload, options);
  }

  /**
   * Method work
   *
   * @description
   * Registers the handler of a declared queue, once per queue and per process: raise `concurrency`
   * for more parallel jobs. Jobs are handled one at a time per unit of `concurrency`, each call
   * wrapped in `runInOrganization`.
   *
   * A handler that rejects, or runs longer than the queue's `expireInSeconds`, fails the attempt.
   * The job is retried after the queue's delay, with exponential backoff when enabled, up to
   * `retryLimit` times; then it is copied to the dead-letter queue. A failed attempt is logged as a
   * warning, the last one as an error, with the job id and never the payload. Only the name and
   * the message of the error are stored with the job.
   *
   * @param {string} queue - Declared queue to consume.
   * @param {JobHandler<TPayload>} handler - Idempotent handler of one job.
   * @param {JobWorkOptions} [options] - Concurrency and polling interval.
   * @returns {Promise<void>} Resolves once the worker polls the queue.
   * @throws {Error} When the runtime is not started, the queue is not declared or already has a
   * worker, or an option is out of bounds.
   */
  public async work<TPayload>(
    queue: string,
    handler: JobHandler<TPayload>,
    options: JobWorkOptions = {},
  ): Promise<void> {
    await this.runtime.work(queue, handler, options);
  }

  /**
   * Method schedule
   *
   * @description
   * Registers a cron schedule that enqueues a job in a declared queue at each occurrence, evaluated
   * in the given time zone. The schedule is stored in the database with plain DML, so the
   * application role registers it and every replica can do so at start-up: the same queue and key
   * replace the stored schedule. One job is created per occurrence, whatever the number of
   * replicas, with a resolution of one minute.
   *
   * @param {string} queue - Declared queue the jobs are created in.
   * @param {string} cron - Cron expression with five fields, or six with seconds.
   * @param {JobScheduleOptions} options - Mandatory time zone, payload and key.
   * @returns {Promise<void>} Resolves once the schedule is stored.
   * @throws {Error} When the runtime is not started, the queue is not declared, the time zone is
   * missing or unknown, or the expression is invalid.
   */
  public async schedule(queue: string, cron: string, options: JobScheduleOptions): Promise<void> {
    await this.runtime.schedule(queue, cron, options);
  }

  /**
   * Method unschedule
   *
   * @description
   * Removes a stored schedule. A schedule stays in the database until it is removed: deleting the
   * `schedule` call from the code does not stop it. The queue does not have to be declared any
   * more, so the schedule of a queue that left the declarations can still be removed.
   *
   * @param {string} queue - Queue of the schedule, declared or not.
   * @param {JobUnscheduleOptions} [options] - Key of the schedule; the empty key when omitted.
   * @returns {Promise<void>} Resolves once the schedule is removed, or was not there.
   * @throws {Error} When the runtime is not started or the queue name is not a valid name.
   */
  public async unschedule(queue: string, options: JobUnscheduleOptions = {}): Promise<void> {
    await this.runtime.unschedule(queue, options);
  }
  // #endregion
}
