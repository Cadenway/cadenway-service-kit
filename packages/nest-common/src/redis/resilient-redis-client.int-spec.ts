import { once } from 'node:events';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { Logger } from '@nestjs/common';
import {
  GenericContainer,
  getContainerRuntimeClient,
  Wait,
  type ContainerRuntimeClient,
  type StartedTestContainer,
} from 'testcontainers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPubSubClients,
  ResilientRedisClient,
  type PubSubClients,
} from './resilient-redis-client.js';

/**
 * Constant REDIS_IMAGE
 *
 * @description
 * Redis image of the integration specs: the tag cadenway-ops pins in `compose/infra.yaml`.
 *
 * @type {string}
 */
const REDIS_IMAGE: string = 'redis:8.10.3-alpine';

/**
 * Interface LoggedLine
 *
 * @description
 * One line the clients wrote through the NestJS logger.
 */
interface LoggedLine {
  // #region Properties
  /**
   * Property level
   *
   * @description
   * Logger method called, `warn` or `log`.
   *
   * @type {string}
   * @readonly
   */
  readonly level: string;

  /**
   * Property fields
   *
   * @description
   * Fields of the line.
   *
   * @type {unknown}
   * @readonly
   */
  readonly fields: unknown;

  /**
   * Property message
   *
   * @description
   * Message of the line.
   *
   * @type {unknown}
   * @readonly
   */
  readonly message: unknown;
  // #endregion
}

/**
 * Function freePort
 *
 * @description
 * Finds a free port of the loopback interface, to bind Redis to a fixed host port that survives a
 * stop and a start of its container.
 *
 * @returns {Promise<number>} The port.
 */
async function freePort(): Promise<number> {
  const server: Server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port: number = (server.address() as AddressInfo).port;
  server.close();
  await once(server, 'close');
  return port;
}

/**
 * Function waitFor
 *
 * @description
 * Waits until a condition holds.
 *
 * @param {() => boolean} condition - Condition to wait for.
 * @param {number} timeoutMs - Longest wait, in milliseconds.
 * @returns {Promise<void>} Resolves once the condition holds.
 * @throws {Error} When the condition does not hold in time.
 */
async function waitFor(condition: () => boolean, timeoutMs: number = 20_000): Promise<void> {
  const deadline: number = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('The condition was not met in time.');
    }
    await delay(25);
  }
}

describe('ResilientRedisClient on a real Redis', () => {
  let container: StartedTestContainer;
  let runtime: ContainerRuntimeClient;
  let url: string;
  const unhandled: unknown[] = [];
  const lines: LoggedLine[] = [];
  const onUnhandled: (reason: unknown) => void = (reason: unknown): void => {
    unhandled.push(reason);
  };

  /**
   * Function stopRedis
   *
   * @description
   * Stops the Redis container at once, keeping it for a later start.
   *
   * @returns {Promise<void>} Resolves once the container is stopped.
   */
  async function stopRedis(): Promise<void> {
    await runtime.container.stop(runtime.container.getById(container.getId()), { timeout: 0 });
  }

  /**
   * Function startRedis
   *
   * @description
   * Starts the stopped Redis container again, on the same host port.
   *
   * @returns {Promise<void>} Resolves once the container runs.
   */
  async function startRedis(): Promise<void> {
    await runtime.container.start(runtime.container.getById(container.getId()));
  }

  beforeAll(async () => {
    const port: number = await freePort();
    container = await new GenericContainer(REDIS_IMAGE)
      .withExposedPorts({ container: 6379, host: port })
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/u))
      .start();
    runtime = await getContainerRuntimeClient();
    url = `redis://127.0.0.1:${String(port)}`;
    process.on('unhandledRejection', onUnhandled);
  });

  beforeEach(() => {
    unhandled.length = 0;
    lines.length = 0;
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((fields: unknown, message: unknown) => {
      lines.push({ level: 'warn', fields, message });
    });
    vi.spyOn(Logger.prototype, 'log').mockImplementation((fields: unknown, message: unknown) => {
      lines.push({ level: 'log', fields, message });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    process.off('unhandledRejection', onUnhandled);
    await container.stop();
  });

  it('keeps the process up while Redis is stopped, and recovers when it returns', async () => {
    const main: ResilientRedisClient = new ResilientRedisClient(url, {
      connectionName: 'kit-proof',
      enableOfflineQueue: false,
      retryStrategy: () => 100,
    });
    await waitFor(() => main.status === 'ready');
    const clients: PubSubClients = createPubSubClients(main);
    await waitFor(
      () => clients.publisher.status === 'ready' && clients.subscriber.status === 'ready',
    );
    // As the Socket.IO adapter does: nobody awaits its commands.
    void clients.subscriber.psubscribe('room:*');
    await delay(50);

    await stopRedis();
    await waitFor(() => main.status !== 'ready' && clients.publisher.status !== 'ready');
    void main.get('presence:user-camille');
    const queued: Promise<number> = clients.publisher.publish('room:a', 'secret-payload');
    await delay(500);

    expect(unhandled).toEqual([]);

    await startRedis();
    await waitFor(() => main.status === 'ready' && clients.publisher.status === 'ready');

    await expect(main.ping()).resolves.toBe('PONG');
    await expect(queued).resolves.toBeTypeOf('number');
    const duringOutage: LoggedLine[] = [...lines];
    // Once connected, a command nobody awaits that Redis refuses is logged by its name.
    await main.set('kit-proof:presence', 'secret-value');
    void main.lpush('kit-proof:presence', 'secret-item');
    await delay(100);
    await clients.shutDown();
    await main.shutDown();
    await delay(50);

    expect(unhandled).toEqual([]);
    expect(duringOutage).toEqual([
      {
        level: 'warn',
        fields: { connection: 'kit-proof', reason: expect.any(String) as unknown },
        message: 'redis unreachable',
      },
      { level: 'log', fields: { connection: 'kit-proof' }, message: 'redis reachable again' },
    ]);
    expect(lines.slice(duringOutage.length)).toEqual([
      {
        level: 'warn',
        fields: { connection: 'kit-proof', command: 'lpush', reason: 'ReplyError' },
        message: 'redis command failed',
      },
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/presence:user-camille|secret-/u);
  });

  it('drops the commands still pending when it shuts down while Redis is stopped', async () => {
    const main: ResilientRedisClient = new ResilientRedisClient(url, {
      connectionName: 'kit-proof',
      enableOfflineQueue: false,
      retryStrategy: () => 100,
    });
    await waitFor(() => main.status === 'ready');
    const clients: PubSubClients = createPubSubClients(main);
    await waitFor(
      () => clients.publisher.status === 'ready' && clients.subscriber.status === 'ready',
    );

    await stopRedis();
    await waitFor(() => clients.publisher.status !== 'ready');
    void clients.publisher.publish('room:b', 'payload');
    void clients.subscriber.punsubscribe('room:*');
    await clients.shutDown();
    await main.shutDown();
    await delay(200);
    await startRedis();

    expect(unhandled).toEqual([]);
    expect(lines.filter((line) => line.message === 'redis command failed')).toEqual([]);
    expect(clients.publisher.status).toBe('end');
    expect(main.status).toBe('end');
  });
});
