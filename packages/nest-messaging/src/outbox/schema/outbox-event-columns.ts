import { integer, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Function makeColumns
 *
 * @description
 * Builds fresh column instances for each Drizzle facade so one declaration cannot mutate the other.
 *
 * @param {TStatus} statuses - Permitted outbox states starting with the insertion default.
 * @param {TPayload} payload - JSON column builder supplied by the table declaration.
 * @returns {ReturnType<typeof makeColumns<TStatus, TPayload>>} Fresh PostgreSQL column builders for one table declaration.
 */
const makeColumns = <const TStatus extends ['pending', ...string[]], TPayload>(
  statuses: TStatus,
  payload: TPayload,
) => ({
  id: uuid('id').primaryKey(),
  eventName: text('event_name').notNull(),
  subject: text('subject').notNull(),
  stream: text('stream').notNull(),
  organizationId: uuid('organization_id'),
  payload,
  traceparent: text('traceparent'),
  status: text('status', { enum: statuses }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
});

/**
 * Function outboxEventColumns
 *
 * @description
 * Shared fresh column builders for both outbox table declarations.
 *
 * @param {TStatus} statuses - Permitted outbox states starting with the insertion default.
 * @param {TPayload} payload - JSON column builder supplied by the table declaration.
 * @returns {ReturnType<typeof makeColumns<TStatus, TPayload>>} Fresh column builders preserving the supplied status and payload types.
 */
export function outboxEventColumns<const TStatus extends ['pending', ...string[]], TPayload>(
  statuses: TStatus,
  payload: TPayload,
): ReturnType<typeof makeColumns<TStatus, TPayload>> {
  return makeColumns(statuses, payload);
}
