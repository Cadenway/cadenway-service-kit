import { describe, expect, it } from 'vitest';

import type { EventRoute } from '../../transport/event-route.js';
import { DEFAULT_RETRY_DELAYS_MS } from '../delivery/retry-delays.js';
import { resolveRedelivery, type RedeliveryPolicy } from './redelivery-policy.js';

/**
 * Constant EVENTS_ROUTE
 *
 * @description
 * Route of an event of the events stream, kept seven days.
 *
 * @type {EventRoute}
 */
const EVENTS_ROUTE: EventRoute = {
  stream: 'EVENTS',
  subject: 'evt.member.removed.v1',
  restricted: false,
};

/**
 * Constant RESTRICTED_ROUTE
 *
 * @description
 * Route of a restricted event, kept one hour.
 *
 * @type {EventRoute}
 */
const RESTRICTED_ROUTE: EventRoute = {
  stream: 'EVENTS_RESTRICTED',
  subject: 'restricted.user.sign-in-code-requested.v1',
  restricted: true,
};

/**
 * Constant DAILY_DELAYS_MS
 *
 * @description
 * The schedule the README gives for a security projection: 1 s, 5 s, 30 s, 2 min, 10 min,
 * 30 min, then every hour.
 *
 * @type {readonly number[]}
 */
const DAILY_DELAYS_MS: readonly number[] = [
  1000, 5000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000,
];

describe('resolveRedelivery', () => {
  it('gives a registration without a schedule the default one, five deliveries', () => {
    expect(
      resolveRedelivery(
        'identity-service__project',
        undefined,
        DEFAULT_RETRY_DELAYS_MS,
        EVENTS_ROUTE,
      ),
    ).toEqual({ delaysMs: DEFAULT_RETRY_DELAYS_MS, maxDeliveries: 5, custom: false });
  });

  it('keeps a custom schedule and derives its limit from the delays when it sets none', () => {
    expect(
      resolveRedelivery('identity-service__project', { delaysMs: [10, 20] }, [], EVENTS_ROUTE),
    ).toEqual({ delaysMs: [10, 20], maxDeliveries: 3, custom: true });
  });

  it('accepts the documented schedule of a security projection, which outlasts 24 hours', () => {
    const policy: RedeliveryPolicy = resolveRedelivery(
      'identity-service__project-membership',
      { delaysMs: DAILY_DELAYS_MS, maxDeliveries: 32 },
      DEFAULT_RETRY_DELAYS_MS,
      EVENTS_ROUTE,
    );
    let waited: number = 0;
    for (let failed: number = 1; failed < policy.maxDeliveries; failed += 1) {
      waited += policy.delaysMs[Math.min(failed, policy.delaysMs.length) - 1] ?? 0;
    }

    expect(policy.maxDeliveries).toBe(32);
    expect(waited).toBe(92_556_000);
    expect(waited).toBeGreaterThan(24 * 3_600_000);
  });

  it('accepts a single delivery without delays', () => {
    expect(
      resolveRedelivery(
        'search-service__index',
        { delaysMs: [], maxDeliveries: 1 },
        [],
        EVENTS_ROUTE,
      ),
    ).toEqual({ delaysMs: [], maxDeliveries: 1, custom: true });
  });

  it.each([
    [[0], undefined, /whole numbers of milliseconds from 1/u],
    [[1.5], undefined, /whole numbers of milliseconds from 1/u],
    [[Number.NaN], undefined, /whole numbers of milliseconds from 1/u],
    [[1000], 0, /whole number from 1/u],
    [[1000], 2.5, /whole number from 1/u],
    [[], 3, /without a delay/u],
    [[1000, 2000, 3000], 3, /must exceed its 3 redelivery delays/u],
  ] as const)(
    'refuses the delays %j with %s deliveries before any broker request',
    (delaysMs: readonly number[], maxDeliveries: number | undefined, message: RegExp) => {
      expect(() =>
        resolveRedelivery(
          'identity-service__project',
          maxDeliveries === undefined ? { delaysMs } : { delaysMs, maxDeliveries },
          DEFAULT_RETRY_DELAYS_MS,
          EVENTS_ROUTE,
        ),
      ).toThrow(message);
    },
  );

  it('refuses a schedule that outlasts the retention of the stream, which would drop the message before its dead letter', () => {
    expect(() =>
      resolveRedelivery(
        'notification-service__send-code',
        { delaysMs: DAILY_DELAYS_MS, maxDeliveries: 32 },
        DEFAULT_RETRY_DELAYS_MS,
        RESTRICTED_ROUTE,
      ),
    ).toThrow(/the stream EVENTS_RESTRICTED keeps a message 3600000 ms/u);
    expect(() =>
      resolveRedelivery(
        'identity-service__project',
        { delaysMs: [86_400_000], maxDeliveries: 8 },
        DEFAULT_RETRY_DELAYS_MS,
        EVENTS_ROUTE,
      ),
    ).toThrow(/the stream EVENTS keeps a message 604800000 ms/u);
  });

  it('copies the delays, so a later change of the caller array does not move the schedule', () => {
    const delaysMs: number[] = [10, 20];
    const policy: RedeliveryPolicy = resolveRedelivery(
      'identity-service__project',
      { delaysMs },
      [],
      EVENTS_ROUTE,
    );
    delaysMs[0] = 99;

    expect(policy.delaysMs).toEqual([10, 20]);
  });
});
