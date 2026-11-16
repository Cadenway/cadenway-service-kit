import {
  jetstream,
  jetstreamManager,
  type ConsumerInfo,
  type JetStreamManager,
  type StoredMsg,
  type StreamInfo,
} from '@nats-io/jetstream';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { EventConsumers, type EventContext } from '../consumer/event-consumers.js';
import type { MessagingModuleOptions } from '../configuration/messaging-options.js';
import { MessagingModule } from './messaging.module.js';
import { DEAD_LETTER_REASON_HEADER } from '../transport/event-headers.js';
import { EventPublisher, type PublishedEvent } from '../publisher/event-publisher.js';
import { RebuildEmitter } from '../rebuild/emitter/rebuild-emitter.js';
import { startApplication } from '../testing/application.js';
import {
  eventSchemas,
  taskUpdated,
  userSignedUp,
  type TaskUpdatedV1,
  type UserSignedUpV1,
} from '../testing/events.js';
import { startConfiguredNats, type ConfiguredNats } from '../testing/nats.js';
import { delay, waitFor } from '../testing/wait.js';

/**
 * Function consumerApi
 *
 * @description
 * Publish permissions of a user that consumes a stream, as cadenway-ops grants them.
 *
 * @param {string} stream - Name of the stream.
 * @returns {string[]} The API subjects.
 */
function consumerApi(stream: string): string[] {
  return [
    `$JS.API.CONSUMER.CREATE.${stream}.>`,
    `$JS.API.CONSUMER.DURABLE.CREATE.${stream}.*`,
    `$JS.API.CONSUMER.INFO.${stream}.*`,
    `$JS.API.CONSUMER.MSG.NEXT.${stream}.*`,
    `$JS.ACK.${stream}.>`,
  ];
}

/**
 * Function user
 *
 * @description
 * Writes one user of the server configuration.
 *
 * @param {string} name - Name of the user; its password is `<name>Secret1`.
 * @param {readonly string[]} publish - Subjects the user may publish to.
 * @param {readonly string[]} subscribe - Subjects the user may subscribe to.
 * @returns {string} The configuration block.
 */
function user(name: string, publish: readonly string[], subscribe: readonly string[]): string {
  const list: (subjects: readonly string[]) => string = (subjects: readonly string[]): string =>
    subjects.map((subject: string) => JSON.stringify(subject)).join(', ');
  return `{ user: "${name}", password: "${name}Secret1", permissions: {
      publish: { allow: [${list(publish)}] }
      subscribe: { allow: [${list(subscribe)}] } } }`;
}

/**
 * Constant BASE_API
 *
 * @description
 * API subjects cadenway-ops gives every user.
 *
 * @type {string[]}
 */
const BASE_API: string[] = ['$JS.API.INFO', '$JS.API.STREAM.NAMES', '$JS.API.STREAM.INFO.EVENTS'];

/**
 * Constant CONFIGURATION
 *
 * @description
 * Server configuration shaped like `compose/nats/nats-server.conf` of cadenway-ops: one user per
 * backend, each on its own inbox prefix, with only the subjects of its role.
 *
 * @type {string}
 */
const CONFIGURATION: string = `
port: 4222
jetstream { store_dir: "/tmp/jetstream" }
authorization {
  users = [
    ${user('admin', ['>'], ['>'])}
    ${user('task', ['evt.task.>', 'rebuild.*.task', ...BASE_API, ...consumerApi('EVENTS')], ['_INBOX.task.>', 'rebuild.task.>'])}
    ${user('search', [...BASE_API, ...consumerApi('EVENTS')], ['_INBOX.search.>', 'rebuild.search.>'])}
    ${user(
      'identity',
      [
        'evt.user.>',
        'restricted.>',
        ...BASE_API,
        '$JS.API.STREAM.INFO.EVENTS_RESTRICTED',
        ...consumerApi('EVENTS'),
      ],
      ['_INBOX.identity.>', 'rebuild.identity.>'],
    )}
    ${user(
      'notification',
      [
        'dlq.>',
        ...BASE_API,
        '$JS.API.STREAM.INFO.EVENTS_RESTRICTED',
        '$JS.API.STREAM.INFO.EVENTS_DLQ',
        '$JS.API.STREAM.MSG.GET.EVENTS',
        '$JS.API.STREAM.MSG.GET.EVENTS_RESTRICTED',
        ...consumerApi('EVENTS'),
        ...consumerApi('EVENTS_RESTRICTED'),
      ],
      [
        '_INBOX.notification.>',
        'rebuild.notification.>',
        '$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.EVENTS.>',
        '$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.EVENTS_RESTRICTED.>',
        '$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.EVENTS.>',
        '$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.EVENTS_RESTRICTED.>',
      ],
    )}
  ]
}
`;

/**
 * Constant taskItemSchema
 *
 * @description
 * Schema of the rebuild items of the specs.
 *
 * @type {z.ZodType<{ taskId: string }>}
 */
const taskItemSchema: z.ZodType<{ taskId: string }> = z.object({ taskId: z.string().min(1) });

describe('messaging module under the NATS permissions of cadenway-ops', () => {
  let nats: ConfiguredNats;
  let admin: NatsConnection;
  let manager: JetStreamManager;
  let streams: TestingModule;
  const applications: TestingModule[] = [];

  /**
   * Function as
   *
   * @description
   * Starts an application connected as one user of the server, which checks the streams it
   * uses without managing them.
   *
   * @param {string} name - NATS user, also the prefix of the service name.
   * @param {Partial<MessagingModuleOptions>} options - Options of the spec.
   * @param {readonly number[] | undefined} retryDelaysMs - Retry delays of the consumers, when the spec shortens them.
   * @returns {Promise<TestingModule>} The running application, closed after the spec.
   */
  async function as(
    name: string,
    options: Partial<MessagingModuleOptions> = {},
    retryDelaysMs?: readonly number[],
  ): Promise<TestingModule> {
    const application: TestingModule = await startApplication(
      [
        MessagingModule.forRoot({
          service: `${name}-service`,
          servers: nats.url,
          user: name,
          password: `${name}Secret1`,
          publishTimeoutMs: 2000,
          ...options,
        }),
      ],
      retryDelaysMs === undefined ? {} : { tuning: { retryDelaysMs } },
    );
    applications.push(application);
    return application;
  }

  /**
   * Function consumerState
   *
   * @description
   * Reads a durable consumer as the administrator.
   *
   * @param {string} stream - Name of the stream.
   * @param {string} consumer - Name of the consumer.
   * @returns {Promise<ConsumerInfo>} The consumer state.
   */
  function consumerState(stream: string, consumer: string): Promise<ConsumerInfo> {
    return manager.consumers.info(stream, consumer);
  }

  beforeAll(async () => {
    nats = await startConfiguredNats(CONFIGURATION);
    admin = await connect({ servers: nats.url, user: 'admin', pass: 'adminSecret1' });
    manager = await jetstreamManager(admin);
    // What the nats-streams container of cadenway-ops does with the admin user.
    streams = await startApplication([
      MessagingModule.forRoot({
        service: 'nats-streams',
        servers: nats.url,
        user: 'admin',
        password: 'adminSecret1',
        manageStreams: true,
      }),
    ]);
  });

  afterAll(async () => {
    for (const application of applications) {
      await application.close();
    }
    await streams.close();
    await admin.close();
    await nats.stop();
  });

  it('is refused on the default inbox prefix, and works on _INBOX.<user>', async () => {
    const plain: NatsConnection = await connect({
      servers: nats.url,
      user: 'task',
      pass: 'taskSecret1',
    });
    const refused: Promise<unknown> = jetstream(plain).publish('evt.task.updated.v1', '{}', {
      timeout: 1000,
    });
    await expect(refused).rejects.toThrow();
    await plain.close();

    const task: TestingModule = await as('task');
    const published: PublishedEvent = await task
      .get(EventPublisher)
      .publish(eventSchemas, 'task.updated.v1', taskUpdated());

    expect(published).toMatchObject({ stream: 'EVENTS', duplicate: false });
  });

  it('publishes, consumes, acknowledges, retries and terminates with the permissions of a publisher and a consumer', async () => {
    const task: TestingModule = await as('task');
    const search: TestingModule = await as('search', {}, [100, 100, 100, 100]);
    const seen: { taskId: string; deliveryCount: number }[] = [];
    await search.get(EventConsumers).subscribe({
      handler: 'index-task',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      deliverPolicy: 'new',
      handle: (payload: TaskUpdatedV1, eventContext: EventContext): Promise<void> => {
        seen.push({ taskId: payload.taskId, deliveryCount: eventContext.deliveryCount });
        return eventContext.deliveryCount === 1
          ? Promise.reject(new Error('index unavailable'))
          : Promise.resolve();
      },
    });

    const published: PublishedEvent = await task
      .get(EventPublisher)
      .publish(eventSchemas, 'task.updated.v1', taskUpdated({ taskId: 'CAD-1' }));
    const raw: NatsConnection = await connect({
      servers: nats.url,
      user: 'task',
      pass: 'taskSecret1',
      inboxPrefix: '_INBOX.task',
    });
    const poison: number = (await jetstream(raw).publish('evt.task.updated.v1', '{"bad":true}'))
      .seq;
    await raw.close();
    await waitFor(async () => {
      const state: ConsumerInfo = await consumerState('EVENTS', 'search-service__index-task');
      return state.ack_floor.stream_seq === poison && state.num_ack_pending === 0;
    });
    const state: ConsumerInfo = await consumerState('EVENTS', 'search-service__index-task');

    expect(seen).toEqual([
      { taskId: 'CAD-1', deliveryCount: 1 },
      { taskId: 'CAD-1', deliveryCount: 2 },
    ]);
    expect(poison).toBe(published.streamSequence + 1);
    expect(state.config.filter_subject).toBe('evt.task.updated.v1');
    expect(state.num_redelivered).toBe(0);
    expect(state.num_pending).toBe(0);
  });

  it('keeps restricted events in their stream: identity publishes them, notification alone consumes them', async () => {
    const restrictedEvents: string[] = ['user.signed-up.v1'];
    const identity: TestingModule = await as('identity', { restrictedEvents });
    const notification: TestingModule = await as('notification', { restrictedEvents });
    const welcomed: string[] = [];
    await notification.get(EventConsumers).subscribe({
      handler: 'welcome',
      schemas: eventSchemas,
      event: 'user.signed-up.v1',
      handle: (payload: UserSignedUpV1): Promise<void> => {
        welcomed.push(payload.userId);
        return Promise.resolve();
      },
    });

    const published: PublishedEvent = await identity
      .get(EventPublisher)
      .publish(eventSchemas, 'user.signed-up.v1', userSignedUp());
    await waitFor(() => welcomed.length === 1);
    const stored: StoredMsg | null = await manager.streams.getMessage('EVENTS_RESTRICTED', {
      seq: published.streamSequence,
    });
    const events: StreamInfo = await manager.streams.info('EVENTS');

    expect(published.stream).toBe('EVENTS_RESTRICTED');
    expect(stored?.subject).toBe('restricted.user.signed-up.v1');
    expect(events.state.subjects?.['evt.user.signed-up.v1']).toBeUndefined();
    await expect(as('search', { restrictedEvents })).rejects.toThrow();
  });

  it('runs the dead-letter worker with the permissions of notification only', async () => {
    const restrictedEvents: string[] = ['user.signed-up.v1'];
    const task: TestingModule = await as('task');
    const notification: TestingModule = await as(
      'notification',
      { restrictedEvents, deadLetterWorker: true, restrictedDeadLetterPayload: 'copy' },
      [50],
    );
    await notification.get(EventConsumers).subscribe({
      handler: 'notify-assignee',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      deliverPolicy: 'new',
      handle: (): Promise<void> => Promise.reject(new Error('mail server unavailable')),
    });
    await notification.get(EventConsumers).subscribe({
      handler: 'send-code',
      schemas: eventSchemas,
      event: 'user.signed-up.v1',
      deliverPolicy: 'new',
      handle: (): Promise<void> => Promise.resolve(),
    });
    const raw: NatsConnection = await connect({
      servers: nats.url,
      user: 'identity',
      pass: 'identitySecret1',
      inboxPrefix: '_INBOX.identity',
    });

    await task.get(EventPublisher).publish(eventSchemas, 'task.updated.v1', taskUpdated());
    await jetstream(raw).publish('restricted.user.signed-up.v1', 'not json');
    await raw.close();
    let failed: StoredMsg | null = null;
    let poison: StoredMsg | null = null;
    await waitFor(async () => {
      failed = await manager.streams.getMessage('EVENTS_DLQ', {
        last_by_subj: 'dlq.notification-service__notify-assignee.evt.task.updated.v1',
      });
      poison = await manager.streams.getMessage('EVENTS_DLQ', {
        last_by_subj: 'dlq.notification-service__send-code.restricted.user.signed-up.v1',
      });
      return failed !== null && poison !== null;
    });

    const copies: (StoredMsg | null)[] = [failed, poison];
    expect(
      copies.map((copy: StoredMsg | null) => copy?.header.get(DEAD_LETTER_REASON_HEADER)),
    ).toEqual(['max-deliveries', 'terminated']);
    expect(copies[1]?.string()).toBe('not json');
  });

  it('delivers rebuild items as plain messages, the only mode the permissions allow', async () => {
    const task: TestingModule = await as('task', { rebuildFlushEvery: 1 });
    const search: TestingModule = await as('search');
    const applied: string[] = [];
    await search.get(EventConsumers).onRebuild({
      entity: 'task',
      schema: taskItemSchema,
      handle: (item: { taskId: string }): Promise<void> => {
        applied.push(item.taskId);
        return Promise.resolve();
      },
    });

    await task
      .get(RebuildEmitter)
      .emit({ consumer: 'search', entity: 'task', schema: taskItemSchema }, { taskId: 'CAD-1' });
    await waitFor(() => applied.length === 1);

    const replying: TestingModule = await as('task', {
      service: 'task-service-reply',
      rebuildAcknowledgement: 'reply',
      rebuildTimeoutMs: 1000,
    });
    await expect(
      replying
        .get(RebuildEmitter)
        .emit({ consumer: 'search', entity: 'task', schema: taskItemSchema }, { taskId: 'CAD-2' }),
    ).rejects.toThrow();
    await delay(100);

    expect(applied).toEqual(['CAD-1', 'CAD-2']);
  });
});
