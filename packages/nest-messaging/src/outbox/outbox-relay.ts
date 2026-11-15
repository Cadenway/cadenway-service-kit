import {
  SystemTransactionRunner,
  type DatabaseSchema,
  type TransactionScope,
} from '@cadenway/nest-common/database';
import { JetStreamApiError } from '@nats-io/jetstream';
import { PermissionViolationError } from '@nats-io/transport-node';
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import { errorClassOf } from '../error-class.js';
import type { EventEnvelope } from '../events/event-envelope.js';
import {
  DEFAULT_RESTRICTED_STREAM,
  DEFAULT_RESTRICTED_SUBJECT_PREFIX,
  MESSAGING_OPTIONS,
  type ResolvedMessagingOptions,
} from '../messaging-options.js';
import { EventPublisher, isMessagingUnavailable } from '../publisher/event-publisher.js';
import {
  purgeProcessedEvents,
  purgeSentOutboxEvents,
  redactSentRestrictedOutboxEvents,
} from './outbox-maintenance.js';
import { OUTBOX_OPTIONS, type ResolvedOutboxOptions } from './outbox-options.js';
import {
  isRedactedPayload,
  isRestrictedRoute,
  REDACTED_PAYLOAD_SQL,
  type RestrictedNames,
} from './outbox-redaction.js';

/**
 * Constant MAX_BACKOFF_MS
 *
 * @description
 * Longest pause between two passes while NATS, the streams or the database cannot be reached,
 * in milliseconds.
 *
 * @type {number}
 */
const MAX_BACKOFF_MS: number = 30_000;

/**
 * Constant MAX_ATTEMPTS
 *
 * @description
 * Failed attempts after which a row is parked (`failed`): it is published again only once
 * `requeueOutboxEvents` gives it a new series.
 *
 * @type {number}
 */
export const MAX_ATTEMPTS: number = 20;

/**
 * Constant ROW_BACKOFF_BASE_MS
 *
 * @description
 * Pause before the second attempt of a row, in milliseconds; it doubles after each failure.
 *
 * @type {number}
 */
const ROW_BACKOFF_BASE_MS: number = 1000;

/**
 * Constant ROW_BACKOFF_MAX_MS
 *
 * @description
 * Longest pause between two attempts of a row, in milliseconds: five minutes.
 *
 * @type {number}
 */
const ROW_BACKOFF_MAX_MS: number = 300_000;

/**
 * Constant WARNING_INTERVAL_MS
 *
 * @description
 * Shortest interval between two warnings about rows failing with the same class of error, in
 * milliseconds.
 *
 * @type {number}
 */
const WARNING_INTERVAL_MS: number = 60_000;

/**
 * Constant RESOURCE_LIMIT_CODES
 *
 * @description
 * JetStream error codes that mean the server cannot store anything now, whatever the row:
 * account resources exceeded (10002), insufficient resources (10023), memory resources exceeded
 * (10028), storage resources exceeded (10047), store failed (10077).
 *
 * @type {ReadonlySet<number>}
 */
const RESOURCE_LIMIT_CODES: ReadonlySet<number> = new Set<number>([
  10002, 10023, 10028, 10047, 10077,
]);

/**
 * Function rowBackoffMs
 *
 * @description
 * Pause before the next attempt of a row that failed a number of times: 1 s, 2 s, 4 s and so on,
 * capped at five minutes.
 *
 * @param {number} attempts - Failed attempts, this one included.
 * @returns {number} The pause, in milliseconds.
 */
export function rowBackoffMs(attempts: number): number {
  return Math.min(ROW_BACKOFF_BASE_MS * 2 ** Math.max(attempts - 1, 0), ROW_BACKOFF_MAX_MS);
}

/**
 * Function stopsPass
 *
 * @description
 * Tells whether a publish failure concerns every row rather than this one: NATS or the stream
 * cannot be reached, the user is not allowed to publish, or the server is out of resources. The
 * relay then stops its pass and backs off instead of failing every row.
 *
 * @param {unknown} error - Error raised by the publisher.
 * @returns {boolean} `true` when the pass should stop.
 */
export function stopsPass(error: unknown): boolean {
  if (isMessagingUnavailable(error) || error instanceof PermissionViolationError) {
    return true;
  }
  if (error instanceof Error && error.cause instanceof PermissionViolationError) {
    return true;
  }
  return error instanceof JetStreamApiError && RESOURCE_LIMIT_CODES.has(error.code);
}

/**
 * Interface RelayPass
 *
 * @description
 * Outcome of one pass of the relay.
 */
export interface RelayPass {
  // #region Properties
  /**
   * Property published
   *
   * @description
   * Number of rows published and marked sent.
   *
   * @type {number}
   * @readonly
   */
  readonly published: number;

  /**
   * Property failed
   *
   * @description
   * Number of rows whose publish failed; they stay pending, or are parked after 20 failures.
   *
   * @type {number}
   * @readonly
   */
  readonly failed: number;

  /**
   * Property interrupted
   *
   * @description
   * `true` when the pass stopped early because the failure concerned every row: NATS or the
   * stream cannot be reached, a permission is missing, or the server is out of resources.
   *
   * @type {boolean}
   * @readonly
   */
  readonly interrupted: boolean;
  // #endregion
}

/**
 * Interface PendingRow
 *
 * @description
 * Columns the relay reads from a pending outbox row.
 */
interface PendingRow {
  // #region Properties
  /**
   * Property id
   *
   * @description
   * Id of the event.
   *
   * @type {string}
   * @readonly
   */
  readonly id: string;

  /**
   * Property event_name
   *
   * @description
   * Name of the event.
   *
   * @type {string}
   * @readonly
   */
  readonly event_name: string;

  /**
   * Property subject
   *
   * @description
   * Subject the writer routed the event to.
   *
   * @type {string}
   * @readonly
   */
  readonly subject: string;

  /**
   * Property stream
   *
   * @description
   * Stream the writer routed the event to.
   *
   * @type {string}
   * @readonly
   */
  readonly stream: string;

  /**
   * Property payload
   *
   * @description
   * Payload validated when the row was appended, or its redacted envelope once a restricted row
   * was published.
   *
   * @type {EventEnvelope}
   * @readonly
   */
  readonly payload: EventEnvelope;

  /**
   * Property traceparent
   *
   * @description
   * Trace context captured when the row was appended.
   *
   * @type {string | null}
   * @readonly
   */
  readonly traceparent: string | null;

  /**
   * Property attempts
   *
   * @description
   * Failed attempts so far.
   *
   * @type {number}
   * @readonly
   */
  readonly attempts: number;
  // #endregion
}

/**
 * Interface WarningState
 *
 * @description
 * Rate limit of the warnings about one class of row failure.
 */
interface WarningState {
  // #region Properties
  /**
   * Property lastAt
   *
   * @description
   * Instant of the last warning, in milliseconds.
   *
   * @type {number}
   */
  lastAt: number;

  /**
   * Property suppressed
   *
   * @description
   * Failures not logged since the last warning.
   *
   * @type {number}
   */
  suppressed: number;
  // #endregion
}

/**
 * Class OutboxRelay
 *
 * @description
 * Publishes the pending rows of the outbox and marks them sent, after the use case that wrote
 * them committed. It starts when the application has bootstrapped and stops, after its pass in
 * progress, when the application shuts down.
 *
 * Each pass runs in one transaction of the system runner: it locks a batch of due pending rows
 * with `for update skip locked`, publishes each on the subject and to the stream the writer
 * stored, with `Nats-Msg-Id` set to the event id, then marks the published ones sent. Several
 * replicas can run the relay: a row locked by one is skipped by the others.
 *
 * Delivery is at least once. A crash, or a failed commit, after a publish leaves the row pending
 * and the next pass publishes the same id again: the server drops it inside its two-minute
 * window, and past it the processed-ids table of each consumer does.
 *
 * A restricted row (stored on the restricted stream or under the restricted subject prefix) has
 * its payload redacted by the statement that marks it sent: only the envelope (`id`,
 * `occurredAt`, `organizationId`, `actor`, `version`) and the `$redacted` marker stay, so the
 * single-use code or link it carried does not sit in the table for the retention of sent rows.
 * The message on `restricted.<name>` carries the full payload. A row whose publish failed keeps
 * its payload, to be published again. A redacted row found pending (made pending again by hand or
 * by the requeue of an older kit) is never published: it is marked sent again with a warning. At
 * its first pass and with every purge the relay also redacts the restricted rows sent whole
 * before the upgrade or by a replica still on an older kit.
 *
 * A row whose publish fails stays pending with `attempts` incremented, the class of the error
 * in `last_error`, and its next attempt delayed (1 s, doubling, capped at five minutes); after
 * 20 failures it is parked as `failed`, with one error log, until `requeueOutboxEvents`. Such a
 * row never blocks the others. A failure that concerns every row (NATS, the stream or a
 * permission missing, the server out of resources) stops the pass without counting against the
 * row, and the relay backs off, doubling its poll interval up to 30 seconds; so does a database
 * failure. Warnings about failing rows are logged at most once a minute per class of error.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, BeforeApplicationShutdown {
  // #region Properties
  /**
   * Property logger
   *
   * @description
   * Logger of the relay. It never receives a payload.
   *
   * @type {Logger}
   * @readonly
   */
  private readonly logger: Logger = new Logger('OutboxRelay');

  /**
   * Property warnings
   *
   * @description
   * Rate limit of the row warnings, by class of error.
   *
   * @type {Map<string, WarningState>}
   * @readonly
   */
  private readonly warnings: Map<string, WarningState> = new Map<string, WarningState>();

  /**
   * Property started
   *
   * @description
   * Whether the loop runs.
   *
   * @type {boolean}
   */
  private started: boolean = false;

  /**
   * Property timer
   *
   * @description
   * Timer of the next pass; `undefined` while a pass runs or the loop is stopped.
   *
   * @type {NodeJS.Timeout | undefined}
   */
  private timer: NodeJS.Timeout | undefined;

  /**
   * Property pass
   *
   * @description
   * Pass in progress, awaited on shutdown.
   *
   * @type {Promise<void> | undefined}
   */
  private pass: Promise<void> | undefined;

  /**
   * Property woken
   *
   * @description
   * Set when `wake` was called during a pass: the next pass follows at once.
   *
   * @type {boolean}
   */
  private woken: boolean = false;

  /**
   * Property failedPasses
   *
   * @description
   * Number of consecutive passes that were interrupted or failed, which drives the backoff.
   *
   * @type {number}
   */
  private failedPasses: number = 0;

  /**
   * Property lastPurgeAt
   *
   * @description
   * Instant of the last purge, in milliseconds.
   *
   * @type {number}
   */
  private lastPurgeAt: number = 0;

  /**
   * Property sweepDue
   *
   * @description
   * Whether the redaction of the restricted rows sent without it (by an older kit, or before the
   * upgrade) is due: at the first pass of the process, then with every purge.
   *
   * @type {boolean}
   */
  private sweepDue: boolean = true;

  /**
   * Property lastSelected
   *
   * @description
   * Number of rows the last pass locked, which tells whether its batch was full.
   *
   * @type {number}
   */
  private lastSelected: number = 0;

  /**
   * Property restricted
   *
   * @description
   * Name of the restricted stream and prefix of the restricted subjects, which make a stored row
   * restricted.
   *
   * @type {RestrictedNames}
   * @readonly
   */
  private readonly restricted: RestrictedNames;
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Stores the system runner, the publisher and the options. `OutboxModule` always injects the
   * options of `MessagingModule`; a relay built without them treats the rows of the default
   * restricted stream and prefix as restricted.
   *
   * @param {SystemTransactionRunner<DatabaseSchema>} system - System transaction runner of the service.
   * @param {EventPublisher} publisher - Publisher of the main entry point.
   * @param {ResolvedOutboxOptions} options - Options of the outbox module.
   * @param {ResolvedMessagingOptions | undefined} messaging - Options of the messaging module, which name the restricted stream and subject prefix.
   * @constructor
   */
  public constructor(
    private readonly system: SystemTransactionRunner<DatabaseSchema>,
    private readonly publisher: EventPublisher,
    @Inject(OUTBOX_OPTIONS) private readonly options: ResolvedOutboxOptions,
    @Optional() @Inject(MESSAGING_OPTIONS) messaging?: ResolvedMessagingOptions,
  ) {
    this.restricted = {
      restrictedStream: messaging?.restrictedStream ?? DEFAULT_RESTRICTED_STREAM,
      restrictedSubjectPrefix:
        messaging?.restrictedSubjectPrefix ?? DEFAULT_RESTRICTED_SUBJECT_PREFIX,
    };
  }
  // #endregion

  // #region Methods
  /**
   * Method onApplicationBootstrap
   *
   * @description
   * Starts the loop, unless the relay is disabled for this process.
   *
   * @returns {void}
   */
  public onApplicationBootstrap(): void {
    if (!this.options.relay) {
      return;
    }
    this.started = true;
    this.schedule(0);
  }

  /**
   * Method beforeApplicationShutdown
   *
   * @description
   * Stops the loop and waits for the pass in progress, before the NATS connection is drained
   * and the database pool closes.
   *
   * @returns {Promise<void>} Resolves once the relay stopped.
   */
  public async beforeApplicationShutdown(): Promise<void> {
    this.started = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.pass;
  }

  /**
   * Method wake
   *
   * @description
   * Asks for a pass now instead of at the next poll. Call it after a use case transaction
   * committed, to publish its events without waiting for the poll interval. It does nothing
   * when the relay is disabled or backing off.
   *
   * @returns {void}
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
   * Runs one pass: publishes up to `batchSize` due pending rows and marks them sent, redacting
   * the payload of the restricted ones in the same statement. The loop calls it; it is also the
   * way to publish from a process whose relay is disabled.
   *
   * @returns {Promise<RelayPass>} How many rows were published, how many failed and whether the pass stopped early.
   * @throws {Error} When the database cannot be reached or the transaction fails; no row is marked sent nor redacted.
   */
  public async publishPending(): Promise<RelayPass> {
    return this.system.run(async (tx: TransactionScope<DatabaseSchema>): Promise<RelayPass> => {
      const selected: { rows: unknown[] } = await tx.client.query(
        `select id, event_name, subject, stream, payload, traceparent, attempts
           from outbox_events
          where status = 'pending' and next_attempt_at <= now()
          order by next_attempt_at, created_at, id
          limit $1
            for update skip locked`,
        [this.options.batchSize],
      );
      this.lastSelected = selected.rows.length;
      const sent: string[] = [];
      const settled: PendingRow[] = [];
      const redacted: string[] = [];
      let failed: number = 0;
      let interrupted: boolean = false;
      for (const row of selected.rows as PendingRow[]) {
        if (isRedactedPayload(row.payload)) {
          settled.push(row);
          continue;
        }
        // Decided before the publish: a fault here fails the pass, never marks the row sent whole.
        const restricted: boolean = isRestrictedRoute(this.restricted, row);
        try {
          await this.publisher.publishEnvelope({
            name: row.event_name,
            subject: row.subject,
            stream: row.stream,
            payload: row.payload,
            traceparent: row.traceparent,
          });
          sent.push(row.id);
          if (restricted) {
            redacted.push(row.id);
          }
        } catch (error) {
          const errorClass: string = errorClassOf(error);
          if (stopsPass(error)) {
            await tx.client.query('update outbox_events set last_error = $2 where id = $1', [
              row.id,
              errorClass,
            ]);
            this.logger.warn(
              { eventId: row.id, event: row.event_name, errorClass },
              'outbox events cannot be published now: the relay backs off',
            );
            interrupted = true;
            break;
          }
          failed += 1;
          await this.recordFailure(tx, row, errorClass);
        }
      }
      if (settled.length > 0) {
        this.logger.warn(
          { count: settled.length, eventId: settled[0]?.id, event: settled[0]?.event_name },
          'redacted outbox events found pending: marked sent, not published again',
        );
      }
      if (sent.length + settled.length > 0) {
        // One statement marks the rows sent and empties the restricted ones: a crash or a failed
        // commit leaves both undone, so a row is redacted if and only if it is marked sent.
        await tx.client.query(
          `update outbox_events
              set status = 'sent', sent_at = now(), last_error = null,
                  payload = case when id = any($2::uuid[]) then ${REDACTED_PAYLOAD_SQL} else payload end
            where id = any($1::uuid[])`,
          [[...sent, ...settled.map((row: PendingRow) => row.id)], redacted],
        );
      }
      return { published: sent.length, failed, interrupted };
    });
  }

  /**
   * Method recordFailure
   *
   * @description
   * Records the failed attempt of one row: one more attempt, the next one delayed, or the row
   * parked after the last one.
   *
   * @param {TransactionScope<DatabaseSchema>} tx - Transaction of the pass.
   * @param {PendingRow} row - Row that failed.
   * @param {string} errorClass - Class of the error.
   * @returns {Promise<void>} Resolves once recorded.
   */
  private async recordFailure(
    tx: TransactionScope<DatabaseSchema>,
    row: PendingRow,
    errorClass: string,
  ): Promise<void> {
    const attempts: number = row.attempts + 1;
    const parked: boolean = attempts >= MAX_ATTEMPTS;
    await tx.client.query(
      `update outbox_events
          set attempts = $2, last_error = $3, status = $4,
              next_attempt_at = now() + make_interval(secs => $5::double precision)
        where id = $1`,
      [row.id, attempts, errorClass, parked ? 'failed' : 'pending', rowBackoffMs(attempts) / 1000],
    );
    if (parked) {
      this.logger.error(
        { eventId: row.id, event: row.event_name, attempts, errorClass },
        'outbox event failed too many times: parked until requeueOutboxEvents',
      );
      return;
    }
    const now: number = Date.now();
    const state: WarningState | undefined = this.warnings.get(errorClass);
    if (state === undefined || now - state.lastAt >= WARNING_INTERVAL_MS) {
      this.warnings.set(errorClass, { lastAt: now, suppressed: 0 });
      this.logger.warn(
        {
          eventId: row.id,
          event: row.event_name,
          attempts,
          errorClass,
          suppressed: state?.suppressed ?? 0,
        },
        'outbox event could not be published: it stays pending',
      );
    } else {
      state.suppressed += 1;
    }
  }

  /**
   * Method schedule
   *
   * @description
   * Plans the next pass.
   *
   * @param {number} delayMs - Pause before the pass, in milliseconds.
   * @returns {void}
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
   * Runs one pass and the maintenance when it is due, then plans the next pass: at once when the
   * batch was full or `wake` was called, after the poll interval otherwise, and after a growing
   * pause while passes are interrupted or fail.
   *
   * @returns {Promise<void>} Resolves once the next pass is planned; it never rejects.
   */
  private async tick(): Promise<void> {
    let again: boolean = false;
    try {
      this.lastSelected = 0;
      const pass: RelayPass = await this.publishPending();
      this.failedPasses = pass.interrupted ? this.failedPasses + 1 : 0;
      again = !pass.interrupted && this.lastSelected === this.options.batchSize;
      await this.maintainWhenDue();
    } catch (error) {
      this.failedPasses += 1;
      this.logger.error({ err: error }, 'outbox relay pass failed');
    }
    again ||= this.woken && this.failedPasses === 0;
    this.woken = false;
    this.pass = undefined;
    this.schedule(
      again ? 0 : Math.min(this.options.pollIntervalMs * 2 ** this.failedPasses, MAX_BACKOFF_MS),
    );
  }

  /**
   * Method maintainWhenDue
   *
   * @description
   * Once per purge interval, deletes the sent outbox rows and the processed event ids past their
   * retention. At the first pass of the process and with every purge, redacts the restricted rows
   * sent without redaction (before the upgrade, or by a replica on an older kit). A failed run is
   * logged like a failed pass and is not repeated before the next purge.
   *
   * @returns {Promise<void>} Resolves once the maintenance ran or was skipped.
   */
  private async maintainWhenDue(): Promise<void> {
    const purgeDue: boolean =
      this.options.purgeIntervalMs > 0 &&
      Date.now() - this.lastPurgeAt >= this.options.purgeIntervalMs;
    if (!purgeDue && !this.sweepDue) {
      return;
    }
    this.sweepDue = false;
    if (purgeDue) {
      this.lastPurgeAt = Date.now();
    }
    const done: { redacted: number; outbox: number; processed: number } = await this.system.run(
      async (tx: TransactionScope<DatabaseSchema>) => ({
        redacted: await redactSentRestrictedOutboxEvents(tx, this.restricted),
        outbox: purgeDue ? await purgeSentOutboxEvents(tx, this.options.retentionDays) : 0,
        processed: purgeDue
          ? await purgeProcessedEvents(tx, this.options.processedRetentionDays)
          : 0,
      }),
    );
    if (done.redacted > 0) {
      this.logger.warn(
        { redacted: done.redacted },
        'restricted outbox rows sent without redaction were redacted',
      );
    }
    if (done.outbox > 0 || done.processed > 0) {
      this.logger.log(
        { outbox: done.outbox, processed: done.processed },
        'old outbox rows and processed event ids purged',
      );
    }
  }
  // #endregion
}
