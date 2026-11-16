import { resolveOutboxOptions, type OutboxModuleOptions } from '../../wiring/outbox-options.js';

/** Configuration of the lease-based relay. */
export interface OutboxRelayOptions extends Omit<OutboxModuleOptions, 'relay' | 'batchSize'> {
  // #region Properties
  /** Starts polling and maintenance on bootstrap. Defaults to true. */
  readonly autoStart?: boolean;

  /** Maximum publications in flight per replica. Defaults to four. */
  readonly concurrency?: number;

  /** Minimum lease duration in milliseconds. Defaults to 30 seconds. */
  readonly leaseMs?: number;

  /** Time allowed to finish the active batch at shutdown. Defaults to 10 seconds. */
  readonly shutdownTimeoutMs?: number;
  // #endregion
}

/** Relay options with component defaults applied. */
export type ResolvedOutboxRelayOptions = Required<OutboxRelayOptions>;

/** Applies relay defaults and rejects invalid concurrency or timer configuration. */
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
