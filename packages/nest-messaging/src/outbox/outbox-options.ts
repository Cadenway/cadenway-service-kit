/**
 * Constant OUTBOX_OPTIONS
 *
 * @description
 * Injection token of the options of `OutboxModule`, with every default applied.
 *
 * @type {symbol}
 */
export const OUTBOX_OPTIONS: unique symbol = Symbol('cadenway.messaging.outbox.options');

/**
 * Constant OUTBOX_RETENTION_DAYS
 *
 * @description
 * How long a sent outbox row is kept, in days, so it can be published again after a NATS loss.
 *
 * @type {number}
 */
export const OUTBOX_RETENTION_DAYS: number = 7;

/**
 * Constant PROCESSED_EVENTS_RETENTION_DAYS
 *
 * @description
 * How long a processed event id is kept, in days: the seven days a message stays in the stream
 * plus the seven days an outbox row can still be published again.
 *
 * @type {number}
 */
export const PROCESSED_EVENTS_RETENTION_DAYS: number = 14;

/**
 * Interface OutboxModuleOptions
 *
 * @description
 * Options of `OutboxModule.forRoot`. Every option has the default documented on it and in the
 * README.
 */
export interface OutboxModuleOptions {
  // #region Properties
  /**
   * Property relay
   *
   * @description
   * Runs the relay that publishes pending outbox rows. Defaults to `true`. Several replicas may
   * run it; a service that wants a single relay turns it off in the others. With `false` the
   * outbox is still written and nothing is published by this process.
   *
   * @type {boolean | undefined}
   * @readonly
   */
  readonly relay?: boolean;

  /**
   * Property pollIntervalMs
   *
   * @description
   * Pause between two passes of the relay when nothing woke it, in milliseconds. Defaults to
   * 1000.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly pollIntervalMs?: number;

  /**
   * Property batchSize
   *
   * @description
   * Maximum number of rows one pass locks and publishes. Defaults to 100.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly batchSize?: number;

  /**
   * Property purgeIntervalMs
   *
   * @description
   * Pause between two purges of old rows by the relay, in milliseconds. Defaults to one hour;
   * `0` disables the purge, which the service then schedules itself.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly purgeIntervalMs?: number;

  /**
   * Property retentionDays
   *
   * @description
   * How long the purge keeps a sent outbox row, in days. Defaults to 7.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly retentionDays?: number;

  /**
   * Property processedRetentionDays
   *
   * @description
   * How long the purge keeps a processed event id, in days. Defaults to 14. A shorter value
   * could let a late redelivery be handled twice.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly processedRetentionDays?: number;
  // #endregion
}

/**
 * Type ResolvedOutboxOptions
 *
 * @description
 * Options of `OutboxModule` with every default applied.
 *
 * @type {Readonly<Required<OutboxModuleOptions>>}
 */
export type ResolvedOutboxOptions = Readonly<Required<OutboxModuleOptions>>;

/**
 * Function resolveOutboxOptions
 *
 * @description
 * Applies the documented default of every option left unset.
 *
 * @param {OutboxModuleOptions} options - Options given to `OutboxModule`.
 * @returns {ResolvedOutboxOptions} The complete options.
 * @throws {Error} When the batch size or the poll interval is not positive.
 */
export function resolveOutboxOptions(options: OutboxModuleOptions = {}): ResolvedOutboxOptions {
  const resolved: ResolvedOutboxOptions = {
    relay: options.relay ?? true,
    pollIntervalMs: options.pollIntervalMs ?? 1000,
    batchSize: options.batchSize ?? 100,
    purgeIntervalMs: options.purgeIntervalMs ?? 3_600_000,
    retentionDays: options.retentionDays ?? OUTBOX_RETENTION_DAYS,
    processedRetentionDays: options.processedRetentionDays ?? PROCESSED_EVENTS_RETENTION_DAYS,
  };
  if (!Number.isInteger(resolved.batchSize) || resolved.batchSize < 1) {
    throw new Error('The batch size of the outbox relay is a positive integer.');
  }
  if (resolved.pollIntervalMs <= 0) {
    throw new Error('The poll interval of the outbox relay is positive.');
  }
  return resolved;
}
