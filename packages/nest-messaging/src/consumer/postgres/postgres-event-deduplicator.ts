import {
  SystemTransactionRunner,
  TenantTransactionRunner,
  type DatabaseSchema,
  type TransactionScope,
} from '@cadenway/nest-common/database';
import { Inject, Injectable } from '@nestjs/common';

import type {
  DeduplicationOutcome,
  EventDeduplicator,
  EventDelivery,
  VersionClaim,
} from '../delivery/event-deduplicator.js';
import {
  MESSAGING_OPTIONS,
  type ResolvedMessagingOptions,
} from '../../configuration/messaging-options.js';
import { MESSAGING_TUNING, type MessagingTuning } from '../../configuration/messaging-tuning.js';

/**
 * Class PostgresEventDeduplicator
 *
 * @description
 * Deduplicator backed by the `processed_events` and `event_versions` tables of the service.
 * `PostgresEventDeduplicationModule` registers it as the `EventDeduplicator` of the application.
 *
 * For each delivery it opens one transaction: with the tenant runner, for the organization of
 * the validated envelope, when the event carries one; with the system runner otherwise. It
 * records the event id for the consumer with `on conflict do nothing`; when the id was already
 * there the handler is skipped. Otherwise the handler runs inside that same transaction: a
 * `run` of the same runner in the handler joins it, so the writes of the handler, the processed
 * id and the version claims commit together or not at all. The message is acknowledged after the
 * commit. A handler that fails or is abandoned before commit rolls back its writes and claims.
 * A redelivery after commit but before acknowledgement skips the handler.
 *
 * Two deliveries of the same event handled at the same time meet on the primary key: the second
 * waits for the first transaction for at most five seconds (`lock_timeout`), then fails and is
 * retried after the next delay, when it sees the id of the first and skips the handler.
 */
@Injectable()
export class PostgresEventDeduplicator implements EventDeduplicator {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Stores the two transaction runners of the service and the timings of the kit.
   *
   * @param {TenantTransactionRunner<DatabaseSchema>} tenant - Tenant transaction runner.
   * @param {SystemTransactionRunner<DatabaseSchema>} system - System transaction runner.
   * @param {MessagingTuning} tuning - Lock timeout of the claim of a processed id.
   * @param {ResolvedMessagingOptions} messaging - Options of `MessagingModule`, for the handler deadline.
   * @constructor
   */
  public constructor(
    private readonly tenant: TenantTransactionRunner<DatabaseSchema>,
    private readonly system: SystemTransactionRunner<DatabaseSchema>,
    @Inject(MESSAGING_TUNING) private readonly tuning: MessagingTuning,
    @Inject(MESSAGING_OPTIONS) private readonly messaging: ResolvedMessagingOptions,
  ) {}
  // #endregion

  // #region Methods
  /**
   * Method run
   *
   * @description
   * Runs the handler in a transaction unless this consumer already processed the event. It must
   * be called inside the organization context of the event, as the consumers do.
   *
   * @param {EventDelivery} delivery - Consumer, event name and validated envelope.
   * @param {(claimVersion: VersionClaim) => Promise<void>} handle - Calls the handler with the version claim of this delivery.
   * @returns {Promise<DeduplicationOutcome>} `handled` once the transaction committed, `duplicate` when the handler was skipped.
   * @throws {Error} When the handler rejects, the processed id stays locked by another delivery past the lock timeout, or the transaction fails; nothing is recorded.
   */
  public async run(
    delivery: EventDelivery,
    handle: (claimVersion: VersionClaim) => Promise<void>,
  ): Promise<DeduplicationOutcome> {
    const work: (tx: TransactionScope<DatabaseSchema>) => Promise<DeduplicationOutcome> = async (
      tx: TransactionScope<DatabaseSchema>,
    ): Promise<DeduplicationOutcome> => {
      // The claim waits a bounded time for a delivery of the same event still in progress; the
      // handler then runs with the default lock timeout of the service. No statement may outlive
      // the deadline of the handler, so the rollback of an abandoned attempt is not held up.
      await tx.client.query(
        "select set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)",
        [
          `${String(this.tuning.claimLockTimeoutMs)}ms`,
          `${String(this.messaging.handlerTimeoutMs)}ms`,
        ],
      );
      const recorded: { rows: unknown[] } = await tx.client.query(
        `insert into processed_events (consumer, event_id)
         values ($1, $2)
         on conflict do nothing
         returning event_id`,
        [delivery.consumer, delivery.envelope.id],
      );
      await tx.client.query('set local lock_timeout to default');
      if (recorded.rows.length === 0) {
        return 'duplicate';
      }
      await handle((aggregateKey: string) => this.claimVersion(tx, delivery, aggregateKey));
      return 'handled';
    };
    return delivery.envelope.organizationId === null
      ? this.system.run(work)
      : this.tenant.run(work);
  }

  /**
   * Method claimVersion
   *
   * @description
   * Records the version of the event for an aggregate of its organization when it is higher than
   * the one this consumer already applied, inside the transaction of the handler.
   *
   * @param {TransactionScope<DatabaseSchema>} tx - Transaction of the delivery.
   * @param {EventDelivery} delivery - Consumer and envelope of the event.
   * @param {string} aggregateKey - Key the handler chose for the aggregate, such as `task:<id>`.
   * @returns {Promise<boolean>} `true` when the event is newer and should be applied, `false` when an equal or higher version was applied before.
   */
  private async claimVersion(
    tx: TransactionScope<DatabaseSchema>,
    delivery: EventDelivery,
    aggregateKey: string,
  ): Promise<boolean> {
    const claimed: { rows: unknown[] } = await tx.client.query(
      `insert into event_versions (consumer, organization_id, aggregate_key, version)
       values ($1, $2, $3, $4)
       on conflict on constraint event_versions_aggregate_unique do update
         set version = excluded.version, updated_at = now()
         where event_versions.version < excluded.version
       returning version`,
      [
        delivery.consumer,
        delivery.envelope.organizationId,
        aggregateKey,
        delivery.envelope.version,
      ],
    );
    return claimed.rows.length === 1;
  }
  // #endregion
}
