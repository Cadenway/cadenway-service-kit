/**
 * Public entry point of `@cadenway/nest-messaging`: the NATS JetStream connection, the event
 * publisher, the event consumers with retries, the dead-letter worker and the rebuild emitter.
 * Everything a consumer may import is listed here by name.
 *
 * This entry point needs no database. The outbox table, its relay and the PostgreSQL
 * deduplicator live in `@cadenway/nest-messaging/outbox`, because `drizzle-orm` and `pg` are
 * optional peers: a gateway without a database never imports that file.
 *
 * @packageDocumentation
 */
export {
  MessagingConnection,
  messagingHealthIndicator,
} from './connection/messaging-connection.js';
export {
  EVENT_DEDUPLICATOR,
  type DeduplicationOutcome,
  type EventDeduplicator,
  type EventDelivery,
  type VersionClaim,
} from './consumer/event-deduplicator.js';
export {
  EventConsumers,
  type EventContext,
  type EventSubscription,
  type RebuildSubscription,
} from './consumer/event-consumers.js';
export { DEFAULT_RETRY_DELAYS_MS } from './consumer/retry-delays.js';
export { DeadLetterWorker, type DeadLetterReason } from './dead-letter/dead-letter-worker.js';
export type {
  EventActor,
  EventActorType,
  EventDataOf,
  EventEnvelope,
  EventNameOf,
  EventPayloadOf,
  EventSchemas,
} from './events/event-envelope.js';
export {
  EventValidationError,
  UnknownEventError,
  validateEvent,
  type EventValidationIssue,
} from './events/event-validation.js';
export {
  DEFAULT_DEAD_LETTER_MAX_AGE_DAYS,
  DEFAULT_DEAD_LETTER_MAX_BYTES,
  DEFAULT_DEAD_LETTER_STREAM,
  DEFAULT_DEAD_LETTER_SUBJECT_PREFIX,
  DEFAULT_EVENT_SUBJECT_PREFIX,
  DEFAULT_EVENTS_MAX_BYTES,
  DEFAULT_EVENTS_STREAM,
  DEFAULT_PUBLISH_TIMEOUT_MS,
  DEFAULT_REBUILD_FLUSH_EVERY,
  DEFAULT_REBUILD_SUBJECT_PREFIX,
  DEFAULT_REBUILD_TIMEOUT_MS,
  DEFAULT_RESTRICTED_MAX_BYTES,
  DEFAULT_RESTRICTED_STREAM,
  DEFAULT_RESTRICTED_SUBJECT_PREFIX,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  eventRoute,
  MESSAGING_OPTIONS,
  messagingConfigShape,
  type EventRoute,
  type MessagingConfig,
  type MessagingModuleOptions,
  type RebuildAcknowledgement,
  type ResolvedMessagingOptions,
} from './messaging-options.js';
export { MessagingModule, type MessagingModuleAsyncOptions } from './messaging.module.js';
export {
  DEAD_LETTER_CONSUMER_HEADER,
  DEAD_LETTER_DELIVERIES_HEADER,
  DEAD_LETTER_REASON_HEADER,
  DEAD_LETTER_SEQUENCE_HEADER,
  EVENT_NAME_HEADER,
  ORGANIZATION_ID_HEADER,
  TRACEPARENT_HEADER,
} from './publisher/event-headers.js';
export {
  EventPublisher,
  EventStreamUnavailableError,
  type OutgoingEvent,
  type PublishedEvent,
} from './publisher/event-publisher.js';
export {
  RebuildConsumerUnavailableError,
  RebuildEmitter,
  RebuildItemError,
  RebuildRejectedError,
  type RebuildRejection,
} from './rebuild/rebuild-emitter.js';
export { durableConsumerName, eventSubject } from './subjects.js';
