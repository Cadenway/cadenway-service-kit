import {
  SystemTransactionRunner,
  assertNoActiveTransaction,
  type DatabaseSchema,
} from '@cadenway/nest-common/database';
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import {
  DEFAULT_PUBLISH_TIMEOUT_MS,
  DEFAULT_RESTRICTED_STREAM,
  DEFAULT_RESTRICTED_SUBJECT_PREFIX,
} from '../../../configuration/messaging-defaults.js';
import {
  MESSAGING_OPTIONS,
  type ResolvedMessagingOptions,
} from '../../../configuration/messaging-options.js';
import { errorClassOf } from '../../../observability/error-class.js';
import { EventPublisher } from '../../../publisher/event-publisher.js';
import { OutboxMaintenanceRunner } from '../../maintenance/outbox-maintenance-runner.js';
import type { RestrictedNames } from '../../maintenance/outbox-redaction.js';
import type { RelayBatch } from '../outbox-batch-publisher.js';
import { passBackoffMs } from '../outbox-retry-policy.js';
import type { RelayPass } from '../relay-pass.js';
import { LeasedBatchPublisher, type RelayState } from './leased-batch-publisher.js';
import { hasOutboxLeaseSchema } from './outbox-lease-store.js';
import type { ResolvedOutboxRelayOptions } from './outbox-relay-options.js';

/**
 * Constant LEASED_OUTBOX_OPTIONS
 *
 * @description
 * Dependency injection token for the lease-based relay configuration.
 *
 * @type {unique symbol}
 */
export const LEASED_OUTBOX_OPTIONS: unique symbol = Symbol('cadenway.messaging.leased-outbox');

/**
 * Class LeasedOutboxRelay
 *
 * @description
 * Relays committed outbox events without holding database connections during broker waits.
 */
@Injectable()
export class LeasedOutboxRelay implements OnApplicationBootstrap, BeforeApplicationShutdown {
  // #region Properties
  /**
   * Property logger
   *
   * @description
   * Logs lifecycle and temporary infrastructure failures.
   *
   * @type {Logger}
   * @readonly
   */
  private readonly logger = new Logger(LeasedOutboxRelay.name);

  /**
   * Property batch
   *
   * @description
   * Publisher that keeps broker acknowledgement outside the claim and settlement transactions.
   *
   * @type {LeasedBatchPublisher}
   * @readonly
   */
  private readonly batch: LeasedBatchPublisher;

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
   * Property state
   *
   * @description
   * Current admission and settlement permissions during shutdown.
   *
   * @type {RelayState}
   */
  private state: RelayState = 'open';

  /**
   * Property timer
   *
   * @description
   * Next polling wake-up, canceled when shutdown starts.
   *
   * @type {NodeJS.Timeout | undefined}
   */
  private timer: NodeJS.Timeout | undefined;

  /**
   * Property activeBatch
   *
   * @description
   * In-flight batch shared by callers until its publication and settlement finish.
   *
   * @type {Promise<RelayBatch> | undefined}
   */
  private activeBatch: Promise<RelayBatch> | undefined;

  /**
   * Property failedPasses
   *
   * @description
   * Consecutive relay-wide failures used to calculate the next polling delay.
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
   * Shares the runtime publisher and uses its timeout to size the lease.
   *
   * @param {SystemTransactionRunner<DatabaseSchema>} system - Runs claim, settlement and maintenance transactions.
   * @param {EventPublisher} publisher - Publishes using the route stored by the writer.
   * @param {ResolvedOutboxRelayOptions} options - Resolved lease, polling, retention and shutdown configuration.
   * @param {ResolvedMessagingOptions | undefined} messaging - Messaging configuration supplying the publish timeout and restricted route names.
   * @constructor
   */
  public constructor(
    private readonly system: SystemTransactionRunner<DatabaseSchema>,
    publisher: EventPublisher,
    @Inject(LEASED_OUTBOX_OPTIONS) private readonly options: ResolvedOutboxRelayOptions,
    @Optional() @Inject(MESSAGING_OPTIONS) messaging?: ResolvedMessagingOptions,
  ) {
    const restricted: RestrictedNames = {
      restrictedStream: messaging?.restrictedStream ?? DEFAULT_RESTRICTED_STREAM,
      restrictedSubjectPrefix:
        messaging?.restrictedSubjectPrefix ?? DEFAULT_RESTRICTED_SUBJECT_PREFIX,
    };
    const leaseMs: number = Math.max(
      30_000,
      options.leaseMs,
      2 * (messaging?.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS),
    );
    this.batch = new LeasedBatchPublisher(
      system,
      publisher,
      options.concurrency,
      leaseMs,
      restricted,
    );
    this.maintenance = new OutboxMaintenanceRunner(system, options, restricted);
  }
  // #endregion

  // #region Methods
  /**
   * Method onApplicationBootstrap
   *
   * @description
   * Requires both validated lease checks and the expected expiry index before polling.
   *
   * @returns {Promise<void>} Resolves once checks have completed and polling is scheduled when enabled.
   */
  public async onApplicationBootstrap(): Promise<void> {
    if (!this.options.autoStart) {
      return;
    }
    const migrated: boolean = await this.system.run((tx) => hasOutboxLeaseSchema(tx.client));
    if (!migrated) {
      throw new Error(
        'Apply the service outbox lease migration before enabling the relay. Both checks and the expiry index must be valid and the index must match the expected definition.',
      );
    }
    if (this.state === 'open') {
      this.schedule(0);
      this.maintenance.start();
    }
  }

  /**
   * Method beforeApplicationShutdown
   *
   * @description
   * Stops taking reservations and gives the current pass its shutdown grace to finish.
   *
   * @returns {Promise<void>} Resolves when active work settles or the shutdown grace expires.
   */
  public async beforeApplicationShutdown(): Promise<void> {
    if (this.state !== 'open') {
      return;
    }
    this.state = 'stopping';
    clearTimeout(this.timer);
    this.timer = undefined;
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled([this.activeBatch, this.maintenance.stop()]),
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            this.state = 'abandoned';
            this.logger.warn('Outbox shutdown grace elapsed; unsettled leases will expire.');
            resolve();
          }, this.options.shutdownTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Method publishPending
   *
   * @description
   * Publishes and settles one pass with the migrated schema, even without automatic polling.
   * Callers in the same process share a pass until it settles.
   *
   * @returns {Promise<RelayPass>} Shared pass outcome after the current batch settles.
   * @throws When shutdown has started or the caller holds an active database transaction.
   */
  public async publishPending(): Promise<RelayPass> {
    if (this.state !== 'open') {
      throw new Error('The outbox relay is shutting down.');
    }
    assertNoActiveTransaction();
    return (await this.runBatch()).result;
  }

  /**
   * Method runBatch
   *
   * @description
   * Starts a batch only when no concurrent caller is already running one in this process.
   *
   * @returns {Promise<RelayBatch>} Shared promise for the current or newly created batch.
   */
  private runBatch(): Promise<RelayBatch> {
    this.activeBatch ??= this.batch
      .run(() => this.state)
      .finally(() => {
        this.activeBatch = undefined;
      });
    return this.activeBatch;
  }

  /**
   * Method schedule
   *
   * @description
   * Schedules the next poll only while admission remains open.
   *
   * @param {number} delayMs - Milliseconds before the next automatic pass.
   */
  private schedule(delayMs: number): void {
    if (this.state !== 'open') {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, delayMs);
  }

  /**
   * Method tick
   *
   * @description
   * Runs a shared batch and chooses the next polling interval from its outcome.
   *
   * @returns {Promise<void>} Resolves after recording the outcome and scheduling the next permitted poll.
   */
  private async tick(): Promise<void> {
    let batch: RelayBatch | undefined;
    try {
      batch = await this.runBatch();
    } catch (error) {
      this.logger.error({ errorClass: errorClassOf(error) }, 'leased outbox pass failed');
    }
    if (batch?.result.interrupted && this.failedPasses === 0) {
      this.logger.warn('The leased outbox relay lost JetStream availability and will back off.');
    }
    this.failedPasses = batch === undefined || batch.result.interrupted ? this.failedPasses + 1 : 0;
    this.schedule(
      this.failedPasses === 0 && batch?.pendingWork
        ? 0
        : passBackoffMs(this.options.pollIntervalMs, this.failedPasses),
    );
  }
  // #endregion
}
