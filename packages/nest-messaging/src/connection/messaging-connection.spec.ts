import { DiscardPolicy, RetentionPolicy, StorageType, type StreamInfo } from '@nats-io/jetstream';
import { describe, expect, it, vi } from 'vitest';

import { MessagingConnection } from './messaging-connection.js';

/**
 * Function latchInfo
 *
 * @description
 * Builds matching broker metadata for the advisory latch.
 *
 * @param {number} messages - Number of retained advisories.
 * @returns {StreamInfo} Stream metadata for the test.
 */
function latchInfo(messages: number): StreamInfo {
  return {
    config: {
      name: 'LATCH',
      subjects: [
        '$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.EVENTS.service__handler',
        '$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.EVENTS.service__handler',
      ],
      storage: StorageType.File,
      retention: RetentionPolicy.Limits,
      discard: DiscardPolicy.Old,
      max_msgs: 1,
      max_age: 0,
      max_bytes: -1,
      max_msg_size: -1,
      max_msgs_per_subject: -1,
    },
    state: { messages },
  } as StreamInfo;
}

/**
 * Function connectionWithInfo
 *
 * @description
 * Creates a connection with controlled availability and a stubbed management read.
 *
 * @param {() => Promise<StreamInfo>} read - Broker metadata request.
 * @returns {MessagingConnection} Connection for the test.
 */
function connectionWithInfo(read: () => Promise<StreamInfo>): MessagingConnection {
  const connection = Object.assign(
    Object.create(MessagingConnection.prototype) as MessagingConnection,
    {
      nats: { isClosed: () => false },
      available: true,
      connected: true,
      closing: false,
      availabilityEpoch: 0,
      availabilityListeners: new Set(),
      unhealthyConsumers: new Map(),
      manager: () => Promise.resolve({ streams: { info: read } }),
    },
  );
  return connection;
}

describe('consumer advisory stream state', () => {
  it.each([
    [0, 'clear', true],
    [1, 'held', false],
  ] as const)(
    'reports %s retained messages as %s and preserves the boolean guard',
    async (messages, state, clear) => {
      const connection = connectionWithInfo(() => Promise.resolve(latchInfo(messages)));
      await expect(
        connection.consumerAdvisoryStreamState('LATCH', 'EVENTS', ['service__handler']),
      ).resolves.toBe(state);
      await expect(
        connection.isConsumerAdvisoryStreamClear('LATCH', 'EVENTS', ['service__handler']),
      ).resolves.toBe(clear);
    },
  );

  it('reports unknown for invalid inputs, mismatched configuration, failed reads and cancellation', async () => {
    const read = vi.fn(() => Promise.resolve(latchInfo(1)));
    const connection = connectionWithInfo(read);
    await expect(connection.consumerAdvisoryStreamState('LATCH', 'EVENTS', [])).resolves.toBe(
      'unknown',
    );
    await expect(
      connection.consumerAdvisoryStreamState(
        'LATCH',
        'EVENTS',
        ['service__handler'],
        AbortSignal.abort(),
      ),
    ).resolves.toBe('unknown');
    expect(read).not.toHaveBeenCalled();
    await expect(
      connection.consumerAdvisoryStreamState('LATCH', 'EVENTS', ['other']),
    ).resolves.toBe('unknown');
    await expect(
      connection.isConsumerAdvisoryStreamClear('LATCH', 'EVENTS', ['other']),
    ).resolves.toBe(false);
    read.mockRejectedValue(new Error('unavailable'));
    await expect(
      connection.consumerAdvisoryStreamState('LATCH', 'EVENTS', ['service__handler']),
    ).resolves.toBe('unknown');
    await expect(
      connection.isConsumerAdvisoryStreamClear('LATCH', 'EVENTS', ['service__handler']),
    ).resolves.toBe(false);
    (
      connection as MessagingConnection & {
        reportConsumer(name: string, problem: string | null): void;
      }
    ).reportConsumer('service__handler', 'unavailable');
    await expect(
      connection.consumerAdvisoryStreamState('LATCH', 'EVENTS', ['service__handler']),
    ).resolves.toBe('unknown');
  });

  it.each([0, 1])(
    'discards a snapshot with %s messages across an availability change',
    async (messages) => {
      let finish!: (info: StreamInfo) => void;
      const connection = connectionWithInfo(
        () =>
          new Promise<StreamInfo>((resolve) => {
            finish = resolve;
          }),
      );
      const result = connection.consumerAdvisoryStreamState('LATCH', 'EVENTS', [
        'service__handler',
      ]);
      await Promise.resolve();
      (
        connection as MessagingConnection & {
          reportConsumer(name: string, problem: string | null): void;
        }
      ).reportConsumer('service__handler', 'unavailable');
      (
        connection as MessagingConnection & {
          reportConsumer(name: string, problem: string | null): void;
        }
      ).reportConsumer('service__handler', null);
      finish(latchInfo(messages));
      await expect(result).resolves.toBe('unknown');
    },
  );
  it('reports unknown for a nonempty stream with the wrong latch configuration', async () => {
    const info = latchInfo(1);
    info.config.max_age = 1;
    const connection = connectionWithInfo(() => Promise.resolve(info));
    await expect(
      connection.consumerAdvisoryStreamState('LATCH', 'EVENTS', ['service__handler']),
    ).resolves.toBe('unknown');
    await expect(
      connection.isConsumerAdvisoryStreamClear('LATCH', 'EVENTS', ['service__handler']),
    ).resolves.toBe(false);
  });

  it('stops waiting when a held snapshot is aborted', async () => {
    let finish!: (info: StreamInfo) => void;
    const connection = connectionWithInfo(
      () =>
        new Promise<StreamInfo>((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const result = connection.consumerAdvisoryStreamState(
      'LATCH',
      'EVENTS',
      ['service__handler'],
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();
    await expect(result).resolves.toBe('unknown');
    finish(latchInfo(1));
  });
});
