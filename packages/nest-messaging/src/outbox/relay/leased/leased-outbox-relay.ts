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

/** Dependency injection token for the lease-based relay configuration. */
export const LEASED_OUTBOX_OPTIONS: unique symbol = Symbol('cadenway.messaging.leased-outbox');

/** Relays committed outbox events without holding database connections during broker waits. */
@Injectable()
export class LeasedOutboxRelay implements OnApplicationBootstrap, BeforeApplicationShutdown {
  // #region Properties
  /** Logs lifecycle and temporary infrastructure failures. */
  private readonly logger = new Logger(LeasedOutboxRelay.name);
  private readonly batch: LeasedBatchPublisher;
  private readonly maintenance: OutboxMaintenanceRunner;
  private state: RelayState = 'open';
  private timer: NodeJS.Timeout | undefined;
  private activeBatch: Promise<RelayBatch> | undefined;
  private failedPasses: number = 0;
  // #endregion

  // #region Constructor
  /** Shares the runtime publisher and uses its timeout to size the lease. */
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
  /** Requires the service-owned additive migration before starting the background relay. */
  public async onApplicationBootstrap(): Promise<void> {
    if (!this.options.autoStart) {
      return;
    }
    const migrated: boolean = await this.system.run((tx) => hasOutboxLeaseSchema(tx.client));
    if (!migrated) {
      throw new Error('Apply the service outbox lease migration before enabling the relay.');
    }
    if (this.state === 'open') {
      this.schedule(0);
      this.maintenance.start();
    }
  }

  /** Stops taking reservations and gives the current pass its shutdown grace to finish. */
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

  /** Publishes and settles one pass, including when automatic polling is disabled. */
  public async publishPending(): Promise<RelayPass> {
    if (this.state !== 'open') {
      throw new Error('The outbox relay is shutting down.');
    }
    assertNoActiveTransaction();
    return (await this.runBatch()).result;
  }

  private runBatch(): Promise<RelayBatch> {
    this.activeBatch ??= this.batch
      .run(() => this.state)
      .finally(() => {
        this.activeBatch = undefined;
      });
    return this.activeBatch;
  }

  private schedule(delayMs: number): void {
    if (this.state !== 'open') {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, delayMs);
  }

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
