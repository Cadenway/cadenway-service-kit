import { Module, type DynamicModule } from '@nestjs/common';

import { EVENT_DEDUPLICATOR } from '../consumer/event-deduplicator.js';
import {
  OUTBOX_OPTIONS,
  resolveOutboxOptions,
  type OutboxModuleOptions,
} from './outbox-options.js';
import { OutboxRelay } from './outbox-relay.js';
import { OutboxWriter } from './outbox-writer.js';
import { PostgresEventDeduplicator } from './postgres-event-deduplicator.js';

/**
 * Class OutboxModule
 *
 * @description
 * Gives a service with a database the outbox writer, the relay and the PostgreSQL deduplicator,
 * globally. Importing it registers the deduplicator as the `EventDeduplicator` of the
 * application: every handler registered with `EventConsumers` then runs at most once per event,
 * in a transaction.
 *
 * It requires `DatabaseModule` of `@cadenway/nest-common/database`, for the two transaction
 * runners, and `MessagingModule` of this package, both imported by the application. The three
 * tables it uses come from the migrations of the service: see the README.
 */
@Module({})
export class OutboxModule {
  // #region Methods
  /**
   * Method forRoot
   *
   * @description
   * Registers the module.
   *
   * @param {OutboxModuleOptions} options - Relay settings; every option has a default.
   * @returns {DynamicModule} The global module.
   * @throws {Error} When the batch size or the poll interval is not positive.
   */
  public static forRoot(options: OutboxModuleOptions = {}): DynamicModule {
    return {
      module: OutboxModule,
      global: true,
      providers: [
        { provide: OUTBOX_OPTIONS, useValue: resolveOutboxOptions(options) },
        OutboxWriter,
        OutboxRelay,
        PostgresEventDeduplicator,
        { provide: EVENT_DEDUPLICATOR, useExisting: PostgresEventDeduplicator },
      ],
      exports: [OUTBOX_OPTIONS, OutboxWriter, OutboxRelay, EVENT_DEDUPLICATOR],
    };
  }
  // #endregion
}
