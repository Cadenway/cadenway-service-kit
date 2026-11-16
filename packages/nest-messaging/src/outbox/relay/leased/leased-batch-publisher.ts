import type { DatabaseSchema, SystemTransactionRunner } from '@cadenway/nest-common/database';
import { Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';

import { errorClassOf } from '../../../observability/error-class.js';
import type { EventPublisher } from '../../../publisher/event-publisher.js';
import {
  isRedactedPayload,
  isRestrictedRoute,
  type RestrictedNames,
} from '../../maintenance/outbox-redaction.js';
import type { RelayBatch } from '../outbox-batch-publisher.js';
import { nextOutboxAttempt, rowBackoffMs, stopsPass } from '../outbox-retry-policy.js';
import {
  claimOutboxRows,
  settleOutboxLeases,
  type LeasedRow,
  type LeaseOutcome,
} from './outbox-lease-store.js';

/**
 * Type RelayState
 *
 * @description
 * Whether lifecycle allows a new publication or settlement of an in-flight publication.
 *
 * @type {'open' | 'stopping' | 'abandoned'}
 */
export type RelayState = 'open' | 'stopping' | 'abandoned';

/**
 * Type AttemptKind
 *
 * @description
 * Publication outcome recorded by metrics and translated to a fenced database update.
 *
 * @type {'published' | 'failed' | 'interrupted' | 'already-redacted'}
 */
type AttemptKind = 'published' | 'failed' | 'interrupted' | 'already-redacted';

/**
 * Interface AttemptResult
 *
 * @description
 * Pairs one broker attempt’s outcome with the database state to apply if the lease is still held.
 */
interface AttemptResult {
  // #region Properties
  /**
   * Property kind
   *
   * @description
   * Outcome category used for metrics and pass results.
   *
   * @type {AttemptKind}
   * @readonly
   */
  readonly kind: AttemptKind;

  /**
   * Property outcome
   *
   * @description
   * Fenced database update associated with this attempt.
   *
   * @type {LeaseOutcome}
   * @readonly
   */
  readonly outcome: LeaseOutcome;
  // #endregion
}

/**
 * Constant meter
 *
 * @description
 * Outbox telemetry meter shared by the lease publisher’s instruments.
 *
 * @type {ReturnType<typeof metrics.getMeter>}
 */
const meter = metrics.getMeter('@cadenway/nest-messaging');
/**
 * Constant databaseDuration
 *
 * @description
 * Histogram of claim and settlement transaction duration, including pool wait, in milliseconds.
 *
 * @type {import('@opentelemetry/api').Histogram}
 */
const databaseDuration = meter.createHistogram('cadenway.outbox.lease.database.duration', {
  unit: 'ms',
  description: 'Elapsed database time for committing a lease operation, including pool wait.',
});
/**
 * Constant queueAge
 *
 * @description
 * Histogram of outbox row age when reserved, in milliseconds.
 *
 * @type {import('@opentelemetry/api').Histogram}
 */
const queueAge = meter.createHistogram('cadenway.outbox.lease.queue.age', {
  unit: 'ms',
  description: 'Age of an outbox event when a relay reserves it.',
});
/**
 * Constant publishDuration
 *
 * @description
 * Histogram of the time spent awaiting JetStream publication acknowledgement, in milliseconds.
 *
 * @type {import('@opentelemetry/api').Histogram}
 */
const publishDuration = meter.createHistogram('cadenway.outbox.lease.publish.duration', {
  unit: 'ms',
  description: 'Elapsed time to publish one outbox event to JetStream.',
});
/**
 * Constant attempts
 *
 * @description
 * Count of leased publication outcomes, including updates rejected after a lease became stale.
 *
 * @type {import('@opentelemetry/api').Counter}
 */
const attempts = meter.createCounter('cadenway.outbox.lease.attempts', {
  description: 'Outcomes of leased outbox attempts, including stale settlements.',
});

/**
 * Class LeasedBatchPublisher
 *
 * @description
 * Runs one bounded batch, with broker operations outside the database transactions.
 */
export class LeasedBatchPublisher {
  // #region Properties
  /**
   * Property logger
   *
   * @description
   * Logs exhausted row-specific publication attempts.
   *
   * @type {Logger}
   * @readonly
   */
  private readonly logger = new Logger(LeasedBatchPublisher.name);
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Uses the persisted subject and stream for publication and configured restricted-row redaction.
   *
   * @param {SystemTransactionRunner<DatabaseSchema>} system - Runs independent claim and settlement transactions.
   * @param {EventPublisher} publisher - Publishes between those transactions and waits for JetStream acknowledgement.
   * @param {number} concurrency - Maximum rows to claim and publish concurrently per pass.
   * @param {number} leaseMs - Lease duration from reservation, in milliseconds.
   * @param {RestrictedNames} restricted - Persisted route rules for identifying restricted rows.
   * @constructor
   */
  public constructor(
    private readonly system: SystemTransactionRunner<DatabaseSchema>,
    private readonly publisher: EventPublisher,
    private readonly concurrency: number,
    private readonly leaseMs: number,
    private readonly restricted: RestrictedNames,
  ) {}
  // #endregion

  // #region Methods
  /**
   * Method run
   *
   * @description
   * Reserves, publishes and settles at most the replica's configured available slots.
   *
   * @param {() => RelayState} state - Reads current lifecycle permissions for admission and settlement.
   * @returns {Promise<RelayBatch>} Settled attempt counts and whether another batch may be available.
   */
  public async run(state: () => RelayState): Promise<RelayBatch> {
    const empty: RelayBatch = {
      result: { published: 0, failed: 0, interrupted: false },
      pendingWork: false,
    };
    if (state() !== 'open') {
      return empty;
    }
    const claimedAt: number = performance.now();
    const rows: readonly LeasedRow[] = await this.system
      .run((tx) =>
        state() === 'open'
          ? claimOutboxRows(tx.client, this.concurrency, this.leaseMs)
          : Promise.resolve([]),
      )
      .finally(() => {
        databaseDuration.record(performance.now() - claimedAt, { operation: 'claim' });
      });
    if (rows.length === 0 || state() !== 'open') {
      return empty;
    }

    for (const row of rows) {
      queueAge.record(Math.max(0, row.queued_ms));
    }
    const results: AttemptResult[] = await Promise.all(rows.map((row) => this.publish(row)));
    const interrupted: boolean = results.some((result) => result.kind === 'interrupted');
    if (state() === 'abandoned') {
      return empty;
    }

    const settlingAt: number = performance.now();
    const committed: ReadonlySet<string> = await this.system
      .run((tx) =>
        state() === 'abandoned'
          ? Promise.resolve(new Set<string>())
          : settleOutboxLeases(
              tx.client,
              results.map(({ outcome }) => outcome),
            ),
      )
      .finally(() => {
        databaseDuration.record(performance.now() - settlingAt, { operation: 'settle' });
      });
    let published: number = 0;
    let failed: number = 0;
    for (const result of results) {
      const applied: boolean = committed.has(result.outcome.id);
      attempts.add(1, { outcome: applied ? result.kind : 'stale' });
      if (!applied) {
        continue;
      }
      if (result.kind === 'published') {
        published += 1;
        continue;
      }
      if (result.kind === 'failed') {
        failed += 1;
        if (result.outcome.status === 'failed') {
          this.logger.error(
            { eventId: result.outcome.id, errorClass: result.outcome.last_error },
            'outbox event failed too many times: parked until requeueOutboxEvents',
          );
        }
      }
    }
    return {
      result: { published, failed, interrupted },
      pendingWork: rows.length === this.concurrency,
    };
  }

  /**
   * Method publish
   *
   * @description
   * Publishes one reserved row or converts its failure into retry state without writing to PostgreSQL.
   *
   * @param {LeasedRow} row - Claimed row whose lease token will fence later settlement.
   * @returns {Promise<AttemptResult>} Publication outcome and lease-fenced state to persist.
   */
  private async publish(row: LeasedRow): Promise<AttemptResult> {
    const outcome: LeaseOutcome = {
      id: row.id,
      lease_token: row.lease_token,
      status: 'sent',
      attempts: row.attempts,
      retry_ms: 0,
      last_error: null,
      redact: false,
    };
    if (isRedactedPayload(row.payload)) {
      return { kind: 'already-redacted', outcome };
    }
    const redact: boolean = isRestrictedRoute(this.restricted, row);
    const startedAt: number = performance.now();
    try {
      await this.publisher.publishEnvelope({
        name: row.event_name,
        subject: row.subject,
        stream: row.stream,
        payload: row.payload,
        traceparent: row.traceparent,
      });
      return { kind: 'published', outcome: { ...outcome, redact } };
    } catch (error) {
      const last_error: string = errorClassOf(error);
      if (stopsPass(error)) {
        return {
          kind: 'interrupted',
          outcome: { ...outcome, status: 'pending', last_error, retry_ms: rowBackoffMs(1) },
        };
      }
      const previous = nextOutboxAttempt(row.attempts);
      return {
        kind: 'failed',
        outcome: {
          ...outcome,
          status: previous.parked ? 'failed' : 'pending',
          attempts: previous.attempts,
          retry_ms: previous.delayMs,
          last_error,
        },
      };
    } finally {
      publishDuration.record(performance.now() - startedAt);
    }
  }
  // #endregion
}
