import { resolveOutboxOptions, type OutboxModuleOptions } from '../../wiring/outbox-options.js';

/**
 * Interface OutboxRelayOptions
 *
 * @description
 * Configuration of the lease-based relay.
 */
export interface OutboxRelayOptions extends Omit<OutboxModuleOptions, 'relay' | 'batchSize'> {
  // #region Properties
  /**
   * Property autoStart
   *
   * @description
   * Starts polling and maintenance on bootstrap. Defaults to true.
   *
   * @type {boolean | undefined}
   * @readonly
   */
  readonly autoStart?: boolean;

  /**
   * Property concurrency
   *
   * @description
   * Maximum publications in flight per replica. Defaults to four.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly concurrency?: number;

  /**
   * Property leaseMs
   *
   * @description
   * Minimum lease duration in milliseconds. Defaults to 30 seconds.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly leaseMs?: number;

  /**
   * Property shutdownTimeoutMs
   *
   * @description
   * Time allowed to finish the active batch at shutdown. Defaults to 10 seconds.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly shutdownTimeoutMs?: number;
  // #endregion
}

/**
 * Type ResolvedOutboxRelayOptions
 *
 * @description
 * Relay options with component defaults applied.
 *
 * @type {Required<OutboxRelayOptions>}
 */
export type ResolvedOutboxRelayOptions = Required<OutboxRelayOptions>;

/**
 * Function resolveOutboxRelayOptions
 *
 * @description
 * Applies relay defaults and rejects invalid concurrency or timer configuration.
 *
 * @param {OutboxRelayOptions} options - Lease relay settings supplied by the caller.
 * @returns {ResolvedOutboxRelayOptions} Resolved lease relay options within supported timer and concurrency bounds.
 */
export function resolveOutboxRelayOptions(
  options: OutboxRelayOptions = {},
): ResolvedOutboxRelayOptions {
  const retained = resolveOutboxOptions(options);
  const resolved: ResolvedOutboxRelayOptions = {
    pollIntervalMs: retained.pollIntervalMs,
    purgeIntervalMs: retained.purgeIntervalMs,
    retentionDays: retained.retentionDays,
    processedRetentionDays: retained.processedRetentionDays,
    autoStart: options.autoStart ?? true,
    concurrency: options.concurrency ?? 4,
    leaseMs: options.leaseMs ?? 30_000,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 10_000,
  };
  if (!Number.isSafeInteger(resolved.concurrency) || resolved.concurrency < 1) {
    throw new Error('Outbox relay concurrency must be a positive integer.');
  }
  for (const delay of [resolved.leaseMs, resolved.shutdownTimeoutMs, resolved.pollIntervalMs]) {
    if (!Number.isSafeInteger(delay) || delay < 1 || delay > 2_147_483_647) {
      throw new Error('Outbox relay delays must be positive millisecond timer durations.');
    }
  }
  return resolved;
}
