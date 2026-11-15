import { describe, expect, it } from 'vitest';

import { ATELIER_NORD, CAMILLE, eventSchemas, type TaskUpdatedV1 } from '../testing/events.js';
import type { EventSchemas } from './event-envelope.js';
import { EventValidationError, UnknownEventError, validateEvent } from './event-validation.js';

/**
 * Constant VALID
 *
 * @description
 * A `task.updated.v1` payload that matches its contract.
 *
 * @type {TaskUpdatedV1}
 */
const VALID: TaskUpdatedV1 = {
  id: '0193a1f0-0000-7000-8000-0000000000e1',
  occurredAt: '2026-11-14T09:30:00.000Z',
  organizationId: ATELIER_NORD,
  actor: { type: 'user', id: CAMILLE },
  version: 3,
  taskId: 'CAD-482',
  changed: ['status'],
};

describe('validateEvent', () => {
  it('returns the payload typed after its event name', () => {
    const payload: TaskUpdatedV1 = validateEvent(eventSchemas, 'task.updated.v1', VALID);

    expect(payload).toEqual(VALID);
  });

  it('names the fields that do not match and never echoes a value', () => {
    let raised: unknown;
    try {
      validateEvent(eventSchemas, 'task.updated.v1', {
        ...VALID,
        actor: { type: 'robot', id: 'secret-actor-value' },
        taskId: '',
        email: 'camille@example.test',
      });
    } catch (error) {
      raised = error;
    }

    expect(raised).toBeInstanceOf(EventValidationError);
    const error: EventValidationError = raised as EventValidationError;
    expect(error.eventName).toBe('task.updated.v1');
    expect(error.issues.map((issue: { path: string }) => issue.path).sort()).toEqual([
      'actor.type',
      'taskId',
    ]);
    expect(error.message).toContain('actor.type');
    expect(JSON.stringify([error.message, error.issues])).not.toMatch(
      /robot|secret-actor-value|camille/u,
    );
  });

  it('refuses a payload of an organization for an event that has none', () => {
    expect(() =>
      validateEvent(eventSchemas, 'user.signed-up.v1', {
        ...VALID,
        userId: CAMILLE,
      }),
    ).toThrow(EventValidationError);
  });

  it('refuses a name that has no validator', () => {
    const schemas: EventSchemas = eventSchemas;

    expect(() => validateEvent(schemas, 'task.archived.v1', VALID)).toThrow(UnknownEventError);
  });
});
