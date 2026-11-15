/**
 * Entry point `@cadenway/nest-messaging/outbox`: the outbox table and its writer, the relay that
 * publishes it, and the PostgreSQL deduplicator with its processed-ids and versions tables.
 *
 * Kept apart from the main entry point because `drizzle-orm` and `pg` are optional peers: a
 * gateway without a database never imports this file.
 *
 * @packageDocumentation
 */
export { default as eventVersions } from './event-versions.schema.js';
export { default as outboxEvents } from './outbox-events.schema.js';
export {
  purgeProcessedEvents,
  purgeSentOutboxEvents,
  requeueOutboxEvents,
} from './outbox-maintenance.js';
export {
  DEFAULT_OUTBOX_RETENTION_DAYS,
  DEFAULT_PROCESSED_EVENTS_RETENTION_DAYS,
  type OutboxModuleOptions,
} from './outbox-options.js';
export { OutboxRelay, type RelayPass } from './outbox-relay.js';
export { OutboxWriter, type AppendedEvent } from './outbox-writer.js';
export { OutboxModule, type OutboxModuleAsyncOptions } from './outbox.module.js';
export { PostgresEventDeduplicator } from './postgres-event-deduplicator.js';
export { default as processedEvents } from './processed-events.schema.js';
