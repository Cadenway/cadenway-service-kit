import { context, propagation, ROOT_CONTEXT, type Context } from '@opentelemetry/api';

/**
 * Constant EVENT_NAME_HEADER
 *
 * @description
 * Message header that carries the name of the event, such as `task.status-changed.v1`.
 *
 * @type {string}
 */
export const EVENT_NAME_HEADER: string = 'Cadenway-Event-Name';

/**
 * Constant ORGANIZATION_ID_HEADER
 *
 * @description
 * Message header that carries the organization of the event. Absent when the event belongs to
 * no organization.
 *
 * @type {string}
 */
export const ORGANIZATION_ID_HEADER: string = 'Cadenway-Organization-Id';

/**
 * Constant TRACEPARENT_HEADER
 *
 * @description
 * Message header that carries the W3C trace context of the work that produced the event.
 *
 * @type {string}
 */
export const TRACEPARENT_HEADER: string = 'traceparent';

/**
 * Constant DEAD_LETTER_CONSUMER_HEADER
 *
 * @description
 * Header of a dead letter: the durable consumer that gave up on the message.
 *
 * @type {string}
 */
export const DEAD_LETTER_CONSUMER_HEADER: string = 'Cadenway-Dead-Letter-Consumer';

/**
 * Constant DEAD_LETTER_REASON_HEADER
 *
 * @description
 * Header of a dead letter: `max-deliveries` or `terminated`.
 *
 * @type {string}
 */
export const DEAD_LETTER_REASON_HEADER: string = 'Cadenway-Dead-Letter-Reason';

/**
 * Constant DEAD_LETTER_SEQUENCE_HEADER
 *
 * @description
 * Header of a dead letter: the sequence of the original message in the events stream.
 *
 * @type {string}
 */
export const DEAD_LETTER_SEQUENCE_HEADER: string = 'Cadenway-Dead-Letter-Stream-Sequence';

/**
 * Constant DEAD_LETTER_DELIVERIES_HEADER
 *
 * @description
 * Header of a dead letter: how many times the message was delivered to the consumer.
 *
 * @type {string}
 */
export const DEAD_LETTER_DELIVERIES_HEADER: string = 'Cadenway-Dead-Letter-Deliveries';

/**
 * Constant DEAD_LETTER_PAYLOAD_HEADER
 *
 * @description
 * Header of a dead letter whose body was not copied: `dropped`. Set on the copy of a restricted
 * event unless `restrictedDeadLetterPayload` is `copy`.
 *
 * @type {string}
 */
export const DEAD_LETTER_PAYLOAD_HEADER: string = 'Cadenway-Dead-Letter-Payload';

/**
 * Interface EventHeadersInput
 *
 * @description
 * What the headers of a published event are built from.
 */
export interface EventHeadersInput {
  // #region Properties
  /**
   * Property name
   *
   * @description
   * Name of the event.
   *
   * @type {string}
   * @readonly
   */
  readonly name: string;

  /**
   * Property organizationId
   *
   * @description
   * Organization of the event, or `null`.
   *
   * @type {string | null}
   * @readonly
   */
  readonly organizationId: string | null;

  /**
   * Property traceparent
   *
   * @description
   * W3C `traceparent` of the work that produced the event, or `null` when it was not traced.
   *
   * @type {string | null}
   * @readonly
   */
  readonly traceparent: string | null;
  // #endregion
}

/**
 * Function buildEventHeaders
 *
 * @description
 * Builds the headers of a published event: its name, its organization when it has one and its
 * trace context when it has one. `Nats-Msg-Id` is set apart, by the publish call.
 *
 * @param {EventHeadersInput} input - Name, organization and trace context of the event.
 * @returns {Record<string, string>} The headers, by name.
 */
export function buildEventHeaders(input: EventHeadersInput): Record<string, string> {
  const headers: Record<string, string> = { [EVENT_NAME_HEADER]: input.name };
  if (input.organizationId !== null) {
    headers[ORGANIZATION_ID_HEADER] = input.organizationId;
  }
  if (input.traceparent !== null) {
    headers[TRACEPARENT_HEADER] = input.traceparent;
  }
  return headers;
}

/**
 * Function currentTraceparent
 *
 * @description
 * Reads the W3C `traceparent` of an OpenTelemetry context through the global propagator, the
 * one `@cadenway/nest-common/telemetry` registers.
 *
 * @param {Context} activeContext - Context to read; defaults to the active one.
 * @returns {string | null} The `traceparent`, or `null` when the context carries no span or no propagator is registered.
 */
export function currentTraceparent(activeContext: Context = context.active()): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(activeContext, carrier);
  return carrier[TRACEPARENT_HEADER] ?? null;
}

/**
 * Function contextFromTraceparent
 *
 * @description
 * Builds the OpenTelemetry context a consumer span is started in: the remote span named by a
 * `traceparent` header becomes its parent.
 *
 * @param {string | null | undefined} traceparent - Value of the `traceparent` header, when the message has one.
 * @returns {Context} A context whose span is the remote parent, or the root context without a usable header.
 */
export function contextFromTraceparent(traceparent: string | null | undefined): Context {
  if (traceparent === undefined || traceparent === null || traceparent === '') {
    return ROOT_CONTEXT;
  }
  return propagation.extract(ROOT_CONTEXT, { [TRACEPARENT_HEADER]: traceparent });
}
