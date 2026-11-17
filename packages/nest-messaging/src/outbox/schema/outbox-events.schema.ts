import { organizationPolicy } from '@cadenway/nest-common/database';
import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable } from 'drizzle-orm/pg-core';

import type { EventEnvelope } from '../../events/event-envelope.js';
import { outboxEventColumns } from './outbox-event-columns.js';

/**
 * Constant outboxEvents
 *
 * @description
 * Legacy outbox rows, written in the transaction that produces the event. The relay publishes
 * the stored subject and stream after commit, using the row's event ID as `Nats-Msg-Id`.
 *
 * The relay backs off after publication failures and parks a row after 20 failed attempts.
 * Sent rows remain available for replay during retention. Marking a restricted row sent also
 * replaces its payload with the event envelope and `"$redacted": true`, which prevents replay.
 *
 * The service migration forces row-level security. An event without an organization requires
 * a system transaction.
 */
export default pgTable(
  'outbox_events',
  outboxEventColumns(
    ['pending', 'sent', 'failed'],
    jsonb('payload').$type<EventEnvelope>().notNull(),
  ),
  (table) => [
    check('outbox_events_status_check', sql`${table.status} in ('pending', 'sent', 'failed')`),
    index('outbox_events_pending_index')
      .on(table.nextAttemptAt, table.createdAt)
      .where(sql`${table.status} = 'pending'`),
    index('outbox_events_sent_at_index')
      .on(table.sentAt)
      .where(sql`${table.status} = 'sent'`),
    organizationPolicy('outbox_events_organization_isolation'),
  ],
);
