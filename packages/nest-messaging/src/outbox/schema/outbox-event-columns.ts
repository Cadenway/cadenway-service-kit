import { integer, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Build fresh columns for each Drizzle facade. Their inferred types are part of the entry points.
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

/** Shared fresh column builders for both outbox table declarations. */
export function outboxEventColumns<const TStatus extends ['pending', ...string[]], TPayload>(
  statuses: TStatus,
  payload: TPayload,
): ReturnType<typeof makeColumns<TStatus, TPayload>> {
  return makeColumns(statuses, payload);
}
