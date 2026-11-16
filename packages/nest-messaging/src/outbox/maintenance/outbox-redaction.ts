import type { EventEnvelope } from '../../events/event-envelope.js';
import type { ResolvedMessagingOptions } from '../../configuration/messaging-options.js';

/**
 * Constant REDACTED_PAYLOAD_KEY
 *
 * @description
 * Key, set to `true`, that marks the payload of an outbox row the relay redacted. The contracts
 * name their fields in camelCase, so no event field can take this name. The requeue and the relay
 * read it to never publish a redacted payload again. Other versions of the kit read it: it changes
 * only in a major.
 *
 * @type {string}
 */
export const REDACTED_PAYLOAD_KEY: string = '$redacted';

/**
 * Constant REDACTED_PAYLOAD_SQL
 *
 * @description
 * SQL expression of the redacted payload of the row an `update outbox_events` statement changes:
 * the envelope fields every reader of the table relies on (`id`, `occurredAt`, `organizationId`,
 * `actor`, `version`) and the redaction marker, nothing else. It is never null, so the not-null
 * constraint of `payload` cannot fail and echo the row in its error.
 *
 * @type {string}
 */
export const REDACTED_PAYLOAD_SQL: string = `jsonb_build_object(
  'id', payload->'id',
  'occurredAt', payload->'occurredAt',
  'organizationId', payload->'organizationId',
  'actor', payload->'actor',
  'version', payload->'version',
  '${REDACTED_PAYLOAD_KEY}', true
)`;

/**
 * Type RestrictedNames
 *
 * @description
 * The options of the messaging module that make a stored route restricted.
 *
 * @type {Pick<ResolvedMessagingOptions, 'restrictedStream' | 'restrictedSubjectPrefix'>}
 */
export type RestrictedNames = Pick<
  ResolvedMessagingOptions,
  'restrictedStream' | 'restrictedSubjectPrefix'
>;

/**
 * Interface StoredRoute
 *
 * @description
 * Route the writer stored with an outbox row.
 */
export interface StoredRoute {
  // #region Properties
  /**
   * Property subject
   *
   * @description
   * Subject of the row.
   *
   * @type {string}
   * @readonly
   */
  readonly subject: string;

  /**
   * Property stream
   *
   * @description
   * Stream of the row.
   *
   * @type {string}
   * @readonly
   */
  readonly stream: string;
  // #endregion
}

/**
 * Function isRestrictedRoute
 *
 * @description
 * Tells whether the route stored with an outbox row is the restricted one: the restricted stream,
 * or a subject under the restricted prefix. It reads the stored route, never `restrictedEvents`,
 * so a replica that does not list the event yet still treats its row as restricted. The SQL of
 * Automatic maintenance applies the same predicate to legacy sent rows.
 *
 * @param {RestrictedNames} options - Restricted stream and subject prefix of the module.
 * @param {StoredRoute} route - Subject and stream of the row.
 * @returns {boolean} `true` for a restricted row.
 */
export function isRestrictedRoute(options: RestrictedNames, route: StoredRoute): boolean {
  return (
    route.stream === options.restrictedStream ||
    route.subject.startsWith(`${options.restrictedSubjectPrefix}.`)
  );
}

/**
 * Function isRedactedPayload
 *
 * @description
 * Tells whether an outbox payload was redacted by the relay: its event was published once and its
 * content is gone, so it can never be published again. A value that is not an object, which only
 * a hand-written row can hold, is not redacted: its publish fails like any invalid row.
 *
 * @param {EventEnvelope | null} payload - Payload read from the outbox.
 * @returns {boolean} `true` when the payload carries the redaction marker.
 */
export function isRedactedPayload(payload: EventEnvelope | null): boolean {
  return payload !== null && Object.hasOwn(payload, REDACTED_PAYLOAD_KEY);
}
