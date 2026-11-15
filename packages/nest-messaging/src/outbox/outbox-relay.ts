import {
  SystemTransactionRunner,
  type DatabaseSchema,
  type TransactionScope,
} from '@cadenway/nest-common/database';
import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import type { EventEnvelope } from '../events/event-envelope.js';
import { EventPublisher, isMessagingUnavailable } from '../publisher/event-publisher.js';
import { purgeProcessedEvents, purgeSentOutboxEvents } from './outbox-maintenance.js';
import { OUTBOX_OPTIONS, type ResolvedOutboxOptions } from './outbox-options.js';

/**
 * Constant MAX_BACKOFF_MS
 *
 * @description
 * Longest pause between two passes while NATS cannot be reached, in milliseconds.
 *
 * @type {number}
 */
const MAX_BACKOFF_MS: number = 30_000;

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
   * Number of rows whose publish failed; they stay pending.
   *
   * @type {number}
   * @readonly
   */
  readonly failed: number;

  /**
   * Property interrupted
   *
   * @description
   * `true` when the pass stopped early because NATS or the events stream could not be reached.
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
  // #endregion
}

/**
 * Function errorClassOf
 *
 * @description
 * Names the class of a publish failure for the `last_error` column: a short, stable label that
 * never holds a message or a payload.
 *
 * @param {unknown} error - Error raised by the publisher.
 * @returns {string} The name of the error class, at most 100 characters.
 */
function errorClassOf(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'UnknownError';
  }
  const name: string = error.name === 'Error' ? error.constructor.name : error.name;
  return name.slice(0, 100);
}

/**
 * Class OutboxRelay
 *
 * @description
 * Publishes the pending rows of the outbox and marks them sent, after the use case that wrote
 * them committed. It starts when the application has bootstrapped and stops, after its pass in
 * progress, when the application shuts down.
 *
 * Each pass runs in one transaction of the system runner: it locks a batch of pending rows with
 * `for update skip locked`, publishes each with `Nats-Msg-Id` set to the event id, then marks the
 * published ones sent. Several replicas can run the relay: a row locked by one is skipped by the
 * others.
 *
 * Delivery is at least once. A crash, or a failed commit, after a publish leaves the row pending
 * and the next pass publishes the same id again: the server drops it inside its two-minute
 * window, and past it the processed-ids table of each consumer does.
 *
 * A row whose publish fails stays pending, with `attempts` incremented and the class of the
 * error in `last_error`. Rows are read least attempted first, then oldest first, so a row that
 * keeps failing sinks behind the rows never tried and cannot starve them. When the failure means
 * that NATS or the stream is unreachable, the pass stops there and the relay backs off, up to 30
 * seconds, instead of timing out on every row.
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
   * Property interruptedPasses
   *
   * @description
   * Number of consecutive passes that found NATS unreachable, which drives the backoff.
   *
   * @type {number}
   */
  private interruptedPasses: number = 0;

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
   * when the relay is disabled or backing off because NATS is unreachable.
   *
   * @returns {void}
   */
  public wake(): void {
    if (!this.started || this.interruptedPasses > 0) {
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
   * Runs one pass: publishes up to `batchSize` pending rows and marks them sent. The loop calls
   * it; it is also the way to publish from a process whose relay is disabled.
   *
   * @returns {Promise<RelayPass>} How many rows were published, how many failed and whether the pass stopped early.
   * @throws {Error} When the database cannot be reached or the transaction fails; no row is marked sent.
   */
  public async publishPending(): Promise<RelayPass> {
    return this.system.run(async (tx: TransactionScope<DatabaseSchema>): Promise<RelayPass> => {
      const selected: { rows: unknown[] } = await tx.client.query(
        `select id, event_name, payload, traceparent
           from outbox_events
          where status = 'pending'
          order by attempts, created_at, id
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
            payload: row.payload,
            traceparent: row.traceparent,
          });
          sent.push(row.id);
        } catch (error) {
          failed += 1;
          const errorClass: string = errorClassOf(error);
          await tx.client.query(
            'update outbox_events set attempts = attempts + 1, last_error = $2 where id = $1',
            [row.id, errorClass],
          );
          this.logger.warn(
            { eventId: row.id, event: row.event_name, errorClass },
            'outbox event could not be published: it stays pending',
          );
          if (isMessagingUnavailable(error)) {
            interrupted = true;
            break;
          }
        }
      }
      if (sent.length > 0) {
        await tx.client.query(
          `update outbox_events
              set status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = null
            where id = any($1::uuid[])`,
          [sent],
        );
      }
      return { published: sent.length, failed, interrupted };
    });
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
   * pause while NATS is unreachable.
   *
   * @returns {Promise<void>} Resolves once the next pass is planned; it never rejects.
   */
  private async tick(): Promise<void> {
    let again: boolean = false;
    try {
      const pass: RelayPass = await this.publishPending();
      this.interruptedPasses = pass.interrupted ? this.interruptedPasses + 1 : 0;
      again = !pass.interrupted && pass.published === this.options.batchSize;
      await this.purgeWhenDue();
    } catch (error) {
      this.logger.error({ err: error }, 'outbox relay pass failed');
    }
    again ||= this.woken && this.interruptedPasses === 0;
    this.woken = false;
    this.pass = undefined;
    this.schedule(
      again
        ? 0
        : Math.min(this.options.pollIntervalMs * 2 ** this.interruptedPasses, MAX_BACKOFF_MS),
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
