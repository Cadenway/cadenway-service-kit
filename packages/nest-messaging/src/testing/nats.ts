import { createServer, type AddressInfo, type Server } from 'node:net';

import { connect, type NatsConnection } from '@nats-io/transport-node';
import { NatsContainer, type StartedNatsContainer } from '@testcontainers/nats';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

/**
 * Constant NATS_IMAGE
 *
 * @description
 * NATS image of the integration specs: the tag cadenway-ops pins in `compose/infra.yaml`.
 *
 * @type {string}
 */
export const NATS_IMAGE: string = 'nats:2.15.2-alpine';

/**
 * Interface TestNats
 *
 * @description
 * Disposable NATS server with JetStream, reachable with one user and its password.
 */
export interface TestNats {
  // #region Properties
  /**
   * Property url
   *
   * @description
   * URL of the server, as a service receives it in `NATS_URL`.
   *
   * @type {string}
   * @readonly
   */
  readonly url: string;

  /**
   * Property user
   *
   * @description
   * User of the server.
   *
   * @type {string}
   * @readonly
   */
  readonly user: string;

  /**
   * Property password
   *
   * @description
   * Password of the user.
   *
   * @type {string}
   * @readonly
   */
  readonly password: string;
  // #endregion

  // #region Methods
  /**
   * Method connect
   *
   * @description
   * Opens a plain client connection, for a spec to publish raw messages and inspect streams.
   *
   * @returns {Promise<NatsConnection>} The connection; the spec closes it.
   */
  connect(): Promise<NatsConnection>;

  /**
   * Method restart
   *
   * @description
   * Restarts the server. Its address stays the same and its streams, kept on the file system of
   * the container, survive: what a NATS restart looks like to a service.
   *
   * @returns {Promise<void>} Resolves once the server accepts connections again.
   */
  restart(): Promise<void>;

  /**
   * Method stop
   *
   * @description
   * Removes the container.
   *
   * @returns {Promise<void>} Resolves once stopped.
   */
  stop(): Promise<void>;
  // #endregion
}

/**
 * Function freePort
 *
 * @description
 * Asks the operating system for a free TCP port. The server is bound to it explicitly, because a
 * port Docker picks by itself changes when the container restarts.
 *
 * @returns {Promise<number>} A port that was free a moment ago.
 */
async function freePort(): Promise<number> {
  return new Promise<number>((resolve: (port: number) => void, reject: (error: Error) => void) => {
    const server: Server = createServer();
    server.on('error', reject);
    server.listen(0, () => {
      const port: number = (server.address() as AddressInfo).port;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/**
 * Function startTestNats
 *
 * @description
 * Starts a disposable NATS server with JetStream enabled, which the Testcontainers module
 * leaves off by default.
 *
 * @returns {Promise<TestNats>} The running server.
 */
export async function startTestNats(): Promise<TestNats> {
  const port: number = await freePort();
  const container: StartedNatsContainer = await new NatsContainer(NATS_IMAGE)
    .withJetStream()
    .withExposedPorts({ container: 4222, host: port })
    .start();
  const url: string = `nats://${container.getHost()}:${String(port)}`;
  const user: string = container.username ?? '';
  const password: string = container.password ?? '';
  return {
    url,
    user,
    password,
    connect: (): Promise<NatsConnection> => connect({ servers: url, user, pass: password }),
    restart: async (): Promise<void> => {
      await container.restart();
    },
    stop: async (): Promise<void> => {
      await container.stop();
    },
  };
}

/**
 * Interface ConfiguredNats
 *
 * @description
 * Disposable NATS server started from a configuration file, with the users that file declares.
 */
export interface ConfiguredNats {
  // #region Properties
  /**
   * Property url
   *
   * @description
   * URL of the server.
   *
   * @type {string}
   * @readonly
   */
  readonly url: string;
  // #endregion

  // #region Methods
  /**
   * Method stop
   *
   * @description
   * Removes the container.
   *
   * @returns {Promise<void>} Resolves once stopped.
   */
  stop(): Promise<void>;
  // #endregion
}

/**
 * Function startConfiguredNats
 *
 * @description
 * Starts a disposable NATS server with a configuration file of the spec, such as one shaped like
 * the configuration of cadenway-ops, to run the kit under real permissions.
 *
 * @param {string} configuration - Content of `nats-server.conf`.
 * @returns {Promise<ConfiguredNats>} The running server.
 */
export async function startConfiguredNats(configuration: string): Promise<ConfiguredNats> {
  const container: StartedTestContainer = await new GenericContainer(NATS_IMAGE)
    .withCopyContentToContainer([{ content: configuration, target: '/etc/nats/test.conf' }])
    .withCommand(['-c', '/etc/nats/test.conf'])
    .withExposedPorts(4222)
    .withWaitStrategy(Wait.forLogMessage(/Server is ready/u))
    .withStartupTimeout(120_000)
    .start();
  return {
    url: `nats://${container.getHost()}:${String(container.getMappedPort(4222))}`,
    stop: async (): Promise<void> => {
      await container.stop();
    },
  };
}
