import { index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Constant processedEvents
 *
 * @description
 * Deduplicates each event ID per durable consumer. The row and the handler's work commit in the
 * same transaction, so a redelivery can skip that work while the row is retained.
 *
 * The table has only consumer and event identifiers and the indexed retention timestamp.
 * It carries no organization policy.
 */
export default pgTable(
  'processed_events',
  {
    consumer: text('consumer').notNull(),
    eventId: uuid('event_id').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'processed_events_pkey', columns: [table.consumer, table.eventId] }),
    index('processed_events_processed_at_index').on(table.processedAt),
  ],
);
