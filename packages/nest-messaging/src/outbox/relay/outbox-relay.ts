import { SystemTransactionRunner, type DatabaseSchema } from '@cadenway/nest-common/database';
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import {
  DEFAULT_RESTRICTED_STREAM,
  DEFAULT_RESTRICTED_SUBJECT_PREFIX,
} from '../../configuration/messaging-defaults.js';
import {
  MESSAGING_OPTIONS,
  type ResolvedMessagingOptions,
} from '../../configuration/messaging-options.js';
import { EventPublisher } from '../../publisher/event-publisher.js';
import { OutboxMaintenanceRunner } from '../maintenance/outbox-maintenance-runner.js';
import type { RestrictedNames } from '../maintenance/outbox-redaction.js';
import { OUTBOX_OPTIONS, type ResolvedOutboxOptions } from '../wiring/outbox-options.js';
import { OutboxBatchPublisher, type RelayBatch } from './outbox-batch-publisher.js';
import { passBackoffMs } from './outbox-retry-policy.js';
import type { RelayPass } from './relay-pass.js';

export type { RelayPass } from './relay-pass.js';

/**
 * Schedules publication of committed outbox rows and retention work. Replicas skip each other's
 * locked rows. If a commit fails after JetStream has acknowledged a publish, the row stays
 * pending and is published with the same event id on the next pass.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, BeforeApplicationShutdown {
  // #region Properties
  /** Logs failures of the scheduled publication loop. */
  private readonly logger: Logger = new Logger('OutboxRelay');
  private readonly batch: OutboxBatchPublisher;
  private readonly maintenance: OutboxMaintenanceRunner;

  private started: boolean = false;
  private timer: NodeJS.Timeout | undefined;
  private pass: Promise<void> | undefined;
  private woken: boolean = false;
  private failedPasses: number = 0;
  // #endregion

  // #region Constructor
  /**
   * Uses the system transaction runner. Without messaging options, the default stream and
   * subject prefix identify restricted rows.
   */
  public constructor(
    system: SystemTransactionRunner<DatabaseSchema>,
    publisher: EventPublisher,
    @Inject(OUTBOX_OPTIONS) private readonly options: ResolvedOutboxOptions,
    @Optional() @Inject(MESSAGING_OPTIONS) messaging?: ResolvedMessagingOptions,
  ) {
    const restricted: RestrictedNames = {
      restrictedStream: messaging?.restrictedStream ?? DEFAULT_RESTRICTED_STREAM,
      restrictedSubjectPrefix:
        messaging?.restrictedSubjectPrefix ?? DEFAULT_RESTRICTED_SUBJECT_PREFIX,
    };
    this.batch = new OutboxBatchPublisher(system, publisher, options.batchSize, restricted);
    this.maintenance = new OutboxMaintenanceRunner(system, options, restricted);
  }
  // #endregion

  // #region Methods
  /** Starts polling unless automatic publication is disabled for this process. */
  public onApplicationBootstrap(): void {
    if (!this.options.relay) {
      return;
    }
    this.started = true;
    this.schedule(0);
    this.maintenance.start();
  }

  /** Stops polling and waits for the scheduled pass in progress before resources close. */
  public async beforeApplicationShutdown(): Promise<void> {
    this.started = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    await Promise.all([this.pass, this.maintenance.stop()]);
  }

  /** Asks for a pass after a use case commits, while the relay is running outside backoff. */
  public wake(): void {
    if (!this.started || this.failedPasses > 0) {
      return;
    }
    if (this.timer === undefined) {
      this.woken = true;
      return;
    }
    clearTimeout(this.timer);
    this.schedule(0);
  }

  /**
   * Publishes and settles up to one batch of due rows within the publication budget. It can be
   * called while automatic publication is disabled. A transaction failure rejects the pass and
   * leaves the rows pending.
   */
  public async publishPending(): Promise<RelayPass> {
    const batch: RelayBatch = await this.batch.run();
    return batch.result;
  }

  private schedule(delayMs: number): void {
    if (!this.started) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pass = this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    let batch: RelayBatch | undefined;
    try {
      batch = await this.batch.run();
    } catch (error) {
      this.logger.error({ err: error }, 'outbox relay pass failed');
    }
    this.failedPasses = batch === undefined || batch.result.interrupted ? this.failedPasses + 1 : 0;
    const again: boolean = this.failedPasses === 0 && (this.woken || batch?.pendingWork === true);
    this.woken = false;
    this.pass = undefined;
    this.schedule(again ? 0 : passBackoffMs(this.options.pollIntervalMs, this.failedPasses));
  }
  // #endregion
}
