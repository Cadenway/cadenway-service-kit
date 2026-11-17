import { organizationPolicy } from '@cadenway/nest-common/database';
import { bigint, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/**
 * Constant eventVersions
 *
 * @description
 * Tracks the highest event version a durable consumer applied per organization and aggregate.
 * Null organization IDs compare equal. `claimVersion` advances a row only for a newer event,
 * so a late redelivery cannot overwrite a newer version.
 *
 * The service migration forces row-level security for the organization policy.
 */
export default pgTable(
  'event_versions',
  {
    consumer: text('consumer').notNull(),
    organizationId: uuid('organization_id'),
    aggregateKey: text('aggregate_key').notNull(),
    version: bigint('version', { mode: 'number' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('event_versions_aggregate_unique')
      .on(table.consumer, table.organizationId, table.aggregateKey)
      .nullsNotDistinct(),
    organizationPolicy('event_versions_organization_isolation'),
  ],
);
