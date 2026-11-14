import { Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';

import { shutdownTelemetry } from '../telemetry/telemetry-handle.js';

/**
 * Class TelemetryShutdown
 *
 * @description
 * Flushes and stops telemetry when the application shuts down, so the last spans of a stopped
 * container are exported.
 */
@Injectable()
class TelemetryShutdown implements OnApplicationShutdown {
  // #region Methods
  /**
   * Method onApplicationShutdown
   *
   * @description
   * Flushes pending telemetry; resolves at once when telemetry was never started.
   *
   * @returns {Promise<void>} Resolves once telemetry is stopped.
   */
  public async onApplicationShutdown(): Promise<void> {
    await shutdownTelemetry();
  }
  // #endregion
}

/**
 * Class ApplicationRootModule
 *
 * @description
 * Root module `createApplication` wraps around the module of the application. Internal to the
 * package: it only anchors the shared providers and the telemetry shutdown.
 */
@Module({ providers: [TelemetryShutdown] })
export class ApplicationRootModule {}
