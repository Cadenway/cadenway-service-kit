import {
  assertNoActiveTransaction,
  type DatabaseSchema,
  type SystemTransactionRunner,
  type TransactionScope,
} from '@cadenway/nest-common/database';
import { Logger } from '@nestjs/common';
import { metrics, type Histogram, type Meter } from '@opentelemetry/api';

import { errorClassOf } from '../../observability/error-class.js';
import type { EventPublisher } from '../../publisher/event-publisher.js';
import {
  isRedactedPayload,
  isRestrictedRoute,
  type RestrictedNames,
} from '../maintenance/outbox-redaction.js';
import {
  lockPendingRows,
  recordOutboxFailure,
  recordOutboxInterruption,
  settleOutboxRows,
  type PendingRow,
} from './outbox-relay-store.js';
import { nextOutboxAttempt, stopsPass, type FailedOutboxAttempt } from './outbox-retry-policy.js';
import type { RelayPass } from './relay-pass.js';

/**
 * Constant PUBLICATION_BATCH_BUDGET_MS
 *
 * @description
 * Maximum time to start further publishes after locking one batch, in milliseconds. An in-flight publish still has its own timeout.
 *
 * @type {number}
 */
const PUBLICATION_BATCH_BUDGET_MS: number = 5000;
/**
 * Constant WARNING_INTERVAL_MS
 *
 * @description
 * Minimum interval between logged failures of the same class, in milliseconds.
 *
 * @type {number}
 */
const WARNING_INTERVAL_MS: number = 60_000;

/**
 * Interface RelayBatch
 *
 * @description
 * Outcome of a committed pass, with the scheduling hint kept separate from the public result.
 */
export interface RelayBatch {
  // #region Properties
  /**
   * Property result
   *
   * @description
   * Result returned to callers of the manual relay.
   *
   * @type {RelayPass}
   * @readonly
   */
  readonly result: RelayPass;

  /**
   * Property pendingWork
   *
   * @description
   * Whether the relay should check immediately for more due rows.
   *
   * @type {boolean}
   * @readonly
   */
  readonly pendingWork: boolean;
  // #endregion
}

/**
 * Interface WarningState
 *
 * @description
 * Rate-limit state remembered independently for each publication error class.
 */
interface WarningState {
  // #region Properties
  /**
   * Property lastAt
   *
   * @description
   * Monotonic time of the last warning, in milliseconds.
   *
   * @type {number}
   * @readonly
   */
  readonly lastAt: number;

  /**
   * Property suppressed
   *
   * @description
   * Failures omitted since the last warning of this class.
   *
   * @type {number}
   */
  suppressed: number;
  // #endregion
}

/**
 * Class OutboxBatchPublisher
 *
 * @description
 * Publishes one batch under system transaction locks and persists acknowledgements atomically.
 */
export class OutboxBatchPublisher {
  // #region Properties
  /**
   * Property logger
   *
   * @description
   * Logs routing and error metadata without the payload.
   *
   * @type {Logger}
   * @readonly
   */
  private readonly logger: Logger = new Logger('OutboxRelay');

  /**
   * Property warnings
   *
   * @description
   * Last warning and suppressed count per publication error class.
   *
   * @type {Map<string, WarningState>}
   * @readonly
   */
  private readonly warnings = new Map<string, WarningState>();

  /**
   * Property transactionEntryDuration
   *
   * @description
   * Histogram measuring elapsed time before the system transaction is entered, in milliseconds.
   *
   * @type {Histogram}
   * @readonly
   */
  private readonly transactionEntryDuration: Histogram;

  /**
   * Property transactionDuration
   *
   * @description
   * Histogram measuring time from entry until the transaction settles, in milliseconds.
   *
   * @type {Histogram}
   * @readonly
   */
  private readonly transactionDuration: Histogram;
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Binds the relay options and records transaction timing on the process' meter.
   *
   * @param {SystemTransactionRunner<DatabaseSchema>} system - Opens the transaction protecting the selected rows until settlement.
   * @param {EventPublisher} publisher - Publishes each event and waits for JetStream acknowledgement.
   * @param {number} batchSize - Maximum rows to lock for a pass.
   * @param {RestrictedNames} restricted - Persisted route rules for identifying restricted rows.
   * @constructor
   */
  public constructor(
    private readonly system: SystemTransactionRunner<DatabaseSchema>,
    private readonly publisher: EventPublisher,
    private readonly batchSize: number,
    private readonly restricted: RestrictedNames,
  ) {
    const meter: Meter = metrics.getMeter('@cadenway/nest-messaging');
    this.transactionEntryDuration = meter.createHistogram(
      'cadenway.outbox.relay.transaction.entry.duration',
      { unit: 'ms', description: 'Time to acquire a connection and enter the system transaction.' },
    );
    this.transactionDuration = meter.createHistogram('cadenway.outbox.relay.transaction.duration', {
      unit: 'ms',
      description: 'Time from entering the system transaction through commit or rollback.',
    });
  }
  // #endregion

  // #region Methods
  /**
   * Method run
   *
   * @description
   * Publishes committed rows in an independent transaction and returns after settlement.
   *
   * @returns {Promise<RelayBatch>} Pass result and scheduling hint after the publication transaction commits.
   * @throws {Error} When called inside an active transaction or settlement fails.
   */
  public async run(): Promise<RelayBatch> {
    assertNoActiveTransaction();
    const startedAt: number = performance.now();
    let enteredAt: number | undefined;
    try {
      return await this.system.run(
        (tx: TransactionScope<DatabaseSchema>) => {
          enteredAt = performance.now();
          return this.publishLockedRows(tx);
        },
        { maxAttempts: 1 },
      );
    } finally {
      if (enteredAt !== undefined) {
        this.transactionEntryDuration.record(enteredAt - startedAt);
        this.transactionDuration.record(performance.now() - enteredAt);
      }
    }
  }

  /**
   * Method publishLockedRows
   *
   * @description
   * Publishes only this transaction’s locked rows and records outcomes before releasing their locks.
   *
   * @param {TransactionScope<DatabaseSchema>} tx - System transaction holding the selected row locks until all outcomes settle.
   * @returns {Promise<RelayBatch>} Publication outcomes and indication that some due work may remain.
   */
  private async publishLockedRows(tx: TransactionScope<DatabaseSchema>): Promise<RelayBatch> {
    const rows: readonly PendingRow[] = await lockPendingRows(tx.client, this.batchSize);
    const deadline: number = performance.now() + PUBLICATION_BATCH_BUDGET_MS;
    const sentIds: string[] = [];
    const redactIds: string[] = [];
    const alreadyRedacted: PendingRow[] = [];
    let failed: number = 0;
    let interrupted: boolean = false;
    let pendingWork: boolean = rows.length === this.batchSize;
    for (const row of rows) {
      // A publish in progress still uses the publisher's JetStream timeout. Wait for it and
      // settle its result before releasing any row locks.
      if (performance.now() >= deadline) {
        pendingWork = true;
        break;
      }
      if (isRedactedPayload(row.payload)) {
        alreadyRedacted.push(row);
        continue;
      }
      // Decide before publishing so a fault cannot mark a restricted row sent with its payload.
      const restricted: boolean = isRestrictedRoute(this.restricted, row);
      try {
        await this.publisher.publishEnvelope({
          name: row.event_name,
          subject: row.subject,
          stream: row.stream,
          payload: row.payload,
          traceparent: row.traceparent,
        });
      } catch (error) {
        const errorClass: string = errorClassOf(error);
        if (stopsPass(error)) {
          await recordOutboxInterruption(tx.client, row.id, errorClass);
          this.logger.warn(
            { eventId: row.id, event: row.event_name, errorClass },
            'outbox events cannot be published now: the relay backs off',
          );
          interrupted = true;
          break;
        }
        const attempt: FailedOutboxAttempt = nextOutboxAttempt(row.attempts);
        await recordOutboxFailure(tx.client, row.id, errorClass, attempt);
        this.logFailedAttempt(row, errorClass, attempt);
        failed += 1;
        continue;
      }
      sentIds.push(row.id);
      if (restricted) {
        redactIds.push(row.id);
      }
    }
    const firstRedacted: PendingRow | undefined = alreadyRedacted[0];
    if (firstRedacted !== undefined) {
      this.logger.warn(
        {
          count: alreadyRedacted.length,
          eventId: firstRedacted.id,
          event: firstRedacted.event_name,
        },
        'redacted outbox events found pending: marked sent, not published again',
      );
    }
    await settleOutboxRows(
      tx.client,
      [...sentIds, ...alreadyRedacted.map((row: PendingRow) => row.id)],
      redactIds,
    );
    return { result: { published: sentIds.length, failed, interrupted }, pendingWork };
  }

  /**
   * Method logFailedAttempt
   *
   * @description
   * Reports parked rows as errors and rate-limits warnings for rows that can still be retried.
   *
   * @param {PendingRow} row - Pending row whose broker publication failed.
   * @param {string} errorClass - Safe error class used as the warning rate-limit key.
   * @param {FailedOutboxAttempt} attempt - Updated retry count, delay and parking decision.
   */
  private logFailedAttempt(
    row: PendingRow,
    errorClass: string,
    attempt: FailedOutboxAttempt,
  ): void {
    const fields: { eventId: string; event: string; attempts: number; errorClass: string } = {
      eventId: row.id,
      event: row.event_name,
      attempts: attempt.attempts,
      errorClass,
    };
    if (attempt.parked) {
      this.logger.error(
        fields,
        'outbox event failed too many times: parked until requeueOutboxEvents',
      );
      return;
    }
    const now: number = performance.now();
    const state: WarningState | undefined = this.warnings.get(errorClass);
    if (state !== undefined && now - state.lastAt < WARNING_INTERVAL_MS) {
      state.suppressed += 1;
      return;
    }
    this.warnings.set(errorClass, { lastAt: now, suppressed: 0 });
    this.logger.warn(
      { ...fields, suppressed: state?.suppressed ?? 0 },
      'outbox event could not be published: it stays pending',
    );
  }
  // #endregion
}
