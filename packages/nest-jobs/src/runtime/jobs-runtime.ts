import type { Logger } from '@nestjs/common';
import { PgBoss, type QueueResult, type Schedule, type Warning } from 'pg-boss';

import { describeError } from '../jobs/describe-error.js';
import {
  deadLetterQueuesOf,
  type ResolvedDeadLetterQueue,
  type ResolvedJobQueue,
} from '../jobs/job-queue.js';
import type { JobHandler, JobWorkOptions, JobsQueryResult } from '../jobs/job.js';
import type { ResolvedJobsModuleOptions } from '../jobs/jobs-options.js';
import { fieldOf } from './database-row.js';
import { DeadLetterWatch } from './dead-letter/dead-letter-watch.js';
import { JobsNotProvisionedError } from './jobs-not-provisioned.error.js';
import { toRuntimeBossOptions } from './runtime-boss-options.js';
import { JobWorkers } from './workers/job-workers.js';

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
   * Names of the dead-letter queues of the declared queues, watched for arrivals.
   *
   * @type {readonly string[]}
   * @readonly
   */
  private readonly deadLetterQueues: readonly string[];

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
   * @type {JobWorkers}
   * @readonly
   */
  private readonly workers: JobWorkers;

  /**
   * Property deadLetterWatch
   *
   * @description
   * Dead-letter monitoring that must drain before pg-boss stops.
   *
   * @type {DeadLetterWatch}
   * @readonly
   */
  private readonly deadLetterWatch: DeadLetterWatch;
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
    private readonly options: ResolvedJobsModuleOptions,
    private readonly logger: Logger,
  ) {
    this.queues = new Map<string, ResolvedJobQueue>(
      options.queues.map((queue: ResolvedJobQueue): [string, ResolvedJobQueue] => [
        queue.name,
        queue,
      ]),
    );
    this.deadLetterQueues = deadLetterQueuesOf(options.queues).map(
      (deadLetter: ResolvedDeadLetterQueue): string => deadLetter.name,
    );
    this.workers = new JobWorkers(options, logger);
    this.deadLetterWatch = new DeadLetterWatch(options, this.deadLetterQueues, logger);
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
      await this.assertUnprivilegedRole(boss);
      await this.assertProvisioned(boss);
      await this.warnAboutOrphanSchedules(boss);
      await this.deadLetterWatch.count(boss);
    } catch (error) {
      try {
        await boss.stop({ graceful: false });
      } catch (stopError) {
        this.logger.warn(`pg-boss did not stop cleanly: ${describeError(stopError)}`);
      }
      throw toStartupError(error, this.options.schema);
    }
    this.boss = boss;
    this.deadLetterWatch.start(boss);
  }

  /**
   * Method stop
   *
   * @description
   * Stops the dead-letter watch, stops fetching jobs, lets running handlers finish for
   * `shutdownTimeoutMs`, fails the attempts still running after that, logs each of them with its
   * job id, then closes the pool. A failed attempt uses one retry of its job. It runs before the
   * `onApplicationShutdown` hooks, where an application usually closes its own resources.
   *
   * @returns {Promise<void>} Resolves once pg-boss is stopped.
   */
  public async stop(): Promise<void> {
    const boss: PgBoss | null = this.boss;
    if (boss === null) {
      return;
    }
    await this.deadLetterWatch.stop();
    await boss.stop({ graceful: true, timeout: this.options.shutdownTimeoutMs });
    this.workers.reportInterrupted(this.options.shutdownTimeoutMs);
    this.boss = null;
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
    await this.workers.register(this.requireBoss(), this.requireQueue(queue), handler, options);
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
  public requireBoss(): PgBoss {
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
  public requireQueue(queue: string): ResolvedJobQueue {
    const declared: ResolvedJobQueue | undefined = this.queues.get(queue);
    if (declared === undefined) {
      throw new Error(`Queue "${queue}" is not declared in the JobsModule options.`);
    }
    return declared;
  }

  /**
   * Method assertUnprivilegedRole
   *
   * @description
   * Refuses to run as a role that can create objects in the pg-boss schema: the migrator role, an
   * owner or a superuser. A connection that picked up the wrong credentials would otherwise give a
   * long-running service the DDL rights the two-role split exists to keep away from it.
   *
   * @param {PgBoss} boss - Started pg-boss instance.
   * @returns {Promise<void>} Resolves when the role is acceptable.
   * @throws {Error} When the role can create objects and `allowPrivilegedRole` is not set.
   */
  private async assertUnprivilegedRole(boss: PgBoss): Promise<void> {
    if (this.options.allowPrivilegedRole) {
      return;
    }
    const result: JobsQueryResult = await boss
      .getDb()
      .executeSql(
        "SELECT pg_catalog.has_schema_privilege(current_user, $1, 'CREATE') AS privileged, current_user::text AS role",
        [this.options.schema],
      );
    if (fieldOf(result.rows[0], 'privileged') === true) {
      throw new Error(
        `The runtime is connected as "${String(fieldOf(result.rows[0], 'role'))}", a role that can create objects in the pg-boss schema "${this.options.schema}". Connect as the application role, which provisionJobs() grants data access only, or set allowPrivilegedRole for a local stack with a single role.`,
      );
    }
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
    const expected: string[] = [...this.queues.keys(), ...this.deadLetterQueues];
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
   * Method warnAboutOrphanSchedules
   *
   * @description
   * Warns about each stored schedule whose queue is not declared. The provisioning leaves a queue
   * that left the declarations in place, and its schedule keeps creating jobs nothing consumes.
   *
   * @param {PgBoss} boss - Started pg-boss instance.
   * @returns {Promise<void>} Resolves once the stored schedules were read.
   */
  private async warnAboutOrphanSchedules(boss: PgBoss): Promise<void> {
    const schedules: Schedule[] = await boss.getSchedules();
    for (const schedule of schedules) {
      if (!this.queues.has(schedule.name)) {
        this.logger.warn(
          `A schedule is stored for queue "${schedule.name}" (key "${schedule.key}"), which is not declared: it still creates jobs that nothing consumes. Remove it with unschedule(), or declare the queue.`,
        );
      }
    }
  }
  // #endregion
}
