/**
 * Entry point `@cadenway/nest-messaging/outbox`: the outbox table and its writer, the relay that
 * publishes it, and the PostgreSQL deduplicator with its processed-ids and versions tables.
 *
 * Kept apart from the main entry point because `drizzle-orm` and `pg` are optional peers: a
 * gateway without a database never imports this file.
 *
 * @packageDocumentation
 * @deprecated Use the writer, relay, schema and PostgreSQL consumer subpaths to compose new deployments.
 */
export { default as eventVersions } from './schema/event-versions.schema.js';
export { default as outboxEvents } from './schema/outbox-events.schema.js';
export {
  purgeProcessedEvents,
  purgeSentOutboxEvents,
  requeueOutboxEvents,
} from './maintenance/outbox-maintenance.js';
export {
  DEFAULT_OUTBOX_RETENTION_DAYS,
  DEFAULT_PROCESSED_EVENTS_RETENTION_DAYS,
  type OutboxModuleOptions,
} from './wiring/outbox-options.js';
export { OutboxRelay, type RelayPass } from './relay/outbox-relay.js';
export { OutboxWriter, type AppendedEvent } from './writer/outbox-writer.js';
export { OutboxModule, type OutboxModuleAsyncOptions } from './wiring/outbox.module.js';
export { PostgresEventDeduplicator } from '../consumer/postgres/postgres-event-deduplicator.js';
export { default as processedEvents } from './schema/processed-events.schema.js';
