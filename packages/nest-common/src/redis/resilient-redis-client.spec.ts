import { setTimeout as delay } from 'node:timers/promises';

import { Logger } from '@nestjs/common';
import type { RedisOptions } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import {
  createPubSubClients,
  pubSubClientOptions,
  ResilientRedisClient,
  type PubSubClients,
  type ResilientRedisOptions,
} from './resilient-redis-client.js';

/**
 * Constant mainOptions
 *
 * @description
 * Options of a main connection as a gateway sets them: no offline queue, a bounded retry.
 *
 * @type {ResilientRedisOptions}
 */
const mainOptions: ResilientRedisOptions = {
  host: 'redis.internal',
  port: 6380,
  username: 'realtime',
  password: 'redis-password-for-tests',
  db: 2,
  connectionName: 'realtime-gateway',
  enableOfflineQueue: false,
  maxRetriesPerRequest: 3,
  lazyConnect: true,
};

describe('pubSubClientOptions', () => {
  it('keeps the address and credentials of the main connection and queues without limit', () => {
    expect(pubSubClientOptions(mainOptions, 'publisher')).toEqual({
      ...mainOptions,
      connectionName: 'realtime-gateway-publisher',
      replyMapping: 'legacy',
      enableOfflineQueue: true,
      maxRetriesPerRequest: null,
      reportOutages: false,
    });
    expect(pubSubClientOptions(mainOptions, 'subscriber').connectionName).toBe(
      'realtime-gateway-subscriber',
    );
  });

  it('leaves the name unset when the main connection has none', () => {
    const unnamed: RedisOptions = { host: 'redis.internal', lazyConnect: true };

    expect(pubSubClientOptions(unnamed, 'subscriber')).toEqual({
      host: 'redis.internal',
      lazyConnect: true,
      replyMapping: 'legacy',
      enableOfflineQueue: true,
      maxRetriesPerRequest: null,
      reportOutages: false,
    });
  });
});

describe('ResilientRedisClient', () => {
  const unhandled: unknown[] = [];
  const onUnhandled: (reason: unknown) => void = (reason: unknown): void => {
    unhandled.push(reason);
  };
  let warned: MockInstance<Logger['warn']>;

  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
    warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    warned.mockRestore();
  });

  it('parses a URL and keeps only ioredis options in its options', async () => {
    const client: ResilientRedisClient = new ResilientRedisClient('redis://127.0.0.1:6390/4', {
      lazyConnect: true,
      connectionName: 'task-service',
      reportOutages: false,
      loggerContext: 'Cache',
    });

    expect(client.options).toMatchObject({
      host: '127.0.0.1',
      port: 6390,
      db: 4,
      connectionName: 'task-service',
    });
    expect('reportOutages' in client.options).toBe(false);
    expect('loggerContext' in client.options).toBe(false);
    await client.shutDown();
  });

  it('settles a command nobody awaits that fails while the connection is down', async () => {
    const options: ResilientRedisOptions = {
      host: '127.0.0.1',
      port: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
      retryStrategy: () => null,
      reportOutages: false,
    };
    const client: ResilientRedisClient = new ResilientRedisClient(options);

    const failed: Promise<unknown> = client.set('presence:user-camille', 'secret-presence-value');
    await delay(50);
    const calls: unknown[][] = [...warned.mock.calls];
    await client.shutDown();

    // The caller still gets the rejection when it awaits; nobody awaiting is no longer fatal.
    await expect(failed).rejects.toThrow(/enableOfflineQueue/u);
    expect(unhandled).toEqual([]);
    // Down from the start: the outage line covers it, not one line per command.
    expect(calls).toEqual([]);
  });

  it('drops silently the commands rejected because it closes', async () => {
    const client: ResilientRedisClient = new ResilientRedisClient({
      host: '127.0.0.1',
      port: 1,
      lazyConnect: true,
      retryStrategy: () => 1000,
      reportOutages: false,
    });

    void client.publish('room:a', 'payload');
    await client.shutDown();
    await delay(20);

    expect(unhandled).toEqual([]);
    expect(warned).not.toHaveBeenCalled();
  });
});

describe('createPubSubClients', () => {
  it('opens a publisher and a subscriber from the options of the main connection', async () => {
    const main: ResilientRedisClient = new ResilientRedisClient(mainOptions);
    const clients: PubSubClients = createPubSubClients(main);

    expect(clients.publisher).toBeInstanceOf(ResilientRedisClient);
    expect(clients.publisher.options).toMatchObject({
      host: 'redis.internal',
      port: 6380,
      password: 'redis-password-for-tests',
      db: 2,
      connectionName: 'realtime-gateway-publisher',
      enableOfflineQueue: true,
      maxRetriesPerRequest: null,
    });
    expect(clients.subscriber.options.connectionName).toBe('realtime-gateway-subscriber');
    expect(main.options.enableOfflineQueue).toBe(false);
    await clients.shutDown();
    await main.shutDown();

    expect(clients.publisher.status).toBe('end');
    expect(clients.subscriber.status).toBe('end');
  });
});
