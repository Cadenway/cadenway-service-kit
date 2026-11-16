import type { z } from 'zod';

import type { EventEnvelope, EventNameOf, EventPayloadOf, EventSchemas } from './event-envelope.js';
import { EventValidationError, type EventValidationIssue } from './event-validation-error.js';
import { UnknownEventError } from './unknown-event-error.js';

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
