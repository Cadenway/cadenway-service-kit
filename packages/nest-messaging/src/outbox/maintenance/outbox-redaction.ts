import type { EventEnvelope } from '../../events/event-envelope.js';
import type { ResolvedMessagingOptions } from '../../configuration/messaging-options.js';

/**
 * Constant REDACTED_PAYLOAD_KEY
 *
 * @description
 * Persisted marker set to `true` when the relay removes a payload. Its name is outside the
 * contracts' camelCase fields and must remain stable across versions to prevent replay.
 *
 * @type {string}
 */
export const REDACTED_PAYLOAD_KEY: string = '$redacted';

/**
 * Constant REDACTED_PAYLOAD_SQL
 *
 * @description
 * Expression for replacing a stored payload with its envelope and redaction marker. Always
 * returns an object so it satisfies the payload's not-null constraint.
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
 * Stream and subject prefix used to identify restricted outbox rows.
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
 * Destination recorded by the writer in the outbox transaction.
 */
export interface StoredRoute {
  // #region Properties
  /**
   * Property subject
   *
   * @description
   * Resolved subject used by the relay instead of deriving it again.
   *
   * @type {string}
   * @readonly
   */
  readonly subject: string;

  /**
   * Property stream
   *
   * @description
   * Stream expected to acknowledge the publish.
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
 * Matches the persisted restricted route by stream or subject prefix. A writer and relay can
 * disagree about the event list during a rollout, so maintenance uses the same route check.
 *
 * @param {RestrictedNames} options - Configured stream and prefix that identify restricted routes.
 * @param {StoredRoute} route - Route persisted by the writer.
 * @returns {boolean} Whether the stored route is restricted.
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
 * Identifies the envelope-only payload of a previously sent event, which cannot be replayed.
 *
 * @param {EventEnvelope | null} payload - Stored event body, which may have been reduced to its envelope.
 * @returns {boolean} Whether the stored payload carries the redaction marker.
 */
export function isRedactedPayload(payload: EventEnvelope | null): boolean {
  return payload !== null && Object.hasOwn(payload, REDACTED_PAYLOAD_KEY);
}
