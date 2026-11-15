import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import {
  PgBoss,
  type JobWithMetadata,
  type QueueResult,
  type Schedule,
  type Warning,
} from 'pg-boss';

import { describeError, stackOf } from './describe-error.js';
import { readJobEnvelope, toJobEnvelope, type JobEnvelope } from './job-envelope.js';
import {
  assertQueueName,
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
  JobUnscheduleOptions,
  JobWorkOptions,
  JobsQueryResult,
  JobsTransaction,
} from './job.js';
import { JobsNotProvisionedError } from './jobs-not-provisioned.error.js';
import {
  JOBS_MODULE_OPTIONS,
  resolveJobsModuleOptions,
  type JobsModuleOptions,
  type ResolvedJobsModuleOptions,
} from './jobs-options.js';
import { assertOccurrenceKey, deriveOccurrenceJobId } from './occurrence-id.js';
import { toRuntimeBossOptions } from './runtime-boss-options.js';
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
 * Constant DEAD_LETTER_LAG_SECONDS
 *
 * @description
 * How far behind the database clock the dead-letter watch counts, in seconds. A dead letter is
 * stamped with the start time of the statement that inserts it and becomes visible when that
 * statement commits; counting up to a few seconds ago keeps a row that commits late from falling
 * between two checks.
 *
 * @type {number}
 */
const DEAD_LETTER_LAG_SECONDS: number = 5;

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
   * Timer that fires once the attempt has run for the queue's `expireInSeconds`.
   *
   * @type {NodeJS.Timeout}
   * @readonly
   */
  readonly expiry: NodeJS.Timeout;

  /**
   * Property reported
   *
   * @description
   * Whether the failure of the attempt was already logged, so one attempt gives one log line.
   *
   * @type {boolean}
   */
  reported: boolean;
  // #endregion
}

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
 * Function fieldOf
 *
 * @description
 * Reads one column of a row returned by the database handle of pg-boss, which types rows loosely.
 *
 * @param {unknown} row - Row of a query result.
 * @param {string} column - Column name.
 * @returns {unknown} The value of the column, or `undefined` when the row has none.
 */
function fieldOf(row: unknown, column: string): unknown {
  return typeof row === 'object' && row !== null
    ? (row as Record<string, unknown>)[column]
    : undefined;
}

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
   * Attempts whose handler has not settled yet, by job id.
   *
   * @type {Map<string, RunningAttempt>}
   * @readonly
   */
  private readonly running: Map<string, RunningAttempt> = new Map<string, RunningAttempt>();

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
   * Property deadLetterTimer
   *
   * @description
   * Timer of the dead-letter watch, or `null` when the watch is off or stopped.
   *
   * @type {NodeJS.Timeout | null}
   */
  private deadLetterTimer: NodeJS.Timeout | null = null;

  /**
   * Property deadLetterCheck
   *
   * @description
   * The dead-letter count in flight, or `null`, so two counts never overlap and shutdown can wait
   * for the last one before the pool closes.
   *
   * @type {Promise<void> | null}
   */
  private deadLetterCheck: Promise<void> | null = null;

  /**
   * Property deadLetterWatermark
   *
   * @description
   * Database time up to which dead-letter arrivals were counted, as the database rendered it, or
   * `null` before the first count.
   *
   * @type {string | null}
   */
  private deadLetterWatermark: string | null = null;
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
    this.deadLetterQueues = deadLetterQueuesOf(this.options.queues).map(
      (deadLetter: ResolvedDeadLetterQueue): string => deadLetter.name,
    );
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
      await this.countDeadLetters(boss);
    } catch (error) {
      try {
        await boss.stop({ graceful: false });
      } catch (stopError) {
        this.logger.warn(`pg-boss did not stop cleanly: ${describeError(stopError)}`);
      }
      throw toStartupError(error, this.options.schema);
    }
    this.boss = boss;
    this.startDeadLetterWatch(boss);
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
    const boss: PgBoss | null = this.boss;
    if (boss === null) {
      return;
    }
    if (this.deadLetterTimer !== null) {
      clearInterval(this.deadLetterTimer);
      this.deadLetterTimer = null;
    }
    await this.deadLetterCheck;
    await boss.stop({ graceful: true, timeout: this.options.shutdownTimeoutMs });
    for (const [id, attempt] of this.running) {
      this.reportFailedAttempt(
        id,
        attempt,
        `it was still running when the shutdown timeout of ${String(this.options.shutdownTimeoutMs)} ms passed`,
      );
    }
    this.boss = null;
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
    const boss: PgBoss = this.requireBoss();
    const declared: ResolvedJobQueue = this.requireQueue(queue);
    const envelope: JobEnvelope = toJobEnvelope(tx.organizationId, payload);
    const occurrenceKey: unknown = options.occurrenceKey;
    if (occurrenceKey !== undefined) {
      assertOccurrenceKey(occurrenceKey);
    }
    const id: string | undefined =
      occurrenceKey === undefined
        ? undefined
        : deriveOccurrenceJobId(declared.name, envelope.organizationId, occurrenceKey);
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
   * `schedule` call from the code does not stop it. The queue does not have to be declared any
   * more, so the schedule of a queue that left the declarations can still be removed.
   *
   * @param {string} queue - Queue of the schedule, declared or not.
   * @param {JobUnscheduleOptions} [options] - Key of the schedule; the empty key when omitted.
   * @returns {Promise<void>} Resolves once the schedule is removed, or was not there.
   * @throws {Error} When the runtime is not started or the queue name is not a valid name.
   */
  public async unschedule(queue: string, options: JobUnscheduleOptions = {}): Promise<void> {
    const boss: PgBoss = this.requireBoss();
    const name: unknown = queue;
    assertQueueName(name, 'Queue name');
    await boss.unschedule(name, options.key ?? '');
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

  /**
   * Method startDeadLetterWatch
   *
   * @description
   * Arms the timer of the dead-letter watch, unless the watch is disabled or there is no queue to
   * watch. The timer does not keep the process alive.
   *
   * @param {PgBoss} boss - Started pg-boss instance.
   */
  private startDeadLetterWatch(boss: PgBoss): void {
    const seconds: number = this.options.deadLetterCheckIntervalSeconds;
    if (seconds === 0 || this.deadLetterQueues.length === 0) {
      return;
    }
    this.deadLetterTimer = setInterval((): void => {
      if (this.deadLetterCheck !== null) {
        return;
      }
      this.deadLetterCheck = this.countDeadLetters(boss)
        .catch((error: unknown): void => {
          this.logger.warn(`The dead-letter check failed: ${describeError(error)}`);
        })
        .finally((): void => {
          this.deadLetterCheck = null;
        });
    }, seconds * 1_000);
    this.deadLetterTimer.unref();
  }

  /**
   * Method countDeadLetters
   *
   * @description
   * Counts the jobs that arrived in each declared dead-letter queue since the previous count and
   * logs one error per queue that received some, with the count and never a payload.
   *
   * This is the log of the dead letters no handler can report: an attempt failed by pg-boss
   * supervision after its process crashed. It also counts the dead letters a worker already
   * logged, and every replica runs it, so one dead letter can be reported more than once.
   *
   * pg-boss has no call that counts arrivals without returning the payloads, so this is one
   * read-only statement on the job table, run through the database handle of pg-boss. The first
   * count only records where to start from.
   *
   * @param {PgBoss} boss - Started pg-boss instance.
   * @returns {Promise<void>} Resolves once the arrivals were counted and logged.
   */
  private async countDeadLetters(boss: PgBoss): Promise<void> {
    if (this.options.deadLetterCheckIntervalSeconds === 0 || this.deadLetterQueues.length === 0) {
      return;
    }
    const result: JobsQueryResult = await boss.getDb().executeSql(
      `WITH bounds AS (
         SELECT pg_catalog.now() - interval '${String(DEAD_LETTER_LAG_SECONDS)} seconds' AS upto
       )
       SELECT bounds.upto::text AS upto, arrivals.name, arrivals.count
       FROM bounds
       LEFT JOIN LATERAL (
         SELECT job.name, count(*)::int AS count
         FROM "${this.options.schema}".job
         WHERE job.name = ANY($1::text[])
           AND job.created_on > COALESCE($2::timestamptz, bounds.upto)
           AND job.created_on <= bounds.upto
         GROUP BY job.name
       ) arrivals ON true`,
      [this.deadLetterQueues, this.deadLetterWatermark],
    );
    for (const row of result.rows) {
      const name: unknown = fieldOf(row, 'name');
      const count: unknown = fieldOf(row, 'count');
      if (typeof name === 'string' && typeof count === 'number' && count > 0) {
        this.logger.error(
          `${String(count)} job(s) reached the dead-letter queue "${name}" since the previous check.`,
        );
      }
    }
    const upto: unknown = fieldOf(result.rows[0], 'upto');
    if (typeof upto === 'string') {
      this.deadLetterWatermark = upto;
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
   * @param {string} id - Job id.
   * @param {RunningAttempt} attempt - The attempt that failed.
   * @param {string} reason - Why it failed: the error of the handler, or what stopped it.
   * @param {string} [stack] - Stack of the error, for the last attempt.
   */
  private reportFailedAttempt(
    id: string,
    attempt: RunningAttempt,
    reason: string,
    stack?: string,
  ): void {
    if (attempt.reported) {
      return;
    }
    attempt.reported = true;
    clearTimeout(attempt.expiry);
    const progress: string = `${String(attempt.attempt)} of ${String(attempt.attempts)}`;
    if (attempt.attempt >= attempt.attempts) {
      this.logger.error(
        `Job ${id} of queue "${attempt.queue}" failed its last attempt (${progress}) and moves to the dead-letter queue "${attempt.deadLetter}": ${reason}`,
        stack,
      );
    } else {
      this.logger.warn(
        `Job ${id} of queue "${attempt.queue}" failed attempt ${progress} and will be retried: ${reason}`,
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
    const expireInMs: number = job.expireInSeconds * 1_000;
    const startedAt: number = Date.now();
    const endedBecause: () => string = (): string =>
      Date.now() - startedAt >= expireInMs - EXPIRY_LOG_MARGIN_MS
        ? `it ran longer than the ${String(job.expireInSeconds)} seconds of expireInSeconds`
        : 'the application shut down before it finished';
    let failure: string | null = null;
    const attempt: RunningAttempt = {
      queue: queue.name,
      attempt: job.retryCount + 1,
      attempts: job.retryLimit + 1,
      deadLetter: job.deadLetter,
      expiry: setTimeout((): void => {
        this.reportFailedAttempt(job.id, attempt, endedBecause());
      }, expireInMs + EXPIRY_LOG_MARGIN_MS),
      reported: false,
    };
    attempt.expiry.unref();
    this.running.set(job.id, attempt);
    try {
      const envelope: JobEnvelope = readJobEnvelope(job.data);
      const context: Job<TPayload> = {
        id: job.id,
        queue: queue.name,
        payload: envelope.payload as TPayload,
        organizationId: envelope.organizationId,
        attempt: attempt.attempt,
        signal: job.signal,
      };
      await this.options.runInOrganization(envelope.organizationId, (): Promise<void> =>
        handler(context),
      );
      if (job.signal.aborted) {
        // pg-boss aborts the signal when it fails the attempt itself. A handler that stopped on
        // the signal and returned did not complete the job: the attempt is already failed.
        this.reportFailedAttempt(job.id, attempt, endedBecause());
      }
    } catch (error) {
      this.reportFailedAttempt(
        job.id,
        attempt,
        job.signal.aborted ? `${endedBecause()} (${describeError(error)})` : describeError(error),
        stackOf(error),
      );
      failure = describeError(error);
    } finally {
      clearTimeout(attempt.expiry);
      this.running.delete(job.id);
    }
    if (failure !== null) {
      // Thrown outside the catch, and without the original error as its cause, on purpose: pg-boss
      // would store the cause chain with the job.
      throw new Error(failure);
    }
  }
  // #endregion
}
