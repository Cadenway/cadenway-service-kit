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

/** Whether lifecycle allows a new publication or settlement of an in-flight publication. */
export type RelayState = 'open' | 'stopping' | 'abandoned';

type AttemptKind = 'published' | 'failed' | 'interrupted' | 'already-redacted';

interface AttemptResult {
  // #region Properties
  /** Outcome category used for metrics and pass results. */
  readonly kind: AttemptKind;

  /** Fenced database update associated with this attempt. */
  readonly outcome: LeaseOutcome;
  // #endregion
}

const meter = metrics.getMeter('@cadenway/nest-messaging');
const databaseDuration = meter.createHistogram('cadenway.outbox.lease.database.duration', {
  unit: 'ms',
  description: 'Elapsed database time for committing a lease operation, including pool wait.',
});
const queueAge = meter.createHistogram('cadenway.outbox.lease.queue.age', {
  unit: 'ms',
  description: 'Age of an outbox event when a relay reserves it.',
});
const publishDuration = meter.createHistogram('cadenway.outbox.lease.publish.duration', {
  unit: 'ms',
  description: 'Elapsed time to publish one outbox event to JetStream.',
});
const attempts = meter.createCounter('cadenway.outbox.lease.attempts', {
  description: 'Outcomes of leased outbox attempts, including stale settlements.',
});

/** Runs one bounded batch, with broker operations outside the database transactions. */
export class LeasedBatchPublisher {
  // #region Properties
  /** Logs exhausted row-specific publication attempts. */
  private readonly logger = new Logger(LeasedBatchPublisher.name);
  // #endregion

  // #region Constructor
  /** Uses the persisted subject and stream for publication and configured restricted-row redaction. */
  public constructor(
    private readonly system: SystemTransactionRunner<DatabaseSchema>,
    private readonly publisher: EventPublisher,
    private readonly concurrency: number,
    private readonly leaseMs: number,
    private readonly restricted: RestrictedNames,
  ) {}
  // #endregion

  // #region Methods
  /** Reserves, publishes and settles at most the replica's configured available slots. */
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
