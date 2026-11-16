/**
 * Drizzle declarations for service-owned migrations. The outbox includes leased delivery.
 *
 * @packageDocumentation
 */
export { default as eventVersions } from './event-versions.schema.js';
export { finishOutboxLeaseMigration } from './finish-outbox-lease-migration.js';
export { default as outboxEvents } from './leased-outbox-events.schema.js';
export { default as processedEvents } from './processed-events.schema.js';
