import { eventSubject } from './subjects.js';

/**
 * Interface EventRoutingOptions
 *
 * @description
 * Stream names, subject prefixes and restricted event names used to route an event.
 */
export interface EventRoutingOptions {
  // #region Properties
  /** Stream for ordinary events. */
  readonly eventsStream: string;

  /** Stream for restricted events. */
  readonly restrictedStream: string;

  /** First token of ordinary event subjects. */
  readonly eventSubjectPrefix: string;

  /** First token of restricted event subjects. */
  readonly restrictedSubjectPrefix: string;

  /** Names that use the restricted route. */
  readonly restrictedEvents: readonly string[];
  // #endregion
}

/**
 * Interface EventRoute
 *
 * @description
 * Where an event travels: its subject and the stream that stores it.
 */
export interface EventRoute {
  // #region Properties
  /**
   * Property subject
   *
   * @description
   * Subject of the event: `evt.<name>`, or `restricted.<name>` for a restricted event.
   *
   * @type {string}
   * @readonly
   */
  readonly subject: string;

  /**
   * Property stream
   *
   * @description
   * Stream that stores the event: the events stream, or the restricted stream.
   *
   * @type {string}
   * @readonly
   */
  readonly stream: string;

  /**
   * Property restricted
   *
   * @description
   * Whether the event is listed in `restrictedEvents`.
   *
   * @type {boolean}
   * @readonly
   */
  readonly restricted: boolean;
  // #endregion
}

/**
 * Function eventRoute
 *
 * @description
 * Derives the subject and the stream of an event from its name and the options of the module.
 * The publisher, the outbox writer and the consumers all route through it. The relay publishes
 * on the subject and stream persisted by the writer.
 *
 * @param {EventRoutingOptions} options - Streams, prefixes and restricted event names.
 * @param {string} eventName - Name of the event in the contracts.
 * @returns {EventRoute} The subject and the stream.
 * @throws {Error} When the name cannot be part of a subject.
 */
export function eventRoute(options: EventRoutingOptions, eventName: string): EventRoute {
  const restricted: boolean = options.restrictedEvents.includes(eventName);
  return restricted
    ? {
        subject: eventSubject(options.restrictedSubjectPrefix, eventName),
        stream: options.restrictedStream,
        restricted,
      }
    : {
        subject: eventSubject(options.eventSubjectPrefix, eventName),
        stream: options.eventsStream,
        restricted,
      };
}
