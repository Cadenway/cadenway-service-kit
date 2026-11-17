import { Global, Module, type DynamicModule } from '@nestjs/common';

import { OutboxWriter } from './outbox-writer.js';

/**
 * Class OutboxWriterModule
 *
 * @description
 * Registers the transactional outbox writer.
 */
@Global()
@Module({
  providers: [OutboxWriter],
  exports: [OutboxWriter],
})
export class OutboxWriterModule {
  // #region Methods
  /**
   * Method forRoot
   *
   * @description
   * Registers the global outbox writer.
   *
   * @returns {DynamicModule} Global module exposing the transactional writer.
   */
  public static forRoot(): DynamicModule {
    return { module: OutboxWriterModule };
  }
  // #endregion
}
