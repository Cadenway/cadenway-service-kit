import { Global, Module, type DynamicModule } from '@nestjs/common';

import { OutboxWriter } from './outbox-writer.js';

/** Registers the transactional outbox writer. */
@Global()
@Module({
  providers: [OutboxWriter],
  exports: [OutboxWriter],
})
export class OutboxWriterModule {
  // #region Methods
  /** Registers the global outbox writer. */
  public static forRoot(): DynamicModule {
    return { module: OutboxWriterModule };
  }
  // #endregion
}
