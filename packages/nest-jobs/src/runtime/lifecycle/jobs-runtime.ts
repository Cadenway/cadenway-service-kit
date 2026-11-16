import type { Logger } from '@nestjs/common';
import { PgBoss, type Warning } from 'pg-boss';

import { describeError } from '../../jobs/diagnostics/describe-error.js';
import {
  deadLetterQueuesOf,
  type ResolvedDeadLetterQueue,
  type ResolvedJobQueue,
} from '../../jobs/queues/job-queue.js';
import type { JobHandler, JobWorkOptions } from '../../jobs/execution/job.js';
import type { JobsTransaction } from '../../jobs/database/jobs-transaction.js';
import type {
  JobEnqueueOptions,
  JobEnqueueResult,
} from '../../jobs/enqueue/job-enqueue-options.js';
import type { ResolvedJobsModuleOptions } from '../../jobs/configuration/jobs-options.js';
import type {
  JobsCapability,
  ResolvedJobsRuntimeOptions,
} from '../../jobs/configuration/jobs-runtime-options.js';
import type {
  JobScheduleOptions,
  JobUnscheduleOptions,
} from '../../jobs/scheduling/job-schedule-options.js';
import { DeadLetterWatch } from '../dead-letter/dead-letter-watch.js';
import { enqueueJob } from '../enqueue/enqueue-job.js';
import { TransactionalJobSender } from '../enqueue/transactional-job-sender.js';
import { toStartupError, verifyJobsDatabase } from '../postgres/jobs-startup-checks.js';
import { toRuntimeBossOptions } from '../postgres/runtime-boss-options.js';
import { scheduleJob, unscheduleJob } from '../scheduling/job-schedules.js';
import { JobWorkers } from '../workers/job-workers.js';

/**
 * Class JobsRuntime
 *
 * @description
 * Owns the application-role pg-boss instance and orders its start-up and shutdown.
 */
export class JobsRuntime {
  // #region Properties
  /**
   * Property queues
   *
   * @description
   * Declared queues by name. Only these accept jobs, workers and schedules.
   *
   * @type {ReadonlyMap<string, ResolvedJobQueue>}
   * @readonly
   */
  private readonly queues: ReadonlyMap<string, ResolvedJobQueue>;

  /**
   * Property deadLetterQueues
   *
   * @description
   * Distinct dead-letter queues derived from the declarations, including their expected retention.
   *
   * @type {readonly ResolvedDeadLetterQueue[]}
   * @readonly
   */
  private readonly deadLetterQueues: readonly ResolvedDeadLetterQueue[];

  /**
   * Property boss
   *
   * @description
   * The started pg-boss instance, or `null` before start-up and after shutdown.
   *
   * @type {PgBoss | null}
   */
  private boss: PgBoss | null = null;

  /**
   * Property workers
   *
   * @description
   * Worker registrations and attempts for this runtime.
   *
   * @type {JobWorkers | null}
   * @readonly
   */
  private readonly workers: JobWorkers | null;

  /**
   * Property deadLetterWatch
   *
   * @description
   * Dead-letter monitoring cancelled when the runtime stops.
   *
   * @type {DeadLetterWatch | null}
   * @readonly
   */
  private readonly deadLetterWatch: DeadLetterWatch | null;

  /** Producer-only sender that never starts a pg-boss instance. */
  private readonly transactionalSender: TransactionalJobSender | null;

  /** True after a successful start and until shutdown begins. */
  private running: boolean = false;
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Shares the validated queue declarations and logger across the runtime.
   *
   * @param {ResolvedJobsModuleOptions} options - Validated module options.
   * @param {Logger} logger - Logger scoped to the jobs service.
   * @constructor
   */
  public constructor(
    private readonly options: ResolvedJobsModuleOptions | ResolvedJobsRuntimeOptions,
    private readonly logger: Logger,
  ) {
    this.queues = new Map<string, ResolvedJobQueue>(
      options.queues.map((queue: ResolvedJobQueue): [string, ResolvedJobQueue] => [
        queue.name,
        queue,
      ]),
    );
    this.deadLetterQueues = deadLetterQueuesOf(options.queues);
    this.workers = this.has('worker') ? new JobWorkers(options, logger) : null;
    const deadLetterNames: string[] = this.deadLetterQueues.map(
      (queue: ResolvedDeadLetterQueue): string => queue.name,
    );
    const scheduler: boolean = this.has('scheduler');
    this.deadLetterWatch = scheduler ? new DeadLetterWatch(options, deadLetterNames, logger) : null;
    this.transactionalSender =
      this.workers === null && !scheduler ? new TransactionalJobSender(options) : null;
  }
  // #endregion

  // #region Methods
  /**
   * Method start
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
  public async start(): Promise<void> {
    if (this.running) {
      return;
    }
    if (this.transactionalSender !== null) {
      await this.transactionalSender.verify(this.deadLetterQueues, this.logger);
      this.running = true;
      return;
    }
    const boss: PgBoss = new PgBoss(toRuntimeBossOptions(this.options));
    boss.on('error', (error: Error): void => {
      this.logger.error(`pg-boss reported an error: ${error.message}`, error.stack);
    });
    boss.on('warning', (warning: Warning): void => {
      this.logger.warn(`pg-boss reported a warning: ${warning.message}`);
    });
    try {
      await boss.start();
      await verifyJobsDatabase(
        boss,
        this.options,
        this.deadLetterQueues,
        this.logger,
        this.has('scheduler'),
      );
    } catch (error) {
      try {
        await boss.stop({ graceful: false });
      } catch (stopError) {
        this.logger.warn(`pg-boss did not stop cleanly: ${describeError(stopError)}`);
      }
      throw toStartupError(error, this.options.schema);
    }
    this.boss = boss;
    this.running = true;
    this.deadLetterWatch?.start(boss);
  }

  /**
   * Method stop
   *
   * @description
   * Cancels the dead-letter watch and asks pg-boss to stop fetching jobs. The handler grace starts
   * here, independently of PostgreSQL bookkeeping. Once the grace ends, the workers abort and
   * report their active attempts. PostgreSQL settlement and pool closure still finish before the
   * application reaches its `onApplicationShutdown` hooks.
   *
   * @returns {Promise<void>} Resolves once pg-boss is stopped.
   */
  public async stop(): Promise<void> {
    const boss: PgBoss | null = this.boss;
    if (boss === null) {
      this.running = false;
      return;
    }
    this.deadLetterWatch?.stop();
    const timeout: number = Math.min(this.options.shutdownTimeoutMs, 2_147_483_647);
    const deadline: NodeJS.Timeout = setTimeout((): void => {
      this.workers?.interruptRunning(timeout);
    }, timeout);
    try {
      await boss.stop({ graceful: true, timeout });
      this.boss = null;
      this.running = false;
    } finally {
      clearTimeout(deadline);
    }
  }

  /**
   * Method work
   *
   * @description
   * Registers a worker against the started runtime and a declared queue.
   *
   * @param {string} queue - Declared queue to consume.
   * @param {JobHandler<TPayload>} handler - Handler of one job.
   * @param {JobWorkOptions} options - Concurrency and polling interval.
   * @returns {Promise<void>} Resolves when the worker polls the queue.
   */
  public async work<TPayload>(
    queue: string,
    handler: JobHandler<TPayload>,
    options: JobWorkOptions,
  ): Promise<void> {
    const workers: JobWorkers | null = this.workers;
    if (workers === null) {
      throw new Error('The worker jobs capability is not enabled in this process.');
    }
    await workers.register(this.requireBoss(), this.requireQueue(queue), handler, options);
  }

  /**
   * Method enqueue
   *
   * @description
   * Sends a job to a declared queue through the caller's transaction.
   *
   * @param {JobsTransaction} tx - Caller transaction and its organization.
   * @param {string} queue - Declared queue to enqueue in.
   * @param {unknown} payload - Job payload.
   * @param {JobEnqueueOptions} options - Optional occurrence key.
   * @returns {Promise<JobEnqueueResult>} Job id and whether the occurrence already existed.
   */
  public async enqueue(
    tx: JobsTransaction,
    queue: string,
    payload: unknown,
    options: JobEnqueueOptions,
  ): Promise<JobEnqueueResult> {
    this.requireCapability('producer');
    this.assertRunning();
    const name: string = this.requireQueue(queue).name;
    if (this.transactionalSender !== null) {
      return this.transactionalSender.enqueue(tx, name, payload, options);
    }
    return enqueueJob(this.requireBoss(), tx, name, payload, options);
  }

  /**
   * Method schedule
   *
   * @description
   * Stores a cron schedule for a declared queue.
   *
   * @param {string} queue - Declared queue to schedule.
   * @param {string} cron - Cron expression.
   * @param {JobScheduleOptions} options - Time zone, payload and optional key.
   * @returns {Promise<void>} Resolves once the schedule is stored.
   */
  public async schedule(queue: string, cron: string, options: JobScheduleOptions): Promise<void> {
    this.requireCapability('scheduler');
    await scheduleJob(this.requireBoss(), this.requireQueue(queue).name, cron, options);
  }

  /**
   * Method unschedule
   *
   * @description
   * Removes a schedule, including one for a queue no longer declared.
   *
   * @param {string} queue - Queue of the schedule.
   * @param {JobUnscheduleOptions} options - Optional key of the schedule.
   * @returns {Promise<void>} Resolves once the schedule is removed, or was absent.
   */
  public async unschedule(queue: string, options: JobUnscheduleOptions): Promise<void> {
    this.requireCapability('scheduler');
    await unscheduleJob(this.requireBoss(), queue, options);
  }

  /** Preserves the combined capabilities of the legacy module. */
  private has(capability: JobsCapability): boolean {
    return !('capabilities' in this.options) || this.options.capabilities.has(capability);
  }

  /** Refuses an operation outside the process capability set. */
  private requireCapability(capability: JobsCapability): void {
    if (!this.has(capability)) {
      throw new Error(`The ${capability} jobs capability is not enabled in this process.`);
    }
  }

  /** Refuses operations before initialization and after shutdown begins. */
  private assertRunning(): void {
    if (!this.running) {
      throw new Error(
        'JobsService is not started: use it once the application has initialized its modules and before it shuts down.',
      );
    }
  }

  /**
   * Method requireBoss
   *
   * @description
   * Gives the started pg-boss instance.
   *
   * @returns {PgBoss} The running instance.
   * @throws {Error} When called before the module started or after it shut down.
   */
  private requireBoss(): PgBoss {
    this.assertRunning();
    if (this.boss === null) {
      throw new Error(
        'JobsService is not started: use it once the application has initialized its modules and before it shuts down.',
      );
    }
    return this.boss;
  }

  /**
   * Method requireQueue
   *
   * @description
   * Gives the declaration of a queue.
   *
   * @param {string} queue - Queue name given by the caller.
   * @returns {ResolvedJobQueue} The resolved declaration.
   * @throws {Error} When the queue is not in the declarations given to `JobsModule`.
   */
  private requireQueue(queue: string): ResolvedJobQueue {
    const declared: ResolvedJobQueue | undefined = this.queues.get(queue);
    if (declared === undefined) {
      throw new Error(`Queue "${queue}" is not declared in the JobsModule options.`);
    }
    return declared;
  }
  // #endregion
}
