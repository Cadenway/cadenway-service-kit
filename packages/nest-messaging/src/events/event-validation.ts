import type { z } from 'zod';

import type { EventEnvelope, EventNameOf, EventPayloadOf, EventSchemas } from './event-envelope.js';

/**
 * Interface EventValidationIssue
 *
 * @description
 * One reason a payload does not match its contract. It names the field and the kind of mismatch
 * and never carries a value of the payload.
 */
export interface EventValidationIssue {
  // #region Properties
  /**
   * Property path
   *
   * @description
   * Dotted path of the field, such as `actor.type`; empty for the payload itself.
   *
   * @type {string}
   * @readonly
   */
  readonly path: string;

  /**
   * Property code
   *
   * @description
   * Zod issue code, such as `invalid_type`.
   *
   * @type {string}
   * @readonly
   */
  readonly code: string;
  // #endregion
}

/**
 * Class EventValidationError
 *
 * @description
 * Raised when a payload does not match the zod schema of its event, on publish and on receipt.
 * Its message and its issues name fields only: the payload is never echoed, so the error is safe
 * to log.
 */
export class EventValidationError extends Error {
  // #region Properties
  /**
   * Property eventName
   *
   * @description
   * Name of the event whose contract was not met.
   *
   * @type {string}
   * @readonly
   */
  public readonly eventName: string;

  /**
   * Property issues
   *
   * @description
   * Fields that do not match, without their values.
   *
   * @type {readonly EventValidationIssue[]}
   * @readonly
   */
  public readonly issues: readonly EventValidationIssue[];
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Builds the error from the fields that do not match.
   *
   * @param {string} eventName - Name of the event.
   * @param {readonly EventValidationIssue[]} issues - Fields that do not match.
   * @constructor
   */
  public constructor(eventName: string, issues: readonly EventValidationIssue[]) {
    const fields: string = issues
      .map((issue: EventValidationIssue) => `${issue.path || '(payload)'}: ${issue.code}`)
      .join(', ');
    super(`The payload of the event ${eventName} does not match its contract (${fields}).`);
    this.name = 'EventValidationError';
    this.eventName = eventName;
    this.issues = issues;
  }
  // #endregion
}

/**
 * Class UnknownEventError
 *
 * @description
 * Raised when an event name has no validator in the `eventSchemas` object it was given with: a
 * programming error the types normally prevent.
 */
export class UnknownEventError extends Error {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Builds the error.
   *
   * @param {string} eventName - Name that has no validator.
   * @constructor
   */
  public constructor(eventName: string) {
    super(`The event ${eventName} has no validator in the given event schemas.`);
    this.name = 'UnknownEventError';
  }
  // #endregion
}

/**
 * Function validateEvent
 *
 * @description
 * Validates a payload with the zod schema of its event and returns it typed.
 *
 * @param {TSchemas} schemas - `eventSchemas` object of an event module of the contracts.
 * @param {TName} name - Name of the event.
 * @param {unknown} candidate - Payload to validate.
 * @returns {EventPayloadOf<TSchemas, TName>} The payload, as the validator returns it.
 * @throws {UnknownEventError} When the name has no validator in `schemas`.
 * @throws {EventValidationError} When the payload does not match; the error never echoes it.
 */
export function validateEvent<TSchemas extends EventSchemas, TName extends EventNameOf<TSchemas>>(
  schemas: TSchemas,
  name: TName,
  candidate: unknown,
): EventPayloadOf<TSchemas, TName> {
  const schema: z.ZodType<EventEnvelope> | undefined = (schemas as EventSchemas)[name];
  if (schema === undefined) {
    throw new UnknownEventError(name);
  }
  const result: z.ZodSafeParseResult<EventEnvelope> = schema.safeParse(candidate);
  if (!result.success) {
    throw new EventValidationError(
      name,
      result.error.issues.map((issue: z.core.$ZodIssue): EventValidationIssue => ({
        path: issue.path.map(String).join('.'),
        code: issue.code,
      })),
    );
  }
  return result.data as EventPayloadOf<TSchemas, TName>;
}
