import type { PubAck } from '@nats-io/jetstream';
import {
  ClosedConnectionError,
  DrainingConnectionError,
  headers,
  RequestError,
  TimeoutError,
  type MsgHdrs,
} from '@nats-io/transport-node';
import { Inject, Injectable } from '@nestjs/common';

import { MessagingConnection } from '../connection/messaging-connection.js';
import type {
  EventDataOf,
  EventEnvelope,
  EventNameOf,
  EventPayloadOf,
  EventSchemas,
} from '../events/event-envelope.js';
import { validateEvent } from '../events/event-validation.js';
import {
  eventRoute,
  MESSAGING_OPTIONS,
  type EventRoute,
  type ResolvedMessagingOptions,
} from '../messaging-options.js';
import { buildEventHeaders, currentTraceparent } from './event-headers.js';
import { uuidv7 } from './uuid-v7.js';

/**
 * Interface OutgoingEvent
 *
 * @description
 * An event ready to be sent: its payload is complete and was validated against its contract.
 */
export interface OutgoingEvent {
  // #region Properties
  /**
   * Property name
   *
   * @description
   * Name of the event in the contracts, from which the subject is derived.
   *
   * @type {string}
   * @readonly
   */
  readonly name: string;

  /**
   * Property payload
   *
   * @description
   * Complete payload, `id` and `occurredAt` included, already validated.
   *
   * @type {EventEnvelope}
   * @readonly
   */
  readonly payload: EventEnvelope;

  /**
   * Property traceparent
   *
   * @description
   * W3C `traceparent` of the work that produced the event, or `null`.
   *
   * @type {string | null}
   * @readonly
   */
  readonly traceparent: string | null;
  // #endregion
}

/**
 * Interface PublishedEvent
 *
 * @description
 * What JetStream acknowledged for a published event.
 */
export interface PublishedEvent {
  // #region Properties
  /**
   * Property id
   *
   * @description
   * Id of the event, also its `Nats-Msg-Id`.
   *
   * @type {string}
   * @readonly
   */
  readonly id: string;

  /**
   * Property stream
   *
   * @description
   * Stream that stored the event.
   *
   * @type {string}
   * @readonly
   */
  readonly stream: string;

  /**
   * Property streamSequence
   *
   * @description
   * Sequence of the event in the stream.
   *
   * @type {number}
   * @readonly
   */
  readonly streamSequence: number;

  /**
   * Property duplicate
   *
   * @description
   * `true` when the server had already stored this id inside its deduplication window and
   * dropped this copy.
   *
   * @type {boolean}
   * @readonly
   */
  readonly duplicate: boolean;
  // #endregion
}

/**
 * Class EventStreamUnavailableError
 *
 * @description
 * Raised by a publish when no stream stores the subject: the events stream does not exist, or
 * JetStream is disabled on the server. The streams are created by the platform, or by
 * `MessagingModule` when `manageStreams` is on.
 */
export class EventStreamUnavailableError extends Error {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Builds the error.
   *
   * @param {string} subject - Subject that no stream stores.
   * @param {string} stream - Stream expected to store it.
   * @param {unknown} cause - Error of the NATS client.
   * @constructor
   */
  public constructor(subject: string, stream: string, cause: unknown) {
    super(
      `No JetStream stream stores the subject ${subject}: the stream ${stream} is missing or JetStream is disabled. ` +
        'The streams are created by the platform, or by MessagingModule with manageStreams.',
      { cause },
    );
    this.name = 'EventStreamUnavailableError';
  }
  // #endregion
}

/**
 * Function isNoResponders
 *
 * @description
 * Tells whether a publish failed because nothing listens on the subject, which for a JetStream
 * publish means that no stream stores it.
 *
 * @param {unknown} error - Error raised by the JetStream publish.
 * @returns {boolean} `true` for a no-responders failure.
 */
function isNoResponders(error: unknown): boolean {
  if (error instanceof RequestError) {
    return error.isNoResponders();
  }
  return (
    error instanceof Error && error.cause instanceof RequestError && error.cause.isNoResponders()
  );
}

/**
 * Function isMessagingUnavailable
 *
 * @description
 * Tells whether a publish failed because NATS or the events stream cannot be reached right now,
 * as opposed to the server refusing that one message. The outbox relay stops its pass on such a
 * failure: the next rows would fail the same way.
 *
 * @param {unknown} error - Error raised by `EventPublisher`.
 * @returns {boolean} `true` for a timeout, a closed or draining connection, or a missing stream.
 */
export function isMessagingUnavailable(error: unknown): boolean {
  return (
    error instanceof EventStreamUnavailableError ||
    error instanceof TimeoutError ||
    error instanceof ClosedConnectionError ||
    error instanceof DrainingConnectionError
  );
}

/**
 * Class EventPublisher
 *
 * @description
 * Publishes events to JetStream on the subject derived from their name, with `Nats-Msg-Id` set
 * to the event id and the event name, organization and trace context in the headers. A publish
 * resolves once JetStream acknowledged the message.
 *
 * `publish` is for an application without a database, such as a gateway: the event is sent at
 * once and is lost if the process dies before the acknowledgement. A service that changes its
 * own data publishes through the outbox (`@cadenway/nest-messaging/outbox`) instead, so the
 * event exists if and only if the use case commits.
 */
@Injectable()
export class EventPublisher {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Stores the connection and the options.
   *
   * @param {MessagingConnection} connection - NATS connection of the application.
   * @param {ResolvedMessagingOptions} options - Options of the module.
   * @constructor
   */
  public constructor(
    private readonly connection: MessagingConnection,
    @Inject(MESSAGING_OPTIONS) private readonly options: ResolvedMessagingOptions,
  ) {}
  // #endregion

  // #region Methods
  /**
   * Method publish
   *
   * @description
   * Completes a payload with a new id (UUID version 7) and the current instant, validates it
   * with the schema of the event, then publishes it and waits for the acknowledgement. The trace
   * context of the caller travels with the event.
   *
   * @param {TSchemas} schemas - `eventSchemas` object of an event module of `@cadenway/contracts`.
   * @param {TName} name - Name of the event.
   * @param {EventDataOf<TSchemas, TName>} data - Payload without `id` and `occurredAt`.
   * @returns {Promise<PublishedEvent>} The acknowledgement of JetStream.
   * @throws {EventValidationError} When the payload does not match its contract; nothing is sent and the payload is not echoed.
   * @throws {EventStreamUnavailableError} When no stream stores the subject.
   * @throws {Error} When the acknowledgement does not arrive in time or the server refuses the message.
   */
  public async publish<TSchemas extends EventSchemas, TName extends EventNameOf<TSchemas>>(
    schemas: TSchemas,
    name: TName,
    data: EventDataOf<TSchemas, TName>,
  ): Promise<PublishedEvent> {
    const payload: EventPayloadOf<TSchemas, TName> = validateEvent(schemas, name, {
      ...data,
      id: uuidv7(),
      occurredAt: new Date().toISOString(),
    });
    return this.publishEnvelope({ name, payload, traceparent: currentTraceparent() });
  }

  /**
   * Method publishEnvelope
   *
   * @description
   * Publishes an event whose payload is already complete and validated, with the trace context
   * it was stored with. The outbox relay uses it; application code calls `publish` or the outbox
   * writer.
   *
   * The subject is derived from the name when the event is published, from the
   * `restrictedEvents` option: `restricted.<name>` for a restricted event, `evt.<name>`
   * otherwise. Publishing the same id again inside the deduplication window of the stream is
   * safe: the server keeps one copy and answers `duplicate`.
   *
   * @param {OutgoingEvent} event - Name, payload and trace context of the event.
   * @returns {Promise<PublishedEvent>} The acknowledgement of JetStream.
   * @throws {EventStreamUnavailableError} When no stream stores the subject.
   * @throws {Error} When the acknowledgement does not arrive in time or the server refuses the message.
   */
  public async publishEnvelope(event: OutgoingEvent): Promise<PublishedEvent> {
    const route: EventRoute = eventRoute(this.options, event.name);
    const subject: string = route.subject;
    const messageHeaders: MsgHdrs = headers();
    const values: Record<string, string> = buildEventHeaders({
      name: event.name,
      organizationId: event.payload.organizationId,
      traceparent: event.traceparent,
    });
    for (const [key, value] of Object.entries(values)) {
      messageHeaders.set(key, value);
    }
    try {
      const acknowledgement: PubAck = await this.connection.jetstream.publish(
        subject,
        JSON.stringify(event.payload),
        {
          msgID: event.payload.id,
          headers: messageHeaders,
          timeout: this.options.publishTimeoutMs,
        },
      );
      return {
        id: event.payload.id,
        stream: acknowledgement.stream,
        streamSequence: acknowledgement.seq,
        duplicate: acknowledgement.duplicate,
      };
    } catch (error) {
      if (isNoResponders(error)) {
        throw new EventStreamUnavailableError(subject, route.stream, error);
      }
      throw error;
    }
  }
  // #endregion
}
