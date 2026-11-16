import type { Logger } from '@nestjs/common';
import type { PgBoss } from 'pg-boss';

import { describeError } from '../../jobs/diagnostics/describe-error.js';
import type { JobsQueryResult } from '../../jobs/database/jobs-transaction.js';
import type { ResolvedJobsModuleOptions } from '../../jobs/configuration/jobs-options.js';
import { fieldOf } from '../postgres/database-row.js';

/**
 * Constant DEAD_LETTER_COUNT_LIMIT
 *
 * @description
 * Largest queue size reported exactly. The query reads at most one more row per queue.
 *
 * @type {number}
 */
const DEAD_LETTER_COUNT_LIMIT: number = 1_000;

/**
 * Interface DeadLetterDatabase
 *
 * @description
 * The cancellation option of pg-boss's built-in PostgreSQL adapter. Its public database
 * interface also describes custom adapters, where this option is unavailable.
 */
interface DeadLetterDatabase {
  // #region Methods
  /**
   * Method executeSql
   *
   * @description
   * Executes the count on a connection that the adapter discards when the signal aborts.
   *
   * @param {string} text - Parameterized SQL statement used to count the backlog.
   * @param {unknown[]} values - Values bound to the statement placeholders.
   * @param {{ readonly signal: AbortSignal; }} options - Cancellation signal for the check.
   * @returns {Promise<JobsQueryResult>} Rows obtained by the monitoring query.
   */
  executeSql(
    text: string,
    values: unknown[],
    options: { readonly signal: AbortSignal },
  ): Promise<JobsQueryResult>;
  // #endregion
}

/**
 * Class DeadLetterWatch
 *
 * @description
 * Reports retained dead letters and cancels observation when the runtime stops.
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
   * Cancels the database check in flight and prevents two counts from overlapping.
   *
   * @type {AbortController | null}
   */
  private deadLetterCheck: AbortController | null = null;
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Sets up observation for the dead-letter queues of this runtime.
   *
   * @param {Pick<ResolvedJobsModuleOptions, 'schema' | 'deadLetterCheckIntervalSeconds' | 'shutdownTimeoutMs'>} options - Schema, observation interval and query deadline.
   * @param {readonly string[]} deadLetterQueues - Queues whose retained jobs are counted.
   * @param {Logger} logger - Logger scoped to the jobs service.
   * @constructor
   */
  public constructor(
    private readonly options: Pick<
      ResolvedJobsModuleOptions,
      'schema' | 'deadLetterCheckIntervalSeconds' | 'shutdownTimeoutMs'
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
   * Launches the initial check in the background and starts periodic observation. A monitoring
   * failure is logged without affecting readiness. The timer does not keep the process alive.
   *
   * @param {PgBoss} boss - Started pg-boss instance.
   */
  public start(boss: PgBoss): void {
    const seconds: number = this.options.deadLetterCheckIntervalSeconds;
    if (seconds === 0 || this.deadLetterQueues.length === 0) {
      return;
    }
    const check: () => void = (): void => {
      void this.count(boss).catch((error: unknown): void => {
        if (this.deadLetterTimer !== null) {
          this.logger.warn(`The dead-letter check failed: ${describeError(error)}`);
        }
      });
    };
    this.deadLetterTimer = setInterval(check, seconds * 1_000);
    this.deadLetterTimer.unref();
    check();
  }

  /**
   * Method count
   *
   * @description
   * Reports one error per non-empty queue, including jobs committed after an earlier snapshot.
   * Each replica observes the same stock. Counts are snapshots and can repeat between checks.
   *
   * @param {PgBoss} boss - Running pg-boss instance that owns the monitoring connection.
   * @returns {Promise<void>} Resolves when the check is skipped, completes or reports a failure.
   */
  private async count(boss: PgBoss): Promise<void> {
    if (this.deadLetterCheck !== null) {
      return;
    }
    const check: AbortController = new AbortController();
    this.deadLetterCheck = check;
    const deadlineMs: number = Math.min(this.options.shutdownTimeoutMs, 2_147_483_647);
    const signal: AbortSignal = AbortSignal.any([check.signal, AbortSignal.timeout(deadlineMs)]);
    try {
      const result: JobsQueryResult = await this.readBacklog(boss.getDb(), signal);
      signal.throwIfAborted();
      this.reportBacklog(result);
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    } finally {
      this.deadLetterCheck = null;
    }
  }

  /**
   * Method stop
   *
   * @description
   * Clears the timer and cancels the check without waiting for its connection to settle.
   * The pg-boss pool stays available to workers during their shutdown grace period.
   */
  public stop(): void {
    if (this.deadLetterTimer !== null) {
      clearInterval(this.deadLetterTimer);
      this.deadLetterTimer = null;
    }
    this.deadLetterCheck?.abort();
  }

  /**
   * Method readBacklog
   *
   * @description
   * Bounds each index lookup independently and never fetches job payloads.
   *
   * @param {DeadLetterDatabase} database - Database adapter of the running pg-boss instance.
   * @param {AbortSignal} signal - Signal that bounds the query and interrupts it during shutdown.
   * @returns {Promise<JobsQueryResult>} One bounded count for every non-empty monitored queue.
   */
  private async readBacklog(
    database: DeadLetterDatabase,
    signal: AbortSignal,
  ): Promise<JobsQueryResult> {
    return database.executeSql(
      `SELECT watched.name, backlog.count
       FROM pg_catalog.unnest($1::text[]) AS watched(name)
       CROSS JOIN LATERAL (
         SELECT count(*)::int AS count
         FROM (
           SELECT 1
           FROM "${this.options.schema}".job
           WHERE job.name = watched.name
           LIMIT $2
         ) retained
       ) backlog
       WHERE backlog.count > 0`,
      [this.deadLetterQueues, DEAD_LETTER_COUNT_LIMIT + 1],
      { signal },
    );
  }

  /**
   * Method reportBacklog
   *
   * @description
   * Logs retained rows by queue without implying an exact count above the query limit.
   *
   * @param {JobsQueryResult} result - Rows returned by the bounded backlog count.
   */
  private reportBacklog(result: JobsQueryResult): void {
    for (const row of result.rows) {
      const name: unknown = fieldOf(row, 'name');
      const count: unknown = fieldOf(row, 'count');
      if (typeof name === 'string' && typeof count === 'number' && count > 0) {
        const size: string =
          count > DEAD_LETTER_COUNT_LIMIT
            ? `More than ${String(DEAD_LETTER_COUNT_LIMIT)}`
            : String(count);
        this.logger.error(`${size} job(s) remain in the dead-letter queue "${name}".`);
      }
    }
  }
  // #endregion
}
