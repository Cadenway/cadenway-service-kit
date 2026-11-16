import { organizationPolicy } from '@cadenway/nest-common/database';
import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable } from 'drizzle-orm/pg-core';

import type { EventEnvelope } from '../../events/event-envelope.js';
import { outboxEventColumns } from './outbox-event-columns.js';

/**
 * Table `outbox_events`, published as `outboxEvents` by the `/outbox` entry point.
 *
 * One row per event a use case decided to publish, written in the transaction of that use case:
 * the row exists if and only if the use case committed. `id` is the event id, assigned by
 * PostgreSQL (`uuidv7()`) and sent as `Nats-Msg-Id`. `subject` and `stream` are the route the
 * writer decided (`evt.<name>` in `EVENTS`, or `restricted.<name>` in `EVENTS_RESTRICTED`): the
 * relay publishes them as they are, so a replica configured differently cannot move a restricted
 * event. `status` is `pending` until the relay published the event, then `sent`; a row that
 * failed 20 times is parked as `failed`. `attempts` counts the failed attempts, `next_attempt_at`
 * delays the next one with an exponential backoff, and `last_error` holds the class of the last
 * failure, never a payload. Sent rows are kept seven days so they can be published again after
 * a NATS loss, except the restricted ones: the statement that marks a restricted row sent
 * replaces its payload with its envelope (`id`, `occurredAt`, `organizationId`, `actor`,
 * `version`) and `"$redacted": true`, so the single-use code or link it carried is gone, and such
 * a row is never published again. `organization_id` is null for an event outside any
 * organization, which only a system transaction can write.
 *
 * The table carries the organization policy like any tenant table; the migration of the service
 * adds `ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY`.
 *
 * It is a default export so that its column types stay inferred: the repository requires an
 * explicit type on every variable, and spelling the column map by hand would duplicate this
 * definition and drift from it.
 *
 * A change to this table ships a migration note for every service.
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
