import { organizationPolicy } from '@cadenway/nest-common/database';
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import type { EventEnvelope } from '../events/event-envelope.js';

/**
 * Table `outbox_events`, published as `outboxEvents` by the `/outbox` entry point.
 *
 * One row per event a use case decided to publish, written in the transaction of that use case:
 * the row exists if and only if the use case committed. `id` is the event id, assigned by
 * PostgreSQL (`uuidv7()`) and sent as `Nats-Msg-Id`. `status` is `pending` until the relay
 * published the event, then `sent`; sent rows are kept seven days so they can be published again
 * after a NATS loss. `attempts` counts the publish attempts and `last_error` holds the class of
 * the last failure, never a payload. `organization_id` is null for an event outside any
 * organization, which only a system transaction can write.
 *
 * The pending index orders by attempts then age, the order the relay reads in. The table carries
 * the organization policy like any tenant table; the migration of the service adds
 * `ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY`.
 *
 * It is a default export so that its column types stay inferred: the repository requires an
 * explicit type on every variable, and spelling the column map by hand would duplicate this
 * definition and drift from it.
 *
 * A change to this table ships a migration note for every service.
 */
export default pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey(),
    eventName: text('event_name').notNull(),
    organizationId: uuid('organization_id'),
    payload: jsonb('payload').$type<EventEnvelope>().notNull(),
    traceparent: text('traceparent'),
    status: text('status', { enum: ['pending', 'sent'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (table) => [
    check('outbox_events_status_check', sql`${table.status} in ('pending', 'sent')`),
    index('outbox_events_pending_index')
      .on(table.attempts, table.createdAt)
      .where(sql`${table.status} = 'pending'`),
    index('outbox_events_sent_at_index')
      .on(table.sentAt)
      .where(sql`${table.status} = 'sent'`),
    organizationPolicy('outbox_events_organization_isolation'),
  ],
);
