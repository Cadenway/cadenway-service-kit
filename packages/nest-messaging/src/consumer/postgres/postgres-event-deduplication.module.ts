import { Global, Module } from '@nestjs/common';

import { EVENT_DEDUPLICATOR } from '../delivery/event-deduplicator.js';
import { PostgresEventDeduplicator } from './postgres-event-deduplicator.js';

/**
 * Registers the PostgreSQL deduplicator for the application's event consumers.
 * Import DatabaseModule and MessagingModule alongside it.
 */
@Global()
@Module({
  providers: [
    PostgresEventDeduplicator,
    { provide: EVENT_DEDUPLICATOR, useExisting: PostgresEventDeduplicator },
  ],
  exports: [PostgresEventDeduplicator, EVENT_DEDUPLICATOR],
})
export class PostgresEventDeduplicationModule {}
