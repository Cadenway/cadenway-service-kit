import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';

/**
 * Class LegacyOutboxNotice
 *
 * @description
 * Warns applications that still compose their outbox through the legacy module.
 */
@Injectable()
export class LegacyOutboxNotice implements OnApplicationBootstrap {
  // #region Methods
  /**
   * Method onApplicationBootstrap
   *
   * @description
   * Reports the replacement modules in the legacy module's log context.
   */
  public onApplicationBootstrap(): void {
    new Logger('OutboxModule').warn(
      'OutboxModule is deprecated; compose OutboxWriterModule, OutboxRelayModule and PostgresEventDeduplicationModule as needed.',
    );
  }
  // #endregion
}
