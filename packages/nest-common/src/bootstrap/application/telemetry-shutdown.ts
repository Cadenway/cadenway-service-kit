import { setTimeout as delay } from 'node:timers/promises';

import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';

import { shutdownTelemetry } from '../../telemetry/sdk/telemetry-handle.js';

/**
 * Constant TELEMETRY_FLUSH_TIMEOUT_MS
 *
 * @description
 * Longest time the shutdown waits for the last spans and metrics to be exported, in
 * milliseconds. An unreachable collector must not hold a stopping container.
 *
 * @type {number}
 */
const TELEMETRY_FLUSH_TIMEOUT_MS: number = 3000;

/**
 * Class TelemetryShutdown
 *
 * @description
 * Flushes and stops telemetry when the application shuts down, so the last spans of a stopped
 * container are exported. The flush is bounded and never fails the shutdown.
 */
@Injectable()
export class TelemetryShutdown implements OnApplicationShutdown {
  // #region Properties
  /**
   * Property logger
   *
   * @description
   * Logger of a flush that failed or timed out.
   *
   * @type {Logger}
   * @readonly
   */
  private readonly logger: Logger = new Logger('Telemetry');
  // #endregion

  // #region Methods
  /**
   * Method onApplicationShutdown
   *
   * @description
   * Flushes pending telemetry within the timeout; resolves at once when telemetry was never
   * started. A failed or late flush is logged as a warning and otherwise ignored.
   *
   * @returns {Promise<void>} Resolves once telemetry is stopped or the timeout has passed.
   */
  public async onApplicationShutdown(): Promise<void> {
    const cancel: AbortController = new AbortController();
    try {
      const outcome: 'flushed' | 'timeout' = await Promise.race([
        shutdownTelemetry().then((): 'flushed' => 'flushed'),
        delay(TELEMETRY_FLUSH_TIMEOUT_MS, 'timeout' as const, { signal: cancel.signal }),
      ]);
      if (outcome === 'timeout') {
        this.logger.warn('telemetry was not flushed in time; the last spans may be lost');
      }
    } catch {
      this.logger.warn('telemetry could not be flushed; the last spans may be lost');
    } finally {
      cancel.abort();
    }
  }
  // #endregion
}
