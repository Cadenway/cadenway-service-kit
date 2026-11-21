import { describe, expect, it } from 'vitest';

import type { ResolvedMessagingOptions } from './messaging-options.js';
import { DEFAULT_MESSAGING_TUNING } from './messaging-tuning.js';
import { parseServers, resolveMessagingOptions } from './resolve-messaging-options.js';

describe('dead-letter advisory inbox options', () => {
  it('requires an enabled worker and normalizes the advisory servers independently', () => {
    const options = {
      service: 'test-service',
      servers: 'nats://events:4222',
      deadLetterAdvisories: {
        stream: 'EVENTS_ADVISORIES',
        durable: 'advisory-reader',
        servers: ' nats://inbox-a:4222, nats://inbox-b:4222 ',
      },
    };
    expect(() => resolveMessagingOptions(options)).toThrow(/advisory inbox/u);
    const resolved = resolveMessagingOptions({ ...options, deadLetterWorker: true });
    expect(resolved.servers).toEqual(['nats://events:4222']);
    expect(resolved.deadLetterAdvisories?.servers).toEqual([
      'nats://inbox-a:4222',
      'nats://inbox-b:4222',
    ]);
    expect(() =>
      resolveMessagingOptions({
        ...options,
        deadLetterWorker: true,
        deadLetterAdvisories: { ...options.deadLetterAdvisories, durable: 'wrong.*' },
      }),
    ).toThrow(/advisory inbox/u);
  });
});

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
      rebuildMaxPending: 1000,
      handlerTimeoutMs: 25_000,
      restrictedDeadLetterPayload: 'drop',
      eventsMaxBytes: 1_073_741_824,
      restrictedMaxBytes: 67_108_864,
      deadLetterMaxBytes: 268_435_456,
      deadLetterMaxAgeDays: 30,
      publishTimeoutMs: 5000,
      shutdownTimeoutMs: 10_000,
      rebuildTimeoutMs: 30_000,
    });
  });

  it('keeps the retry delays out of the public options: the consumers follow the production delays', () => {
    expect(DEFAULT_MESSAGING_TUNING.retryDelaysMs).toEqual([1000, 5000, 30_000, 120_000]);
    expect(
      Object.keys(resolveMessagingOptions({ service: 'task-service', servers: 'nats://n:4222' })),
    ).not.toContain('retryDelaysMs');
  });

  it('refuses a handler timeout that is not below the acknowledgement wait of 30 seconds', () => {
    for (const handlerTimeoutMs of [0, 30_000, 45_000]) {
      expect(() =>
        resolveMessagingOptions({
          service: 'task-service',
          servers: 'nats://nats:4222',
          handlerTimeoutMs,
        }),
      ).toThrow(/handler timeout/u);
    }
    expect(
      resolveMessagingOptions({
        service: 'task-service',
        servers: 'nats://nats:4222',
        handlerTimeoutMs: 29_999,
      }).handlerTimeoutMs,
    ).toBe(29_999);
  });

  it('refuses a subject prefix of several tokens or with a wildcard, and two equal prefixes', () => {
    for (const prefix of ['evt.v2', 'evt.>', '*', '', 'evt v2']) {
      expect(() =>
        resolveMessagingOptions({
          service: 'task-service',
          servers: 'nats://nats:4222',
          eventSubjectPrefix: prefix,
        }),
      ).toThrow(/eventSubjectPrefix of MessagingModule is one subject token/u);
    }
    expect(() =>
      resolveMessagingOptions({
        service: 'task-service',
        servers: 'nats://nats:4222',
        deadLetterSubjectPrefix: 'evt',
      }),
    ).toThrow(/pairwise distinct/u);
    expect(() =>
      resolveMessagingOptions({
        service: 'task-service',
        servers: 'nats://nats:4222',
        rebuildSubjectPrefix: 'restricted',
      }),
    ).toThrow(/pairwise distinct/u);
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
      restrictedDeadLetterPayload: 'copy',
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
      restrictedDeadLetterPayload: 'copy',
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

  describe.each(['publishTimeoutMs', 'shutdownTimeoutMs', 'rebuildTimeoutMs'] as const)(
    '%s',
    (option) => {
      it.each([1, 2_147_483_647])('accepts %s ms', (delay) => {
        const options = resolveMessagingOptions({
          service: 'task-service',
          servers: 'nats://nats:4222',
          [option]: delay,
        });
        expect(options[option]).toBe(delay);
      });

      it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
        'rejects %s ms',
        (delay) => {
          expect(() =>
            resolveMessagingOptions({
              service: 'task-service',
              servers: 'nats://nats:4222',
              [option]: delay,
            }),
          ).toThrow(`The ${option} of MessagingModule must be an integer`);
        },
      );
    },
  );

  it('refuses a missing service name, a missing server and a pending limit below one', () => {
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
        rebuildMaxPending: 0,
      }),
    ).toThrow(/pending limit/u);
  });
});
