import { describe, expect, it } from 'vitest';

import type { EventEnvelope } from '../../events/event-envelope.js';
import { resolveMessagingOptions } from '../../configuration/resolve-messaging-options.js';
import type { ResolvedMessagingOptions } from '../../configuration/messaging-options.js';
import { isRedactedPayload, isRestrictedRoute, REDACTED_PAYLOAD_KEY } from './outbox-redaction.js';

/**
 * Constant OPTIONS
 *
 * @description
 * Options of a service with the default stream names and prefixes.
 *
 * @type {ResolvedMessagingOptions}
 */
const OPTIONS: ResolvedMessagingOptions = resolveMessagingOptions({
  service: 'identity-service',
  servers: 'nats://localhost:4222',
});

/**
 * Constant ENVELOPE
 *
 * @description
 * Envelope of an event without an organization.
 *
 * @type {EventEnvelope}
 */
const ENVELOPE: EventEnvelope = {
  id: '0193a1f0-0000-7000-8000-0000000000e1',
  occurredAt: '2026-11-15T10:00:00.000Z',
  organizationId: null,
  actor: { type: 'system', id: 'identity-service' },
  version: 1,
};

describe('isRestrictedRoute', () => {
  it('reads the stored route: the restricted stream or a subject under the restricted prefix', () => {
    expect(
      isRestrictedRoute(OPTIONS, {
        subject: 'restricted.one-time-code.issued.v1',
        stream: 'EVENTS_RESTRICTED',
      }),
    ).toBe(true);
    expect(
      isRestrictedRoute(OPTIONS, {
        subject: 'restricted.one-time-code.issued.v1',
        stream: 'OTHER',
      }),
    ).toBe(true);
    expect(
      isRestrictedRoute(OPTIONS, { subject: 'evt.user.signed-up.v1', stream: 'EVENTS_RESTRICTED' }),
    ).toBe(true);
  });

  it('leaves an event of the events stream alone, even when its name starts like the prefix', () => {
    expect(isRestrictedRoute(OPTIONS, { subject: 'evt.user.signed-up.v1', stream: 'EVENTS' })).toBe(
      false,
    );
    expect(
      isRestrictedRoute(OPTIONS, { subject: 'restricted-evt.task.updated.v1', stream: 'EVENTS' }),
    ).toBe(false);
  });
});

describe('isRedactedPayload', () => {
  it('recognizes the marker the relay adds, and only it', () => {
    expect(isRedactedPayload({ ...ENVELOPE, [REDACTED_PAYLOAD_KEY]: true })).toBe(true);
    expect(isRedactedPayload(ENVELOPE)).toBe(false);
    expect(isRedactedPayload(null)).toBe(false);
    expect(isRedactedPayload({ ...ENVELOPE, redacted: true } as EventEnvelope)).toBe(false);
  });
});
