import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { PgBoss, type JobWithMetadata, type QueueResult, type Warning } from 'pg-boss';

import { describeError, stackOf } from './describe-error.js';
import { readJobEnvelope, toJobEnvelope, type JobEnvelope } from './job-envelope.js';
import {
  deadLetterQueuesOf,
  type ResolvedDeadLetterQueue,
  type ResolvedJobQueue,
} from './job-queue.js';
import type {
  Job,
  JobEnqueueOptions,
  JobEnqueueResult,
  JobHandler,
  JobScheduleOptions,
  JobWorkOptions,
  JobsQueryResult,
  JobsTransaction,
} from './job.js';
import { JobsNotProvisionedError } from './jobs-not-provisioned.error.js';
import {
  JOBS_MODULE_OPTIONS,
  resolveJobsModuleOptions,
  toRuntimeBossOptions,
  type JobsModuleOptions,
  type ResolvedJobsModuleOptions,
} from './jobs-options.js';
import { assertOccurrenceKey, deriveOccurrenceJobId } from './occurrence-id.js';
import { assertTimeZone } from './time-zone.js';

/**
 * Constant PROVISION_HINT
 *
 * @description
 * How to fix a database that is not ready for the runtime, appended to start-up errors.
 *
 * @type {string}
 */
const PROVISION_HINT: string =
  'Run provisionJobs() as the migrator role, with the same queue declarations and this role as appRole, before starting the service.';

/**
 * Constant INSUFFICIENT_PRIVILEGE
 *
 * @description
 * SQLSTATE PostgreSQL answers with when the connected role lacks a right.
 *
 * @type {string}
 */
const INSUFFICIENT_PRIVILEGE: string = '42501';

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
 * Function hasSqlState
 *
 * @description
 * Tells whether a thrown value is a database error carrying the given SQLSTATE.
 *
 * @param {unknown} error - Value that was thrown.
 * @param {string} code - Five-character SQLSTATE.
 * @returns {boolean} Whether the error carries that code.
 */
function hasSqlState(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/**
 * Function toStartupError
 *
 * @description
 * Turns the failures that mean "the database was not provisioned" into one explicit error; any
 * other failure, such as an unreachable server, is returned unchanged.
 *
 * @param {unknown} error - Failure of the pg-boss start.
 * @param {string} schema - Schema the runtime was told to use.
 * @returns {unknown} A `JobsNotProvisionedError`, or the original failure.
 */
function toStartupError(error: unknown, schema: string): unknown {
  if (error instanceof JobsNotProvisionedError) {
    return error;
  }
  const message: string = error instanceof Error ? error.message : '';
  if (message === 'pg-boss is not installed') {
    return new JobsNotProvisionedError(
      `The pg-boss schema "${schema}" is not installed in this database. ${PROVISION_HINT}`,
      { cause: error },
    );
  }
  if (message === 'pg-boss database requires migrations') {
    return new JobsNotProvisionedError(
      `The pg-boss schema "${schema}" is not at the version this package expects. ${PROVISION_HINT}`,
      { cause: error },
    );
  }
  if (hasSqlState(error, INSUFFICIENT_PRIVILEGE)) {
    return new JobsNotProvisionedError(
      `The connected role lacks a right on the pg-boss schema "${schema}" (${message}). ${PROVISION_HINT}`,
      { cause: error },
    );
  }
  return error;
}

/**
 * Function settingsThatDiffer
 *
 * @description
 * Compares a declared queue with the row stored for it and names the settings that differ.
 *
 * @param {ResolvedJobQueue} declared - Queue as the service declares it.
 * @param {QueueResult} stored - Queue as the database holds it.
 * @returns {readonly string[]} Names of the differing settings, empty when the two agree.
 */
function settingsThatDiffer(declared: ResolvedJobQueue, stored: QueueResult): readonly string[] {
  const comparisons: readonly (readonly [string, unknown, unknown])[] = [
    ['retryLimit', declared.retryLimit, stored.retryLimit],
    ['retryDelaySeconds', declared.retryDelaySeconds, stored.retryDelay],
    ['retryBackoff', declared.retryBackoff, stored.retryBackoff],
    ['retryDelayMaxSeconds', declared.retryDelayMaxSeconds, stored.retryDelayMax ?? null],
    ['deadLetter', declared.deadLetter, stored.deadLetter ?? null],
    ['expireInSeconds', declared.expireInSeconds, stored.expireInSeconds],
    ['retentionSeconds', declared.retentionSeconds, stored.retentionSeconds],
    ['deleteAfterSeconds', declared.deleteAfterSeconds, stored.deleteAfterSeconds],
  ];
  return comparisons
    .filter((comparison: readonly [string, unknown, unknown]): boolean => {
      return comparison[1] !== comparison[2];
    })
    .map((comparison: readonly [string, unknown, unknown]): string => comparison[0]);
}

/**
 * Service JobsService
 *
 * @description
 * Runtime of the durable background jobs of a service, on top of pg-boss, with the application
 * role.
 *
 * It starts with the module and fails the start-up of the application when the database was not
 * provisioned. It never runs DDL. Its pool holds two connections, apart from the application pool.
 * Delivery is at least once: a job can run again after a crash, a timeout or a shutdown, so every
 * handler must be idempotent.
 */
@Injectable()
export class JobsService implements OnModuleInit, BeforeApplicationShutdown {
  // #region Properties
  /**
   * Property logger
   *
   * @description
   * Logger of the runtime. It receives identifiers and error messages, never a job payload.
   *
   * @type {Logger}
   * @readonly
   */
  private readonly logger: Logger = new Logger(JobsService.name);

  /**
   * Property options
   *
   * @description
   * Module options with their defaults applied.
   *
   * @type {ResolvedJobsModuleOptions}
   * @readonly
   */
  private readonly options: ResolvedJobsModuleOptions;

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
   * Property boss
   *
   * @description
   * The started pg-boss instance, or `null` before start-up and after shutdown.
   *
   * @type {PgBoss | null}
   */
  private boss: PgBoss | null = null;
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
    this.options = resolveJobsModuleOptions(options);
    this.queues = new Map<string, ResolvedJobQueue>(
      this.options.queues.map((queue: ResolvedJobQueue): [string, ResolvedJobQueue] => [
        queue.name,
        queue,
      ]),
    );
  }
  // #endregion

  // #region Methods
  /**
   * Method onModuleInit
   *
   * @description
   * Starts pg-boss with the application role and checks that the schema and every declared queue
   * were provisioned. The module is global, so this runs before the `onModuleInit` of the modules
   * that register workers.
   *
   * @returns {Promise<void>} Resolves once jobs can be enqueued and workers registered.
   * @throws {JobsNotProvisionedError} When the schema, a grant or a declared queue is missing.
   */
  public async onModuleInit(): Promise<void> {
    if (this.boss !== null) {
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
      await this.assertProvisioned(boss);
    } catch (error) {
      try {
        await boss.stop({ graceful: false });
      } catch (stopError) {
        this.logger.warn(`pg-boss did not stop cleanly: ${describeError(stopError)}`);
      }
      throw toStartupError(error, this.options.schema);
    }
    this.boss = boss;
  }

  /**
   * Method beforeApplicationShutdown
   *
   * @description
   * Stops fetching jobs, lets running handlers finish for `shutdownTimeoutMs`, fails the attempts
   * still running after that so they are retried later, then closes the pool. It runs before the
   * `onApplicationShutdown` hooks, where an application usually closes its own resources.
   *
   * @returns {Promise<void>} Resolves once pg-boss is stopped.
   */
  public async beforeApplicationShutdown(): Promise<void> {
    const boss: PgBoss | null = this.boss;
    if (boss === null) {
      return;
    }
    await boss.stop({ graceful: true, timeout: this.options.shutdownTimeoutMs });
    this.boss = null;
  }

  /**
   * Method enqueue
   *
   * @description
   * Inserts a job through the client of the caller's transaction: the job exists if and only if the
   * transaction commits.
   *
   * With an occurrence key the job id is derived from the queue and the key, and a second enqueue
   * of the same pair inserts nothing while the first job row exists, whatever its state. The row is
   * deleted `deleteAfterSeconds` after the job finished, or `retentionSeconds` after it was last due
   * if it never started, so the business table stays the source of truth beyond that.
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
    const boss: PgBoss = this.requireBoss();
    const declared: ResolvedJobQueue = this.requireQueue(queue);
    const envelope: JobEnvelope = toJobEnvelope(tx.organizationId, payload);
    const occurrenceKey: unknown = options.occurrenceKey;
    if (occurrenceKey !== undefined) {
      assertOccurrenceKey(occurrenceKey);
    }
    const id: string | undefined =
      occurrenceKey === undefined ? undefined : deriveOccurrenceJobId(declared.name, occurrenceKey);
    const created: string | null = await boss.send(declared.name, envelope, {
      ...(id === undefined ? {} : { id }),
      db: {
        executeSql: (text: string, values?: unknown[]): Promise<JobsQueryResult> =>
          tx.client.query(text, values),
      },
    });
    if (created !== null) {
      return { jobId: created, duplicate: false };
    }
    if (id === undefined) {
      throw new Error(`The job could not be created in queue "${declared.name}".`);
    }
    return { jobId: id, duplicate: true };
  }

  /**
   * Method work
   *
   * @description
   * Registers a handler for a declared queue. Jobs are handled one at a time per unit of
   * `concurrency`, each call wrapped in `runInOrganization`.
   *
   * A handler that rejects, or runs longer than the queue's `expireInSeconds`, fails the attempt.
   * The job is retried after the queue's delay, with exponential backoff when enabled, up to
   * `retryLimit` times; then it is copied to the dead-letter queue. A rejected attempt is logged as
   * a warning, the last one as an error, with the job id and never the payload.
   *
   * @param {string} queue - Declared queue to consume.
   * @param {JobHandler<TPayload>} handler - Idempotent handler of one job.
   * @param {JobWorkOptions} [options] - Concurrency and polling interval.
   * @returns {Promise<void>} Resolves once the worker polls the queue.
   * @throws {Error} When the runtime is not started, the queue is not declared or an option is out
   * of bounds.
   */
  public async work<TPayload>(
    queue: string,
    handler: JobHandler<TPayload>,
    options: JobWorkOptions = {},
  ): Promise<void> {
    const boss: PgBoss = this.requireBoss();
    const declared: ResolvedJobQueue = this.requireQueue(queue);
    const concurrency: number = options.concurrency ?? 1;
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
    await boss.work(
      declared.name,
      {
        includeMetadata: true,
        batchSize: 1,
        localConcurrency: concurrency,
        pollingIntervalSeconds,
      },
      async (jobs: JobWithMetadata<unknown>[]): Promise<void> => {
        for (const job of jobs) {
          await this.handle(declared, job, handler);
        }
      },
    );
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
    const boss: PgBoss = this.requireBoss();
    const declared: ResolvedJobQueue = this.requireQueue(queue);
    const timeZone: unknown = options.timeZone;
    assertTimeZone(timeZone);
    await boss.schedule(declared.name, cron, toJobEnvelope(null, options.payload), {
      tz: timeZone,
      ...(options.key === undefined ? {} : { key: options.key }),
    });
  }

  /**
   * Method unschedule
   *
   * @description
   * Removes a stored schedule. A schedule stays in the database until it is removed: deleting the
   * `schedule` call from the code does not stop it.
   *
   * @param {string} queue - Declared queue of the schedule.
   * @param {string} [key] - Key of the schedule; the empty key when omitted.
   * @returns {Promise<void>} Resolves once the schedule is removed, or was not there.
   * @throws {Error} When the runtime is not started or the queue is not declared.
   */
  public async unschedule(queue: string, key?: string): Promise<void> {
    const boss: PgBoss = this.requireBoss();
    const declared: ResolvedJobQueue = this.requireQueue(queue);
    await boss.unschedule(declared.name, key ?? '');
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

  /**
   * Method assertProvisioned
   *
   * @description
   * Checks that every declared queue and dead-letter queue exists, and warns when a stored queue
   * differs from its declaration, which means the provisioning did not run with this version.
   *
   * @param {PgBoss} boss - Started pg-boss instance.
   * @returns {Promise<void>} Resolves when every queue exists.
   * @throws {JobsNotProvisionedError} When a queue is missing.
   */
  private async assertProvisioned(boss: PgBoss): Promise<void> {
    const expected: string[] = [
      ...this.queues.keys(),
      ...deadLetterQueuesOf(this.options.queues).map(
        (deadLetter: ResolvedDeadLetterQueue): string => deadLetter.name,
      ),
    ];
    if (expected.length === 0) {
      return;
    }
    const stored: Map<string, QueueResult> = new Map<string, QueueResult>();
    for (const queue of await boss.getQueues(expected, { limit: expected.length })) {
      stored.set(queue.name, queue);
    }
    const missing: string[] = expected.filter((name: string): boolean => !stored.has(name));
    if (missing.length > 0) {
      throw new JobsNotProvisionedError(
        `These queues do not exist in the pg-boss schema "${this.options.schema}": ${missing.join(', ')}. ${PROVISION_HINT}`,
      );
    }
    for (const declared of this.options.queues) {
      const row: QueueResult | undefined = stored.get(declared.name);
      const differing: readonly string[] =
        row === undefined ? [] : settingsThatDiffer(declared, row);
      if (differing.length > 0) {
        this.logger.warn(
          `Queue "${declared.name}" is stored with settings that differ from its declaration (${differing.join(', ')}). Run provisionJobs() to apply the declaration.`,
        );
      }
    }
  }

  /**
   * Method handle
   *
   * @description
   * Runs one attempt of one job: reads its envelope, calls the handler inside `runInOrganization`
   * and, when the attempt fails, logs it and lets pg-boss apply the retry policy.
   *
   * The failure is rethrown on purpose: pg-boss then moves the job to `retry`, or to `failed` and
   * the dead-letter queue when no retry is left.
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
    const attempt: number = job.retryCount + 1;
    const attempts: number = job.retryLimit + 1;
    try {
      const envelope: JobEnvelope = readJobEnvelope(job.data);
      const context: Job<TPayload> = {
        id: job.id,
        queue: queue.name,
        payload: envelope.payload as TPayload,
        organizationId: envelope.organizationId,
        attempt,
      };
      await this.options.runInOrganization(envelope.organizationId, (): Promise<void> =>
        handler(context),
      );
    } catch (error) {
      const progress: string = `${String(attempt)} of ${String(attempts)}`;
      if (attempt >= attempts) {
        this.logger.error(
          `Job ${job.id} of queue "${queue.name}" failed its last attempt (${progress}) and moves to the dead-letter queue "${job.deadLetter}": ${describeError(error)}`,
          stackOf(error),
        );
      } else {
        this.logger.warn(
          `Job ${job.id} of queue "${queue.name}" failed attempt ${progress} and will be retried: ${describeError(error)}`,
        );
      }
      throw error;
    }
  }
  // #endregion
}
