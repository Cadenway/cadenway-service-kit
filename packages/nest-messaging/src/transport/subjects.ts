/**
 * Constant SUBJECT_PATTERN
 *
 * @description
 * Shape of a name that becomes part of a NATS subject: dot-separated tokens of letters, digits,
 * hyphens and underscores. No wildcard, no whitespace, no empty token.
 *
 * @type {RegExp}
 */
const SUBJECT_PATTERN: RegExp = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u;

/**
 * Constant TOKEN_PATTERN
 *
 * @description
 * Shape of a single subject token, also the shape of each half of a durable consumer name:
 * JetStream refuses a dot, a wildcard or whitespace in a consumer name.
 *
 * @type {RegExp}
 */
const TOKEN_PATTERN: RegExp = /^[A-Za-z0-9_-]+$/u;

/**
 * Function assertSubject
 *
 * @description
 * Checks that a value can be embedded in a subject without changing what the subject matches.
 *
 * @param {string} value - Value to check.
 * @param {string} label - What the value is, for the error text.
 * @throws {Error} When the value is empty or holds a wildcard, whitespace or an empty token.
 */
function assertSubject(value: string, label: string): void {
  if (!SUBJECT_PATTERN.test(value)) {
    throw new Error(
      `Invalid ${label} "${value}": expected dot-separated tokens of letters, digits, hyphens and underscores.`,
    );
  }
}

/**
 * Function assertToken
 *
 * @description
 * Checks that a value is one subject token.
 *
 * @param {string} value - Value to check.
 * @param {string} label - What the value is, for the error text.
 * @throws {Error} When the value is empty or holds anything but letters, digits, hyphens and underscores.
 */
function assertToken(value: string, label: string): void {
  if (!TOKEN_PATTERN.test(value)) {
    throw new Error(
      `Invalid ${label} "${value}": expected letters, digits, hyphens and underscores only.`,
    );
  }
}

/**
 * Function eventSubject
 *
 * @description
 * Derives the subject of an event from its contract name: `evt.task.status-changed.v1` for
 * `task.status-changed.v1`. Subjects are derived here and never typed by hand.
 *
 * @param {string} prefix - Subject prefix of the events, `evt` by default.
 * @param {string} eventName - Name of the event in the contracts.
 * @returns {string} The subject.
 * @throws {Error} When the prefix or the name cannot be part of a subject.
 */
export function eventSubject(prefix: string, eventName: string): string {
  assertSubject(prefix, 'event subject prefix');
  assertSubject(eventName, 'event name');
  return `${prefix}.${eventName}`;
}

/**
 * Function deadLetterSubject
 *
 * @description
 * Derives the subject a dead letter is copied to, `dlq.<consumer>.<original subject>`:
 * `dlq.search-service__index-task.evt.task.status-changed.v1` for a message of
 * `evt.task.status-changed.v1` the consumer `search-service__index-task` gave up on.
 *
 * @param {string} prefix - Subject prefix of the dead letters, `dlq` by default.
 * @param {string} consumer - Durable consumer that gave up on the message.
 * @param {string} originalSubject - Subject the message was first published on.
 * @returns {string} The dead-letter subject.
 * @throws {Error} When a part cannot be part of a subject.
 */
export function deadLetterSubject(
  prefix: string,
  consumer: string,
  originalSubject: string,
): string {
  assertSubject(prefix, 'dead-letter subject prefix');
  assertToken(consumer, 'consumer name');
  assertSubject(originalSubject, 'original subject');
  return `${prefix}.${consumer}.${originalSubject}`;
}

/**
 * Function rebuildSubject
 *
 * @description
 * Derives the subject an owner re-emits the current state of an entity on, for one consumer:
 * `rebuild.search.task`. The consumer is named by its rebuild name, its NATS user by default.
 *
 * @param {string} prefix - Subject prefix of the rebuilds, `rebuild` by default.
 * @param {string} consumer - Rebuild name of the consumer, usually its NATS user.
 * @param {string} entity - Name of the entity re-emitted.
 * @returns {string} The subject.
 * @throws {Error} When a part cannot be a subject token.
 */
export function rebuildSubject(prefix: string, consumer: string, entity: string): string {
  assertSubject(prefix, 'rebuild subject prefix');
  assertToken(consumer, 'rebuild consumer');
  assertToken(entity, 'rebuild entity');
  return `${prefix}.${consumer}.${entity}`;
}

/**
 * Function durableConsumerName
 *
 * @description
 * Derives the name of the durable pull consumer of a handler: `<service>__<handler>`, such as
 * `search-service__index-task`.
 *
 * @param {string} service - Name of the consuming service.
 * @param {string} handler - Name of the handler inside the service.
 * @returns {string} The consumer name.
 * @throws {Error} When a part holds anything but letters, digits, hyphens and underscores.
 */
export function durableConsumerName(service: string, handler: string): string {
  assertToken(service, 'service name');
  assertToken(handler, 'handler name');
  return `${service}__${handler}`;
}

/**
 * Function maxDeliveriesAdvisorySubject
 *
 * @description
 * Subject of the advisories JetStream publishes when a message of a stream reached the delivery
 * limit of a consumer, for every consumer of the stream.
 *
 * @param {string} stream - Name of the stream.
 * @returns {string} The advisory subject, ending with a wildcard for the consumer name.
 */
export function maxDeliveriesAdvisorySubject(stream: string): string {
  assertToken(stream, 'stream name');
  return `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.${stream}.>`;
}

/**
 * Function terminatedAdvisorySubject
 *
 * @description
 * Subject of the advisories JetStream publishes when a consumer of a stream terminated a
 * message, for every consumer of the stream.
 *
 * @param {string} stream - Name of the stream.
 * @returns {string} The advisory subject, ending with a wildcard for the consumer name.
 */
export function terminatedAdvisorySubject(stream: string): string {
  assertToken(stream, 'stream name');
  return `$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.${stream}.>`;
}

/**
 * Function deadLetterMessageId
 *
 * @description
 * Derives the `Nats-Msg-Id` of a dead letter from the consumer that gave up and the sequence of
 * the message, so an advisory received twice is stored once.
 *
 * @param {string} stream - Stream the message was read from.
 * @param {string} consumer - Durable consumer that gave up.
 * @param {number} streamSequence - Sequence of the message in the stream.
 * @returns {string} The message id.
 */
export function deadLetterMessageId(
  stream: string,
  consumer: string,
  streamSequence: number,
): string {
  return `${stream}.${consumer}.${String(streamSequence)}`;
}
