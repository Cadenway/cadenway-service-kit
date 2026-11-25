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
  type ConsumerAdvisoryStreamState,
  type ConsumerAdvisoryStreamObservation,
} from './connection/messaging-connection.js';
export type { VersionClaim } from './consumer/delivery/event-deduplicator.js';
export {
  EventConsumers,
  type EventContext,
  type EventRedelivery,
  type EventSubscription,
  type RebuildSubscription,
} from './consumer/event-consumers.js';
export type {
  EventConsumerProgress,
  EventStreamProgress,
} from './consumer/subscriptions/event-stream-progress.js';
export { DeadLetterWorker, type DeadLetterReason } from './dead-letter/dead-letter-worker.js';
export type {
  DistributiveOmit,
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
  type EventValidationIssue,
} from './events/event-validation-error.js';
export { UnknownEventError } from './events/unknown-event-error.js';
export { validateEvent } from './events/event-validation.js';
export {
  DEFAULT_DEAD_LETTER_MAX_AGE_DAYS,
  DEFAULT_DEAD_LETTER_MAX_BYTES,
  DEFAULT_DEAD_LETTER_STREAM,
  DEFAULT_DEAD_LETTER_SUBJECT_PREFIX,
  DEFAULT_EVENT_SUBJECT_PREFIX,
  DEFAULT_EVENTS_MAX_BYTES,
  DEFAULT_EVENTS_STREAM,
  DEFAULT_HANDLER_TIMEOUT_MS,
  DEFAULT_PUBLISH_TIMEOUT_MS,
  DEFAULT_REBUILD_FLUSH_EVERY,
  DEFAULT_REBUILD_MAX_PENDING,
  DEFAULT_REBUILD_SUBJECT_PREFIX,
  DEFAULT_REBUILD_TIMEOUT_MS,
  DEFAULT_RESTRICTED_MAX_BYTES,
  DEFAULT_RESTRICTED_STREAM,
  DEFAULT_RESTRICTED_SUBJECT_PREFIX,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
} from './configuration/messaging-defaults.js';
export { messagingConfigShape, type MessagingConfig } from './configuration/messaging-config.js';
export type {
  DeadLetterAdvisoriesOptions,
  MessagingModuleOptions,
  RebuildAcknowledgement,
  RestrictedDeadLetterPayload,
} from './configuration/messaging-options.js';
export { MessagingModule, type MessagingModuleAsyncOptions } from './wiring/messaging.module.js';
export {
  DEAD_LETTER_CONSUMER_HEADER,
  DEAD_LETTER_DELIVERIES_HEADER,
  DEAD_LETTER_PAYLOAD_HEADER,
  DEAD_LETTER_REASON_HEADER,
  DEAD_LETTER_SEQUENCE_HEADER,
  EVENT_NAME_HEADER,
  ORGANIZATION_ID_HEADER,
  TRACEPARENT_HEADER,
} from './transport/event-headers.js';
export {
  EventPublisher,
  type OutgoingEvent,
  type PublishedEvent,
} from './publisher/event-publisher.js';
export { EventStreamUnavailableError } from './publisher/event-stream-unavailable-error.js';
export { RebuildConsumerUnavailableError } from './rebuild/emitter/rebuild-consumer-unavailable-error.js';
export { RebuildEmitter, type RebuildTarget } from './rebuild/emitter/rebuild-emitter.js';
export { RebuildFlushTimeoutError } from './rebuild/emitter/rebuild-flush-timeout-error.js';
export { RebuildItemError } from './rebuild/emitter/rebuild-item-error.js';
export { RebuildRejectedError } from './rebuild/emitter/rebuild-rejected-error.js';
export type { RebuildRejection } from './rebuild/codec/rebuild-reply-codec.js';
export { durableConsumerName, eventSubject } from './transport/subjects.js';
