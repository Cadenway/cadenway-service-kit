import { organizationPolicy } from '@cadenway/nest-common/database';
import { bigint, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/**
 * Table `event_versions`, published as `eventVersions` by the `/outbox` entry point.
 *
 * One row per aggregate a durable consumer keeps up to date: the consumer name, the organization
 * of the event (null for an event outside any organization), a key the handler chooses for the
 * aggregate (such as `task:<id>`) and the highest event `version` the consumer applied to it.
 * The organization is part of the key, with nulls treated as equal, so the versions of two
 * organizations never compete. `claimVersion` of the handler context raises the version only
 * when the event is newer, so a late redelivery of an older event changes nothing.
 *
 * The table carries the organization policy like any tenant table; the migration of the service
 * adds `ALTER TABLE "event_versions" FORCE ROW LEVEL SECURITY`.
 *
 * It is a default export so that its column types stay inferred, like the outbox table.
 *
 * A change to this table ships a migration note for every service.
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
