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

/** Intervals and retention settings needed by automatic maintenance. */
type MaintenanceOptions = Pick<
  ResolvedOutboxOptions,
  'pollIntervalMs' | 'purgeIntervalMs' | 'retentionDays' | 'processedRetentionDays'
>;

const MAX_TIMER_DELAY_MS: number = 2_147_483_647;
const MAX_RETRY_DELAY_MS: number = 30_000;

/** Schedules bounded maintenance transactions independently of publication. */
export class OutboxMaintenanceRunner {
  // #region Properties
  /** Logs failures and committed changes of a completed phase. */
  private readonly logger: Logger = new Logger('OutboxMaintenance');

  private started: boolean = false;
  private timer: NodeJS.Timeout | undefined;
  private batch: Promise<void> | undefined;
  private phase: MaintenancePhase = 'redact';
  private changedRows: number = 0;
  private failedBatches: number = 0;
  private nextCycleAt: number = 0;
  // #endregion

  // #region Constructor
  /** Uses system transactions to maintain the service's outbox and processed ids. */
  public constructor(
    private readonly system: SystemTransactionRunner<DatabaseSchema>,
    private readonly options: MaintenanceOptions,
    private readonly restricted: RestrictedNames,
  ) {}
  // #endregion

  // #region Methods
  /** Schedules the initial restricted-payload sweep even when periodic purges are disabled. */
  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.schedule(0);
  }

  /** Cancels future work and waits for the current transaction before the database closes. */
  public async stop(): Promise<void> {
    this.started = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.batch;
  }

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

  /** Runs one transaction, retaining the current phase until all its rows have been handled. */
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
