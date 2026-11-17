import type {
  DatabaseSchema,
  SystemTransactionRunner,
  TransactionScope,
} from '@cadenway/nest-common/database';
import { Logger } from '@nestjs/common';

import type { ResolvedOutboxOptions } from '../wiring/outbox-options.js';
import {
  MAINTENANCE_BATCH_SIZE,
  maintainOutboxBatch,
  type MaintenancePhase,
} from './outbox-maintenance-batch.js';
import type { RestrictedNames } from './outbox-redaction.js';

/**
 * Type MaintenanceOptions
 *
 * @description
 * Intervals and retention settings needed by automatic maintenance.
 *
 * @type {Pick<ResolvedOutboxOptions, 'pollIntervalMs' | 'purgeIntervalMs' | 'retentionDays' | 'processedRetentionDays'>}
 */
type MaintenanceOptions = Pick<
  ResolvedOutboxOptions,
  'pollIntervalMs' | 'purgeIntervalMs' | 'retentionDays' | 'processedRetentionDays'
>;

/**
 * Constant MAX_TIMER_DELAY_MS
 *
 * @description
 * Largest delay the Node.js timer can schedule in one step, in milliseconds.
 *
 * @type {number}
 */
const MAX_TIMER_DELAY_MS: number = 2_147_483_647;
/**
 * Constant MAX_RETRY_DELAY_MS
 *
 * @description
 * Maintenance failure backoff ceiling before applying any longer configured polling interval, in milliseconds.
 *
 * @type {number}
 */
const MAX_RETRY_DELAY_MS: number = 30_000;

/**
 * Class OutboxMaintenanceRunner
 *
 * @description
 * Schedules bounded maintenance transactions independently of publication.
 */
export class OutboxMaintenanceRunner {
  // #region Properties
  /**
   * Property logger
   *
   * @description
   * Logs failures and committed changes of a completed phase.
   *
   * @type {Logger}
   * @readonly
   */
  private readonly logger: Logger = new Logger('OutboxMaintenance');

  /**
   * Property started
   *
   * @description
   * Whether the retention scheduler may create another timer.
   *
   * @type {boolean}
   */
  private started: boolean = false;

  /**
   * Property timer
   *
   * @description
   * Next scheduled check, canceled before the database closes.
   *
   * @type {NodeJS.Timeout | undefined}
   */
  private timer: NodeJS.Timeout | undefined;

  /**
   * Property batch
   *
   * @description
   * Active maintenance transaction that shutdown must drain.
   *
   * @type {Promise<void> | undefined}
   */
  private batch: Promise<void> | undefined;

  /**
   * Property phase
   *
   * @description
   * Retention operation repeated until a batch no longer fills the configured limit.
   *
   * @type {MaintenancePhase}
   */
  private phase: MaintenancePhase = 'redact';

  /**
   * Property changedRows
   *
   * @description
   * Committed row count for the current phase across successive batches.
   *
   * @type {number}
   */
  private changedRows: number = 0;

  /**
   * Property failedBatches
   *
   * @description
   * Consecutive failed maintenance transactions used to calculate backoff.
   *
   * @type {number}
   */
  private failedBatches: number = 0;

  /**
   * Property nextCycleAt
   *
   * @description
   * Monotonic deadline for the next retention cycle, in milliseconds.
   *
   * @type {number}
   */
  private nextCycleAt: number = 0;
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Uses system transactions to maintain the service's outbox and processed ids.
   *
   * @param {SystemTransactionRunner<DatabaseSchema>} system - Opens system transactions for retention and redaction.
   * @param {MaintenanceOptions} options - Polling, purge and retention configuration for maintenance.
   * @param {RestrictedNames} restricted - Persisted route rules for identifying restricted rows.
   * @constructor
   */
  public constructor(
    private readonly system: SystemTransactionRunner<DatabaseSchema>,
    private readonly options: MaintenanceOptions,
    private readonly restricted: RestrictedNames,
  ) {}
  // #endregion

  // #region Methods
  /**
   * Method start
   *
   * @description
   * Schedules the initial restricted-payload sweep even when periodic purges are disabled.
   */
  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.schedule(0);
  }

  /**
   * Method stop
   *
   * @description
   * Cancels future work and waits for the current transaction before the database closes.
   *
   * @returns {Promise<void>} Resolves after any active maintenance transaction has settled.
   */
  public async stop(): Promise<void> {
    this.started = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.batch;
  }

  /**
   * Method schedule
   *
   * @description
   * Schedules the next maintenance step and splits waits that exceed Node.js timer limits.
   *
   * @param {number} delayMs - Requested wait before the next step, in milliseconds.
   */
  private schedule(delayMs: number): void {
    if (!this.started) {
      return;
    }
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        const untilNextCycle: number = this.nextCycleAt - performance.now();
        if (untilNextCycle > 0) {
          this.schedule(untilNextCycle);
          return;
        }
        this.nextCycleAt = 0;
        this.batch = this.tick();
      },
      Math.min(delayMs, MAX_TIMER_DELAY_MS),
    );
  }

  /**
   * Method tick
   *
   * @description
   * Runs one transaction, retaining the current phase until all its rows have been handled.
   *
   * @returns {Promise<void>} Resolves after the active step finishes and any follow-up is scheduled.
   */
  private async tick(): Promise<void> {
    let delayMs: number | undefined;
    try {
      const retentionDays: number =
        this.phase === 'purge-processed'
          ? this.options.processedRetentionDays
          : this.options.retentionDays;
      const count: number | undefined = await this.system.run(
        (tx: TransactionScope<DatabaseSchema>) =>
          maintainOutboxBatch(tx.client, this.phase, this.restricted, retentionDays),
      );
      this.failedBatches = 0;
      if (count === undefined) {
        delayMs = this.options.pollIntervalMs;
      } else {
        this.changedRows += count;
        delayMs = count === MAINTENANCE_BATCH_SIZE ? 0 : this.finishPhase();
      }
    } catch (error) {
      this.failedBatches += 1;
      delayMs = Math.max(
        this.options.pollIntervalMs,
        Math.min(this.options.pollIntervalMs * 2 ** (this.failedBatches - 1), MAX_RETRY_DELAY_MS),
      );
      this.logger.error({ err: error }, 'outbox maintenance failed');
    }
    this.batch = undefined;
    if (delayMs !== undefined) {
      this.schedule(delayMs);
    }
  }

  /**
   * Method finishPhase
   *
   * @description
   * Reports the committed count, advances the phase and chooses when to resume maintenance.
   *
   * @returns {number | undefined} Delay in milliseconds before the next step, or undefined when maintenance should stop.
   */
  private finishPhase(): number | undefined {
    const changed: number = this.changedRows;
    this.changedRows = 0;
    switch (this.phase) {
      case 'redact':
        if (changed > 0) {
          this.logger.warn(
            { redacted: changed },
            'restricted outbox rows sent without redaction were redacted',
          );
        }
        if (!(this.options.purgeIntervalMs > 0 && Number.isFinite(this.options.purgeIntervalMs))) {
          return undefined;
        }
        this.phase = 'purge-sent';
        return 0;
      case 'purge-sent':
        if (changed > 0) {
          this.logger.log({ outbox: changed }, 'old outbox rows purged');
        }
        this.phase = 'purge-processed';
        return 0;
      case 'purge-processed':
        if (changed > 0) {
          this.logger.log({ processed: changed }, 'old processed event ids purged');
        }
        this.phase = 'redact';
        this.nextCycleAt = performance.now() + this.options.purgeIntervalMs;
        return this.options.purgeIntervalMs;
    }
  }
  // #endregion
}
