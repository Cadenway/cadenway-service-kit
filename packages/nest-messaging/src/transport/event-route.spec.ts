import { describe, expect, it } from 'vitest';

import { eventRoute, type EventRoutingOptions } from './event-route.js';

describe('eventRoute', () => {
  /**
   * Constant options
   *
   * @description
   * Options of identity-service, which publishes one restricted event.
   *
   * @type {EventRoutingOptions}
   */
  const options: EventRoutingOptions = {
    eventsStream: 'EVENTS',
    restrictedStream: 'EVENTS_RESTRICTED',
    eventSubjectPrefix: 'evt',
    restrictedSubjectPrefix: 'restricted',
    restrictedEvents: ['user.sign-in-code-issued.v1'],
  };

  it('routes an event to evt.<name> in the events stream', () => {
    expect(eventRoute(options, 'user.signed-up.v1')).toEqual({
      subject: 'evt.user.signed-up.v1',
      stream: 'EVENTS',
      restricted: false,
    });
  });

  it('routes a restricted event to restricted.<name> in the restricted stream', () => {
    expect(eventRoute(options, 'user.sign-in-code-issued.v1')).toEqual({
      subject: 'restricted.user.sign-in-code-issued.v1',
      stream: 'EVENTS_RESTRICTED',
      restricted: true,
    });
  });
});
