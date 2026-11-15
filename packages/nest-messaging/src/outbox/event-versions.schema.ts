import { bigint, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Table `event_versions`, published as `eventVersions` by the `/outbox` entry point.
 *
 * One row per aggregate a durable consumer keeps up to date: the consumer name, a key the handler
 * chooses for the aggregate (such as `task:<id>`) and the highest event `version` the consumer
 * applied to it. `claimVersion` of the handler context raises the version only when the event is
 * newer, so a late redelivery of an older event changes nothing.
 *
 * The table holds no business data and no `organization_id`, so it carries no row-level security
 * policy.
 *
 * It is a default export so that its column types stay inferred, like the outbox table.
 *
 * A change to this table ships a migration note for every service.
 */
export default pgTable(
  'event_versions',
  {
    consumer: text('consumer').notNull(),
    aggregateKey: text('aggregate_key').notNull(),
    version: bigint('version', { mode: 'number' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'event_versions_pkey', columns: [table.consumer, table.aggregateKey] }),
  ],
);
