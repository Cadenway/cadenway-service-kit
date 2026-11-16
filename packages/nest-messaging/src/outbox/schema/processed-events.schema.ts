import { index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Table `processed_events`, published as `processedEvents` by the `/outbox` entry point.
 *
 * One row per event a durable consumer handled: the consumer name (`<service>__<handler>`) and
 * the event id. The row is inserted in the transaction of the handler, so it exists if and only
 * if the handler committed; a redelivery of the same id finds it and skips the handler. This
 * table is the real guard against duplicates: the server only deduplicates inside its two-minute
 * window.
 *
 * The table holds no business data and no `organization_id`, so it carries no row-level security
 * policy. `processed_at` is indexed for the purge of old rows.
 *
 * It is a default export so that its column types stay inferred, like the outbox table.
 *
 * A change to this table ships a migration note for every service.
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
