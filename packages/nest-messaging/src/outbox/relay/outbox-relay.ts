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
 * Class OutboxRelay
 *
 * @description
 * Schedules publication of committed outbox rows and retention work. Replicas skip each other's
 * locked rows. If a commit fails after JetStream has acknowledged a publish, the row stays
 * pending and is published with the same event id on the next pass.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, BeforeApplicationShutdown {
  // #region Properties
  /**
   * Property logger
   *
   * @description
   * Logs failures of the scheduled publication loop.
   *
   * @type {Logger}
   * @readonly
   */
  private readonly logger: Logger = new Logger('OutboxRelay');

  /**
   * Property batch
   *
   * @description
   * Publisher for rows locked in the system transaction.
   *
   * @type {OutboxBatchPublisher}
   * @readonly
   */
  private readonly batch: OutboxBatchPublisher;

  /**
   * Property maintenance
   *
   * @description
   * Independent scheduler for redaction and retention transactions.
   *
   * @type {OutboxMaintenanceRunner}
   * @readonly
   */
  private readonly maintenance: OutboxMaintenanceRunner;

  /**
   * Property manualPasses
   *
   * @description
   * Tracks manual calls separately so each caller keeps its own pass and result.
   *
   * @type {Set<Promise<RelayBatch>>}
   * @readonly
   */
  private readonly manualPasses = new Set<Promise<RelayBatch>>();

  /**
   * Property started
   *
   * @description
   * Whether periodic publication can schedule a new pass.
   *
   * @type {boolean}
   */
  private started: boolean = false;

  /**
   * Property shuttingDown
   *
   * @description
   * Whether manual and scheduled publication admission has closed.
   *
   * @type {boolean}
   */
  private shuttingDown: boolean = false;

  /**
   * Property timer
   *
   * @description
   * Scheduled publication wake-up, canceled on shutdown or an early wake.
   *
   * @type {NodeJS.Timeout | undefined}
   */
  private timer: NodeJS.Timeout | undefined;

  /**
   * Property pass
   *
   * @description
   * Active scheduled pass that shutdown must drain.
   *
   * @type {Promise<void> | undefined}
   */
  private pass: Promise<void> | undefined;

  /**
   * Property woken
   *
   * @description
   * Whether a commit requested another pass while the current pass was running.
   *
   * @type {boolean}
   */
  private woken: boolean = false;

  /**
   * Property failedPasses
   *
   * @description
   * Consecutive broker-wide or transaction failures used for polling backoff.
   *
   * @type {number}
   */
  private failedPasses: number = 0;
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Uses the system transaction runner. Without messaging options, the default stream and
   * subject prefix identify restricted rows.
   *
   * @param {SystemTransactionRunner<DatabaseSchema>} system - Opens the system transaction protecting a batch until settlement.
   * @param {EventPublisher} publisher - Publishes committed events and awaits acknowledgements.
   * @param {ResolvedOutboxOptions} options - Resolved settings for automatic polling, batch size and retention.
   * @param {ResolvedMessagingOptions | undefined} messaging - Messaging configuration supplying restricted stream and prefix names.
   * @constructor
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
  /**
   * Method onApplicationBootstrap
   *
   * @description
   * Starts polling unless automatic publication is disabled for this process.
   */
  public onApplicationBootstrap(): void {
    if (!this.options.relay || this.shuttingDown) {
      return;
    }
    this.started = true;
    this.schedule(0);
    this.maintenance.start();
  }

  /**
   * Method beforeApplicationShutdown
   *
   * @description
   * Closes admission and drains the scheduled pass, manual passes, and maintenance.
   *
   * @returns {Promise<void>} Resolves after all admitted passes and maintenance work settle.
   */
  public async beforeApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    this.started = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    await Promise.allSettled([this.pass, ...this.manualPasses, this.maintenance.stop()]);
  }

  /**
   * Method wake
   *
   * @description
   * Asks for a pass after a use case commits, while the relay is running outside backoff.
   */
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
   * Method publishPending
   *
   * @description
   * Publishes and settles up to one batch of due rows within the publication budget. It can be
   * called while automatic publication is disabled. A transaction failure leaves the rows pending.
   *
   * @returns {Promise<RelayPass>} Outcome of this caller’s independent publication pass.
   * @throws When shutdown has started or the publication transaction fails.
   */
  public async publishPending(): Promise<RelayPass> {
    if (this.shuttingDown) {
      throw new Error('The outbox relay is shutting down.');
    }
    const pass: Promise<RelayBatch> = this.batch.run();
    this.manualPasses.add(pass);
    try {
      return (await pass).result;
    } finally {
      this.manualPasses.delete(pass);
    }
  }

  /**
   * Method schedule
   *
   * @description
   * Schedules a pass only while automatic publication remains active.
   *
   * @param {number} delayMs - Milliseconds before the next publication pass.
   */
  private schedule(delayMs: number): void {
    if (!this.started) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pass = this.tick();
    }, delayMs);
  }

  /**
   * Method tick
   *
   * @description
   * Runs one scheduled pass, updates backoff and arranges the next poll.
   *
   * @returns {Promise<void>} Resolves after the next automatic pass is scheduled, if polling is still active.
   */
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
