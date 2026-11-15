import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  eventRoute,
  messagingConfigShape,
  parseServers,
  resolveMessagingOptions,
  type MessagingConfig,
  type ResolvedMessagingOptions,
} from './messaging-options.js';

describe('messaging options', () => {
  it('applies the documented default of every option left unset', () => {
    const resolved: ResolvedMessagingOptions = resolveMessagingOptions({
      service: 'task-service',
      servers: 'nats://nats:4222',
    });

    expect(resolved).toEqual({
      service: 'task-service',
      servers: ['nats://nats:4222'],
      user: undefined,
      password: undefined,
      connectionName: 'task-service',
      manageStreams: false,
      manageConsumers: true,
      deadLetterWorker: false,
      restrictedEvents: [],
      eventsStream: 'EVENTS',
      restrictedStream: 'EVENTS_RESTRICTED',
      deadLetterStream: 'EVENTS_DLQ',
      eventSubjectPrefix: 'evt',
      restrictedSubjectPrefix: 'restricted',
      deadLetterSubjectPrefix: 'dlq',
      rebuildSubjectPrefix: 'rebuild',
      rebuildName: 'task-service',
      rebuildAcknowledgement: 'none',
      rebuildFlushEvery: 100,
      eventsMaxBytes: 1_073_741_824,
      restrictedMaxBytes: 67_108_864,
      deadLetterMaxBytes: 268_435_456,
      deadLetterMaxAgeDays: 30,
      publishTimeoutMs: 5000,
      shutdownTimeoutMs: 10_000,
      rebuildTimeoutMs: 30_000,
      retryDelaysMs: [1000, 5000, 30_000, 120_000],
    });
  });

  it('keeps the options it is given', () => {
    const resolved: ResolvedMessagingOptions = resolveMessagingOptions({
      service: 'search-service',
      servers: ['nats://a:4222', 'nats://b:4222'],
      user: 'search',
      password: 'fixture',
      manageStreams: true,
      manageConsumers: false,
      deadLetterWorker: true,
      restrictedEvents: ['user.sign-in-code-issued.v1'],
      eventsStream: 'EVENTS_TEST',
      rebuildAcknowledgement: 'reply',
      retryDelaysMs: [10],
    });

    expect(resolved).toMatchObject({
      servers: ['nats://a:4222', 'nats://b:4222'],
      user: 'search',
      manageStreams: true,
      manageConsumers: false,
      deadLetterWorker: true,
      restrictedEvents: ['user.sign-in-code-issued.v1'],
      eventsStream: 'EVENTS_TEST',
      rebuildAcknowledgement: 'reply',
      retryDelaysMs: [10],
    });
  });

  it('receives rebuilds under the NATS user, else the service, unless a rebuild name is given', () => {
    expect(
      resolveMessagingOptions({ service: 'search-service', servers: 'nats://nats:4222' })
        .rebuildName,
    ).toBe('search-service');
    expect(
      resolveMessagingOptions({
        service: 'search-service',
        servers: 'nats://nats:4222',
        user: 'search',
      }).rebuildName,
    ).toBe('search');
    expect(
      resolveMessagingOptions({
        service: 'search-service',
        servers: 'nats://nats:4222',
        user: 'search',
        rebuildName: 'index',
      }).rebuildName,
    ).toBe('index');
  });

  it('refuses a restricted event name that cannot be a subject, a rebuild name of several tokens and a flush count below one', () => {
    expect(() =>
      resolveMessagingOptions({
        service: 'identity-service',
        servers: 'nats://nats:4222',
        restrictedEvents: ['user.>'],
      }),
    ).toThrow(/Invalid event name/u);
    expect(() =>
      resolveMessagingOptions({
        service: 'search-service',
        servers: 'nats://nats:4222',
        rebuildName: 'search.index',
      }),
    ).toThrow(/rebuild name/u);
    expect(() =>
      resolveMessagingOptions({
        service: 'task-service',
        servers: 'nats://nats:4222',
        rebuildFlushEvery: 0,
      }),
    ).toThrow(/flush count/u);
  });

  it('splits several servers given as one comma-separated value', () => {
    expect(parseServers('nats://a:4222, nats://b:4222')).toEqual([
      'nats://a:4222',
      'nats://b:4222',
    ]);
  });

  it('refuses a missing service name, a missing server and empty retry delays', () => {
    expect(() => resolveMessagingOptions({ service: '', servers: 'nats://nats:4222' })).toThrow(
      /service name/u,
    );
    expect(() =>
      resolveMessagingOptions({ service: 'task.service', servers: 'nats://nats:4222' }),
    ).toThrow(/service name/u);
    expect(() => resolveMessagingOptions({ service: 'task-service', servers: ' ' })).toThrow(
      /at least one NATS server/u,
    );
    expect(() =>
      resolveMessagingOptions({
        service: 'task-service',
        servers: 'nats://nats:4222',
        retryDelaysMs: [],
      }),
    ).toThrow(/retry delay/u);
  });
});

describe('eventRoute', () => {
  /**
   * Constant options
   *
   * @description
   * Options of identity-service, which publishes one restricted event.
   *
   * @type {ResolvedMessagingOptions}
   */
  const options: ResolvedMessagingOptions = resolveMessagingOptions({
    service: 'identity-service',
    servers: 'nats://nats:4222',
    restrictedEvents: ['user.sign-in-code-issued.v1'],
  });

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

describe('messagingConfigShape', () => {
  /**
   * Constant schema
   *
   * @description
   * Application schema made of the messaging shape alone.
   *
   * @type {z.ZodType<MessagingConfig>}
   */
  const schema: z.ZodType<MessagingConfig> = z.object(messagingConfigShape);

  it('accepts a NATS URL alone: the user and the password are optional', () => {
    expect(schema.parse({ NATS_URL: 'nats://nats:4222' })).toEqual({
      NATS_URL: 'nats://nats:4222',
    });
  });

  it('accepts several servers and the credentials of the service', () => {
    expect(
      schema.parse({
        NATS_URL: 'nats://nats-1:4222,tls://nats-2:4222',
        NATS_USER: 'task-service',
        NATS_PASSWORD: 'fixture',
      }),
    ).toEqual({
      NATS_URL: 'nats://nats-1:4222,tls://nats-2:4222',
      NATS_USER: 'task-service',
      NATS_PASSWORD: 'fixture',
    });
  });

  it.each([undefined, '', 'nats:4222', 'http://nats:4222', 'nats://nats:4222,'])(
    'refuses the NATS URL %s',
    (url: string | undefined) => {
      expect(schema.safeParse({ NATS_URL: url }).success).toBe(false);
    },
  );

  it('refuses an empty user or password', () => {
    expect(schema.safeParse({ NATS_URL: 'nats://nats:4222', NATS_USER: '' }).success).toBe(false);
    expect(schema.safeParse({ NATS_URL: 'nats://nats:4222', NATS_PASSWORD: '' }).success).toBe(
      false,
    );
  });
});
