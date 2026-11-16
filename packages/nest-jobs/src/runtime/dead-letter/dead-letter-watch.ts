import type { Logger } from '@nestjs/common';
import type { PgBoss } from 'pg-boss';

import { describeError } from '../../jobs/describe-error.js';
import type { JobsQueryResult } from '../../jobs/job.js';
import type { ResolvedJobsModuleOptions } from '../../jobs/jobs-options.js';
import { fieldOf } from '../database-row.js';

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
 * Class DeadLetterWatch
 *
 * @description
 * Counts dead-letter arrivals and drains the last check before the runtime stops.
 */
export class DeadLetterWatch {
  // #region Properties
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
   * Sets up observation for the dead-letter queues of this runtime.
   *
   * @param {Pick<ResolvedJobsModuleOptions, 'schema' | 'deadLetterCheckIntervalSeconds'>} options - Schema and observation interval.
   * @param {readonly string[]} deadLetterQueues - Queues whose arrivals are counted.
   * @param {Logger} logger - Logger scoped to the jobs service.
   * @constructor
   */
  public constructor(
    private readonly options: Pick<
      ResolvedJobsModuleOptions,
      'schema' | 'deadLetterCheckIntervalSeconds'
    >,
    private readonly deadLetterQueues: readonly string[],
    private readonly logger: Logger,
  ) {}
  // #endregion

  // #region Methods
  /**
   * Method start
   *
   * @description
   * Arms the timer of the dead-letter watch, unless the watch is disabled or there is no queue to
   * watch. The timer does not keep the process alive.
   *
   * @param {PgBoss} boss - Started pg-boss instance.
   */
  public start(boss: PgBoss): void {
    const seconds: number = this.options.deadLetterCheckIntervalSeconds;
    if (seconds === 0 || this.deadLetterQueues.length === 0) {
      return;
    }
    this.deadLetterTimer = setInterval((): void => {
      if (this.deadLetterCheck !== null) {
        return;
      }
      this.deadLetterCheck = this.count(boss)
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
   * Method count
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
  public async count(boss: PgBoss): Promise<void> {
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
   * Method stop
   *
   * @description
   * Clears the timer and waits for the in-flight database query.
   *
   * @returns {Promise<void>} Resolves when there are no pending checks.
   */
  public async stop(): Promise<void> {
    if (this.deadLetterTimer !== null) {
      clearInterval(this.deadLetterTimer);
      this.deadLetterTimer = null;
    }
    await this.deadLetterCheck;
  }
  // #endregion
}
