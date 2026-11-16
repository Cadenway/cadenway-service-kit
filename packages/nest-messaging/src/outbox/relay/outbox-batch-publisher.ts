import type {
  DatabaseSchema,
  SystemTransactionRunner,
  TransactionScope,
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

// Once the rows are selected, leave at most this much time to start publishes under their locks.
const PUBLICATION_BATCH_BUDGET_MS: number = 5000;
const WARNING_INTERVAL_MS: number = 60_000;

/** Outcome of a committed pass, with the scheduling hint kept separate from the public result. */
export interface RelayBatch {
  // #region Properties
  /** Result returned to callers of the manual relay. */
  readonly result: RelayPass;
  readonly pendingWork: boolean;
  // #endregion
}

interface WarningState {
  // #region Properties
  /** Monotonic time of the last warning, in milliseconds. */
  readonly lastAt: number;
  suppressed: number;
  // #endregion
}

/** Publishes one batch under system transaction locks and persists acknowledgements atomically. */
export class OutboxBatchPublisher {
  // #region Properties
  /** Logs routing and error metadata without the payload. */
  private readonly logger: Logger = new Logger('OutboxRelay');
  private readonly warnings = new Map<string, WarningState>();
  private readonly transactionEntryDuration: Histogram;
  private readonly transactionDuration: Histogram;
  // #endregion

  // #region Constructor
  /** Binds the relay options and records transaction timing on the process' meter. */
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
  /** Publishes due rows and returns after commit, or propagates the transaction failure. */
  public async run(): Promise<RelayBatch> {
    const startedAt: number = performance.now();
    let enteredAt: number | undefined;
    try {
      return await this.system.run((tx: TransactionScope<DatabaseSchema>) => {
        enteredAt = performance.now();
        return this.publishLockedRows(tx);
      });
    } finally {
      if (enteredAt !== undefined) {
        this.transactionEntryDuration.record(enteredAt - startedAt);
        this.transactionDuration.record(performance.now() - enteredAt);
      }
    }
  }

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
