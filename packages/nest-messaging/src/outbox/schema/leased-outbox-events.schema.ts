import { organizationPolicy } from '@cadenway/nest-common/database';
import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

import type { EventEnvelope } from '../../events/event-envelope.js';
import { outboxEventColumns } from './outbox-event-columns.js';

/** Outbox table declaration for services with the additive leased-relay migration. */
export default pgTable(
  'outbox_events',
  {
    ...outboxEventColumns(
      ['pending', 'leased', 'sent', 'failed'],
      jsonb('payload').$type<EventEnvelope>().notNull(),
    ),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'outbox_events_status_check',
      sql`${table.status} in ('pending', 'leased', 'sent', 'failed')`,
    ),
    check(
      'outbox_events_lease_check',
      sql`(${table.status} = 'leased' and ${table.leaseToken} is not null and ${table.leaseExpiresAt} is not null)
        or (${table.status} <> 'leased' and ${table.leaseToken} is null and ${table.leaseExpiresAt} is null)`,
    ),
    index('outbox_events_pending_index')
      .on(table.nextAttemptAt, table.createdAt)
      .where(sql`${table.status} = 'pending'`),
    index('outbox_events_sent_at_index')
      .on(table.sentAt)
      .where(sql`${table.status} = 'sent'`),
    index('outbox_events_lease_expiry_index')
      .on(table.leaseExpiresAt, table.id)
      .where(sql`${table.status} = 'leased'`),
    organizationPolicy('outbox_events_organization_isolation'),
  ],
);
