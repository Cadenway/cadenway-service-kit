import { describe, expect, it } from 'vitest';

import { ATELIER_NORD } from '../testing/events.js';
import {
  buildEventHeaders,
  EVENT_NAME_HEADER,
  ORGANIZATION_ID_HEADER,
  TRACEPARENT_HEADER,
} from './event-headers.js';

/**
 * Constant TRACEPARENT
 *
 * @description
 * W3C trace context of the fixtures: a sampled span of a known trace.
 *
 * @type {string}
 */
const TRACEPARENT: string = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

describe('event headers', () => {
  it('carries the event name, the organization and the trace context', () => {
    expect(
      buildEventHeaders({
        name: 'task.updated.v1',
        organizationId: ATELIER_NORD,
        traceparent: TRACEPARENT,
      }),
    ).toEqual({
      [EVENT_NAME_HEADER]: 'task.updated.v1',
      [ORGANIZATION_ID_HEADER]: ATELIER_NORD,
      [TRACEPARENT_HEADER]: TRACEPARENT,
    });
  });

  it('leaves out the organization of an event that has none, and an absent trace context', () => {
    expect(
      buildEventHeaders({ name: 'user.signed-up.v1', organizationId: null, traceparent: null }),
    ).toEqual({ [EVENT_NAME_HEADER]: 'user.signed-up.v1' });
  });
});
