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
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import { errorClassOf } from '../error-class.js';
import type { EventEnvelope } from '../events/event-envelope.js';
import { EventPublisher, isMessagingUnavailable } from '../publisher/event-publisher.js';
import { purgeProcessedEvents, purgeSentOutboxEvents } from './outbox-maintenance.js';
import { OUTBOX_OPTIONS, type ResolvedOutboxOptions } from './outbox-options.js';

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
   * Payload validated when the row was appended.
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
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Stores the system runner, the publisher and the options.
   *
   * @param {SystemTransactionRunner<DatabaseSchema>} system - System transaction runner of the service.
   * @param {EventPublisher} publisher - Publisher of the main entry point.
   * @param {ResolvedOutboxOptions} options - Options of the outbox module.
   * @constructor
   */
  public constructor(
    private readonly system: SystemTransactionRunner<DatabaseSchema>,
    private readonly publisher: EventPublisher,
    @Inject(OUTBOX_OPTIONS) private readonly options: ResolvedOutboxOptions,
  ) {}
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
   * Runs one pass: publishes up to `batchSize` due pending rows and marks them sent. The loop
   * calls it; it is also the way to publish from a process whose relay is disabled.
   *
   * @returns {Promise<RelayPass>} How many rows were published, how many failed and whether the pass stopped early.
   * @throws {Error} When the database cannot be reached or the transaction fails; no row is marked sent.
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
      const sent: string[] = [];
      let failed: number = 0;
      let interrupted: boolean = false;
      for (const row of selected.rows as PendingRow[]) {
        try {
          await this.publisher.publishEnvelope({
            name: row.event_name,
            subject: row.subject,
            stream: row.stream,
            payload: row.payload,
            traceparent: row.traceparent,
          });
          sent.push(row.id);
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
      if (sent.length > 0) {
        await tx.client.query(
          `update outbox_events
              set status = 'sent', sent_at = now(), last_error = null
            where id = any($1::uuid[])`,
          [sent],
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
   * Runs one pass and the purge when it is due, then plans the next pass: at once when the
   * batch was full or `wake` was called, after the poll interval otherwise, and after a growing
   * pause while passes are interrupted or fail.
   *
   * @returns {Promise<void>} Resolves once the next pass is planned; it never rejects.
   */
  private async tick(): Promise<void> {
    let again: boolean = false;
    try {
      const pass: RelayPass = await this.publishPending();
      this.failedPasses = pass.interrupted ? this.failedPasses + 1 : 0;
      again = !pass.interrupted && pass.published + pass.failed === this.options.batchSize;
      await this.purgeWhenDue();
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
   * Method purgeWhenDue
   *
   * @description
   * Deletes the sent outbox rows and the processed event ids past their retention, once per
   * purge interval.
   *
   * @returns {Promise<void>} Resolves once the purge ran or was skipped.
   */
  private async purgeWhenDue(): Promise<void> {
    if (
      this.options.purgeIntervalMs <= 0 ||
      Date.now() - this.lastPurgeAt < this.options.purgeIntervalMs
    ) {
      return;
    }
    this.lastPurgeAt = Date.now();
    const purged: { outbox: number; processed: number } = await this.system.run(
      async (tx: TransactionScope<DatabaseSchema>) => ({
        outbox: await purgeSentOutboxEvents(tx, this.options.retentionDays),
        processed: await purgeProcessedEvents(tx, this.options.processedRetentionDays),
      }),
    );
    if (purged.outbox > 0 || purged.processed > 0) {
      this.logger.log(purged, 'old outbox rows and processed event ids purged');
    }
  }
  // #endregion
}
