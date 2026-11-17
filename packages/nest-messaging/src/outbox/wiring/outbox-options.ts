/**
 * Constant OUTBOX_OPTIONS
 *
 * @description
 * Injection token for the resolved `OutboxModule` options.
 *
 * @type {unique symbol}
 */
export const OUTBOX_OPTIONS: unique symbol = Symbol('cadenway.messaging.outbox.options');

/**
 * Constant DEFAULT_OUTBOX_RETENTION_DAYS
 *
 * @description
 * Days a sent outbox row remains available for replay after a NATS loss.
 *
 * @type {number}
 */
export const DEFAULT_OUTBOX_RETENTION_DAYS: number = 7;

/**
 * Constant DEFAULT_PROCESSED_EVENTS_RETENTION_DAYS
 *
 * @description
 * Days to keep a processed event ID, covering both stream retention and the outbox replay window.
 *
 * @type {number}
 */
export const DEFAULT_PROCESSED_EVENTS_RETENTION_DAYS: number = 14;

/**
 * Interface OutboxModuleOptions
 *
 * @description
 * Polling, batch and retention settings for the legacy outbox module.
 */
export interface OutboxModuleOptions {
  // #region Properties
  /**
   * Property relay
   *
   * @description
   * Enables automatic relay polling, defaulting to `true`. With `false`, writing and explicit
   * publication passes remain available.
   *
   * @type {boolean | undefined}
   * @readonly
   */
  readonly relay?: boolean;

  /**
   * Property pollIntervalMs
   *
   * @description
   * Idle time between passes in milliseconds, defaulting to 1000.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly pollIntervalMs?: number;

  /**
   * Property batchSize
   *
   * @description
   * Maximum rows one pass locks and publishes, defaulting to 100.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly batchSize?: number;

  /**
   * Property purgeIntervalMs
   *
   * @description
   * Milliseconds between scheduled purges. One hour by default, or `0` to disable them.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly purgeIntervalMs?: number;

  /**
   * Property retentionDays
   *
   * @description
   * Minimum age in days for purging a sent row, defaulting to 7.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly retentionDays?: number;

  /**
   * Property processedRetentionDays
   *
   * @description
   * Days to retain processed event IDs. Less than the default 14 can allow repeat handling.
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
 * Legacy relay settings with all defaults applied.
 *
 * @type {Readonly<Required<OutboxModuleOptions>>}
 */
export type ResolvedOutboxOptions = Readonly<Required<OutboxModuleOptions>>;

/**
 * Function resolveOutboxOptions
 *
 * @description
 * Applies the documented relay defaults.
 *
 * @param {OutboxModuleOptions} options - Legacy relay and retention settings supplied by the caller.
 * @returns {ResolvedOutboxOptions} Legacy settings with documented defaults applied.
 * @throws When the batch size or the poll interval is not positive.
 */
export function resolveOutboxOptions(options: OutboxModuleOptions = {}): ResolvedOutboxOptions {
  const resolved: ResolvedOutboxOptions = {
    relay: options.relay ?? true,
    pollIntervalMs: options.pollIntervalMs ?? 1000,
    batchSize: options.batchSize ?? 100,
    purgeIntervalMs: options.purgeIntervalMs ?? 3_600_000,
    retentionDays: options.retentionDays ?? DEFAULT_OUTBOX_RETENTION_DAYS,
    processedRetentionDays:
      options.processedRetentionDays ?? DEFAULT_PROCESSED_EVENTS_RETENTION_DAYS,
  };
  if (!Number.isInteger(resolved.batchSize) || resolved.batchSize < 1) {
    throw new Error('The batch size of the outbox relay is a positive integer.');
  }
  if (resolved.pollIntervalMs <= 0) {
    throw new Error('The poll interval of the outbox relay is positive.');
  }
  return resolved;
}
