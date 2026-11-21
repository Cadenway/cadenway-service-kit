import {
  AckPolicy,
  jetstream,
  jetstreamManager,
  RetentionPolicy,
  type JetStreamManager,
  type PubAck,
  type StoredMsg,
  type StreamInfo,
} from '@nats-io/jetstream';
import { headers, type MsgHdrs, type NatsConnection } from '@nats-io/transport-node';
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MessagingConnection,
  messagingHealthIndicator,
} from '../connection/messaging-connection.js';
import { EventConsumers } from '../consumer/event-consumers.js';
import { MessagingModule } from '../wiring/messaging.module.js';
import {
  DEAD_LETTER_CONSUMER_HEADER,
  DEAD_LETTER_DELIVERIES_HEADER,
  DEAD_LETTER_PAYLOAD_HEADER,
  DEAD_LETTER_REASON_HEADER,
  DEAD_LETTER_SEQUENCE_HEADER,
  EVENT_NAME_HEADER,
  ORGANIZATION_ID_HEADER,
} from '../transport/event-headers.js';
import { EventPublisher, type PublishedEvent } from '../publisher/event-publisher.js';
import { isolatedNames, messagingOptions, startApplication } from '../testing/application.js';
import { ATELIER_NORD, eventSchemas, taskUpdated, type TaskUpdatedV1 } from '../testing/events.js';
import { startTestNats, type TestNats } from '../testing/nats.js';
import { delay, waitFor } from '../testing/wait.js';

describe('dead-letter worker on a real NATS server', () => {
  let nats: TestNats;
  let client: NatsConnection;
  let manager: JetStreamManager;

  /**
   * Function deadLetters
   *
   * @description
   * Counts the messages of a dead-letter stream.
   *
   * @param {string} stream - Name of the dead-letter stream.
   * @returns {Promise<number>} The number of dead letters stored.
   */
  async function deadLetters(stream: string): Promise<number> {
    const info: StreamInfo = await manager.streams.info(stream);
    return info.state.messages;
  }

  /**
   * Function lastDeadLetter
   *
   * @description
   * Reads the dead letter last stored for a subject.
   *
   * @param {string} stream - Name of the dead-letter stream.
   * @param {string} subject - Dead-letter subject.
   * @returns {Promise<StoredMsg>} The dead letter.
   */
  async function lastDeadLetter(stream: string, subject: string): Promise<StoredMsg> {
    const message: StoredMsg | null = await manager.streams.getMessage(stream, {
      last_by_subj: subject,
    });
    if (message === null) {
      throw new Error(`No dead letter on ${subject}.`);
    }
    return message;
  }

  /** Reads the problem reported by the public readiness indicator. */
  async function readinessProblem(
    health: ReturnType<typeof messagingHealthIndicator>,
  ): Promise<string | undefined> {
    try {
      await health.check();
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : 'Unknown readiness error';
    }
  }

  beforeAll(async () => {
    nats = await startTestNats();
    client = await nats.connect();
    manager = await jetstreamManager(client);
  });

  afterAll(async () => {
    await client.close();
    await nats.stop();
  });

  it('replays two broker advisories captured during shutdown and retries a copy until its PubAck', async () => {
    const names = isolatedNames('inbox');
    const stream = 'EVENTS_ADVISORIES_inbox';
    const durable = 'inbox-reader';
    const taskSubject = 'evt-inbox.task.updated.v1';
    const advisorySubject = `$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.${names.eventsStream}.>`;
    const options = messagingOptions(nats, names);
    const publisher = await startApplication([MessagingModule.forRoot(options)]);
    let worker: TestingModule | undefined;
    try {
      await manager.streams.add({
        name: stream,
        subjects: [advisorySubject],
        retention: RetentionPolicy.Workqueue,
      });
      await manager.consumers.add(stream, {
        durable_name: durable,
        ack_policy: AckPolicy.Explicit,
        max_deliver: -1,
      });
      const workerOptions = {
        ...options,
        deadLetterWorker: true,
        deadLetterAdvisories: {
          stream,
          durable,
          servers: nats.url,
          user: nats.user,
          password: nats.password,
        },
      };
      worker = await startApplication([MessagingModule.forRoot(workerOptions)]);
      await worker.close();
      worker = undefined;
      await publisher.get(EventConsumers).subscribe({
        handler: 'inbox-test',
        schemas: eventSchemas,
        event: 'task.updated.v1',
        handle: (): Promise<void> => Promise.resolve(),
      });
      const failedEventHeaders = headers();
      failedEventHeaders.set(EVENT_NAME_HEADER, 'task.updated.v1');
      failedEventHeaders.set(ORGANIZATION_ID_HEADER, ATELIER_NORD);
      const origin = jetstream(client);
      const first = await origin.publish(taskSubject, 'first invalid JSON', {
        headers: failedEventHeaders,
      });
      const second = await origin.publish(taskSubject, 'second invalid JSON', {
        headers: failedEventHeaders,
      });
      await waitFor(async () => (await deadLetters(stream)) === 2);
      expect(await deadLetters(names.deadLetterStream)).toBe(0);
      const captured = await lastDeadLetter(
        stream,
        `$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.${names.eventsStream}.task-service__inbox-test`,
      );

      worker = await startApplication([MessagingModule.forRoot(workerOptions)]);
      await waitFor(async () => (await deadLetters(names.deadLetterStream)) === 2);
      await waitFor(async () => (await deadLetters(stream)) === 0);
      const copied = await lastDeadLetter(
        names.deadLetterStream,
        'dlq-inbox.task-service__inbox-test.evt-inbox.task.updated.v1',
      );
      expect(copied.string()).toBe('second invalid JSON');
      expect(copied.header.get(DEAD_LETTER_SEQUENCE_HEADER)).toBe(String(second.seq));
      expect(second.seq).toBe(first.seq + 1);

      await manager.streams.deleteMessage(names.eventsStream, second.seq);
      await origin.publish(captured.subject, captured.data);
      await waitFor(async () => (await deadLetters(stream)) === 0);
      expect(await deadLetters(names.deadLetterStream)).toBe(2);

      const connection = worker.get(MessagingConnection);
      const health = messagingHealthIndicator(connection);
      const destination = (await manager.streams.info(names.deadLetterStream)).config;
      await manager.streams.delete(names.deadLetterStream);
      await origin.publish(taskSubject, 'retry invalid JSON', { headers: failedEventHeaders });
      await waitFor(
        async () => (await manager.consumers.info(stream, durable)).delivered.consumer_seq > 3,
      );
      expect(await deadLetters(stream)).toBe(1);
      await waitFor(
        async () => (await readinessProblem(health))?.includes('dead-letter copy failed') === true,
      );
      await expect(health.check()).rejects.toThrow('dead-letter copy failed');
      await manager.streams.add(destination);
      await waitFor(async () => (await deadLetters(names.deadLetterStream)) === 1);
      await waitFor(async () => (await deadLetters(stream)) === 0);
      await waitFor(async () => (await readinessProblem(health)) === undefined);
      await expect(health.check()).resolves.toBeUndefined();
      const retried = await lastDeadLetter(
        names.deadLetterStream,
        'dlq-inbox.task-service__inbox-test.evt-inbox.task.updated.v1',
      );
      expect(retried.string()).toBe('retry invalid JSON');
    } finally {
      await worker?.close();
      await publisher.close();
    }
  });

  it('reports a separate advisory broker restart until it can bind and pull again', async () => {
    const names = isolatedNames('separate-broker');
    const stream = 'EVENTS_ADVISORIES';
    const durable = 'readiness-reader';
    const observer = await startTestNats();
    const observerClient = await observer.connect();
    let worker: TestingModule | undefined;
    let restart: Promise<void> | undefined;
    try {
      const observerManager = await jetstreamManager(observerClient);
      await observerManager.streams.add({
        name: stream,
        subjects: [`$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.${names.eventsStream}.>`],
        retention: RetentionPolicy.Workqueue,
      });
      await observerManager.consumers.add(stream, {
        durable_name: durable,
        ack_policy: AckPolicy.Explicit,
        max_deliver: -1,
      });
      worker = await startApplication([
        MessagingModule.forRoot(
          messagingOptions(nats, {
            ...names,
            deadLetterWorker: true,
            deadLetterAdvisories: {
              stream,
              durable,
              servers: observer.url,
              user: observer.user,
              password: observer.password,
            },
          }),
        ),
      ]);
      const connection = worker.get(MessagingConnection);
      const health = messagingHealthIndicator(connection);
      await waitFor(
        async () => (await observerManager.consumers.info(stream, durable)).num_waiting > 0,
      );
      await expect(health.check()).resolves.toBeUndefined();

      restart = observer.restart();
      await waitFor(
        async () =>
          (await readinessProblem(health))?.includes('advisory broker disconnected') === true,
      );
      await expect(health.check()).rejects.toThrow('advisory broker disconnected');
      await expect(connection.flush()).resolves.toBeUndefined();
      await restart;

      await waitFor(async () => (await readinessProblem(health)) === undefined);
      await waitFor(
        async () => (await observerManager.consumers.info(stream, durable)).num_waiting > 0,
      );
      await expect(health.check()).resolves.toBeUndefined();
    } finally {
      await worker?.close();
      await restart?.catch(() => undefined);
      await observerClient.close();
      await observer.stop();
    }
  });

  it('records a metadata-only marker when a recreated stream reuses a captured sequence', async () => {
    const names = isolatedNames('recreated');
    const stream = 'EVENTS_ADVISORIES_recreated';
    const durable = 'recreated-inbox-reader';
    const eventSubject = 'evt-recreated.task.updated.v1';
    let publisher: TestingModule | undefined = await startApplication([
      MessagingModule.forRoot(messagingOptions(nats, names)),
    ]);
    let worker: TestingModule | undefined;
    try {
      await manager.streams.add({
        name: stream,
        subjects: [`$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.${names.eventsStream}.>`],
        retention: RetentionPolicy.Workqueue,
      });
      await manager.consumers.add(stream, {
        durable_name: durable,
        ack_policy: AckPolicy.Explicit,
        max_deliver: -1,
      });
      await publisher.get(EventConsumers).subscribe({
        handler: 'recreated-test',
        schemas: eventSchemas,
        event: 'task.updated.v1',
        handle: (): Promise<void> => Promise.resolve(),
      });
      const origin = jetstream(client);
      const original = await origin.publish(eventSubject, 'invalid JSON');
      await waitFor(async () => (await deadLetters(stream)) === 1);
      await publisher.close();
      publisher = undefined;
      const previous = (await manager.streams.info(names.eventsStream)).config;
      await manager.streams.delete(names.eventsStream);
      await manager.streams.add(previous);
      const replacement = await origin.publish(eventSubject, 'different source payload');
      expect(replacement.seq).toBe(original.seq);

      worker = await startApplication([
        MessagingModule.forRoot(
          messagingOptions(nats, {
            ...names,
            deadLetterWorker: true,
            deadLetterAdvisories: {
              stream,
              durable,
              servers: nats.url,
              user: nats.user,
              password: nats.password,
            },
          }),
        ),
      ]);
      await waitFor(async () => (await deadLetters(names.deadLetterStream)) >= 1);
      const marker = await lastDeadLetter(
        names.deadLetterStream,
        'dlq-recreated.task-service__recreated-test.advisory-source-unavailable',
      );
      expect(marker.data.byteLength).toBe(0);
      expect(marker.header.get(DEAD_LETTER_SEQUENCE_HEADER)).toBe(String(original.seq));
      expect(marker.header.get(DEAD_LETTER_PAYLOAD_HEADER)).toBe('dropped');
      expect(marker.header.get(EVENT_NAME_HEADER)).toBe('');
    } finally {
      await worker?.close();
      await publisher?.close();
    }
  });

  it('terminates a message that does not match its contract and copies it with the dead-letter headers', async () => {
    const application: TestingModule = await startApplication([
      MessagingModule.forRoot(
        messagingOptions(nats, { service: 'search-service', deadLetterWorker: true }),
      ),
    ]);
    const calls: string[] = [];
    await application.get(EventConsumers).subscribe({
      handler: 'index-task',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      handle: (payload: TaskUpdatedV1): Promise<void> => {
        calls.push(payload.taskId);
        return Promise.resolve();
      },
    });
    const poison: string = JSON.stringify({ taskId: 42, note: 'not an event of the contracts' });
    const poisonHeaders: MsgHdrs = headers();
    poisonHeaders.set(EVENT_NAME_HEADER, 'task.updated.v1');
    poisonHeaders.set(ORGANIZATION_ID_HEADER, ATELIER_NORD);

    const published: PubAck = await jetstream(client).publish('evt.task.updated.v1', poison, {
      msgID: 'poison-1',
      headers: poisonHeaders,
    });
    await waitFor(async () => (await deadLetters('EVENTS_DLQ')) === 1);
    const deadLetter: StoredMsg = await lastDeadLetter(
      'EVENTS_DLQ',
      'dlq.search-service__index-task.evt.task.updated.v1',
    );
    // A valid event published afterwards still goes through: the poison message blocks nothing.
    await application.get(EventPublisher).publish(eventSchemas, 'task.updated.v1', taskUpdated());
    await waitFor(() => calls.length === 1);
    await delay(300);
    await application.close();

    expect(calls).toEqual(['CAD-482']);
    expect(deadLetter.string()).toBe(poison);
    expect(deadLetter.header.get(DEAD_LETTER_CONSUMER_HEADER)).toBe('search-service__index-task');
    expect(deadLetter.header.get(DEAD_LETTER_REASON_HEADER)).toBe('terminated');
    expect(deadLetter.header.get(DEAD_LETTER_SEQUENCE_HEADER)).toBe(String(published.seq));
    expect(deadLetter.header.get(DEAD_LETTER_DELIVERIES_HEADER)).toBe('1');
    expect(deadLetter.header.get(EVENT_NAME_HEADER)).toBe('task.updated.v1');
    expect(deadLetter.header.get(ORGANIZATION_ID_HEADER)).toBe(ATELIER_NORD);
    expect(deadLetter.header.get('Nats-Msg-Id')).toBe(
      `EVENTS.search-service__index-task.${String(published.seq)}`,
    );
    expect(await deadLetters('EVENTS_DLQ')).toBe(1);
  });

  it('terminates a message that is not JSON', async () => {
    const names: ReturnType<typeof isolatedNames> = isolatedNames('json');
    const application: TestingModule = await startApplication([
      MessagingModule.forRoot(
        messagingOptions(nats, { ...names, service: 'search-service', deadLetterWorker: true }),
      ),
    ]);
    await application.get(EventConsumers).subscribe({
      handler: 'index-task',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      handle: (): Promise<void> => Promise.resolve(),
    });

    await jetstream(client).publish('evt-json.task.updated.v1', 'not json at all');
    await waitFor(async () => (await deadLetters('EVENTS_DLQ_json')) === 1);
    const deadLetter: StoredMsg = await lastDeadLetter(
      'EVENTS_DLQ_json',
      'dlq-json.search-service__index-task.evt-json.task.updated.v1',
    );
    await application.close();

    expect(deadLetter.string()).toBe('not json at all');
    expect(deadLetter.header.get(DEAD_LETTER_REASON_HEADER)).toBe('terminated');
  });

  it('copies an event whose handler always fails after five deliveries', async () => {
    const names: ReturnType<typeof isolatedNames> = isolatedNames('five');
    const application: TestingModule = await startApplication(
      [
        MessagingModule.forRoot(
          messagingOptions(nats, { ...names, service: 'search-service', deadLetterWorker: true }),
        ),
      ],
      { tuning: { retryDelaysMs: [50, 50, 50, 50] } },
    );
    const attempts: number[] = [];
    await application.get(EventConsumers).subscribe({
      handler: 'index-task',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      handle: (_payload: TaskUpdatedV1, eventContext: { deliveryCount: number }): Promise<void> => {
        attempts.push(eventContext.deliveryCount);
        return Promise.reject(new Error('index unavailable'));
      },
    });

    const published: PublishedEvent = await application
      .get(EventPublisher)
      .publish(eventSchemas, 'task.updated.v1', taskUpdated());
    await waitFor(async () => (await deadLetters('EVENTS_DLQ_five')) === 1);
    const deadLetter: StoredMsg = await lastDeadLetter(
      'EVENTS_DLQ_five',
      'dlq-five.search-service__index-task.evt-five.task.updated.v1',
    );
    await delay(300);
    await application.close();

    expect(attempts).toEqual([1, 2, 3, 4, 5]);
    expect(deadLetter.json<TaskUpdatedV1>()).toMatchObject({ id: published.id, taskId: 'CAD-482' });
    expect(deadLetter.header.get(DEAD_LETTER_CONSUMER_HEADER)).toBe('search-service__index-task');
    expect(deadLetter.header.get(DEAD_LETTER_REASON_HEADER)).toBe('max-deliveries');
    expect(deadLetter.header.get(DEAD_LETTER_SEQUENCE_HEADER)).toBe(
      String(published.streamSequence),
    );
    expect(deadLetter.header.get(DEAD_LETTER_DELIVERIES_HEADER)).toBe('5');
    expect(deadLetter.header.get(EVENT_NAME_HEADER)).toBe('task.updated.v1');
  });

  it.each([
    ['drop', undefined, 'restr'],
    ['copy', 'copy', 'restrcopy'],
  ] as const)(
    'copies a restricted event from the restricted stream, its body %s',
    async (
      mode: 'drop' | 'copy',
      restrictedDeadLetterPayload: 'copy' | undefined,
      suffix: string,
    ) => {
      const names: ReturnType<typeof isolatedNames> = isolatedNames(suffix);
      const application: TestingModule = await startApplication(
        [
          MessagingModule.forRoot(
            messagingOptions(nats, {
              ...names,
              service: 'notification-service',
              deadLetterWorker: true,
              restrictedEvents: ['task.updated.v1'],
              ...(restrictedDeadLetterPayload === undefined ? {} : { restrictedDeadLetterPayload }),
            }),
          ),
        ],
        { tuning: { retryDelaysMs: [50] } },
      );
      await application.get(EventConsumers).subscribe({
        handler: 'send-code',
        schemas: eventSchemas,
        event: 'task.updated.v1',
        handle: (): Promise<void> => Promise.reject(new Error('mail server unavailable')),
      });

      const published: PublishedEvent = await application
        .get(EventPublisher)
        .publish(eventSchemas, 'task.updated.v1', taskUpdated());
      await waitFor(async () => (await deadLetters(`EVENTS_DLQ_${suffix}`)) === 1);
      const deadLetter: StoredMsg = await lastDeadLetter(
        `EVENTS_DLQ_${suffix}`,
        `dlq-${suffix}.notification-service__send-code.restricted-${suffix}.task.updated.v1`,
      );
      await application.close();

      expect(published.stream).toBe(`EVENTS_RESTRICTED_${suffix}`);
      expect((await manager.streams.info(`EVENTS_${suffix}`)).state.messages).toBe(0);
      expect(deadLetter.header.get(DEAD_LETTER_REASON_HEADER)).toBe('max-deliveries');
      expect(deadLetter.header.get(DEAD_LETTER_DELIVERIES_HEADER)).toBe('2');
      expect(deadLetter.header.get(EVENT_NAME_HEADER)).toBe('task.updated.v1');
      expect(deadLetter.header.get('Nats-Msg-Id')).toBe(
        `EVENTS_RESTRICTED_${suffix}.notification-service__send-code.${String(published.streamSequence)}`,
      );
      if (mode === 'drop') {
        expect(deadLetter.data).toHaveLength(0);
        expect(deadLetter.header.get(DEAD_LETTER_PAYLOAD_HEADER)).toBe('dropped');
      } else {
        expect(deadLetter.json<TaskUpdatedV1>()).toMatchObject({ id: published.id });
        expect(deadLetter.header.has(DEAD_LETTER_PAYLOAD_HEADER)).toBe(false);
      }
    },
  );

  it('keeps trying to store a dead letter while the dead-letter stream is briefly missing', async () => {
    const names: ReturnType<typeof isolatedNames> = isolatedNames('dlqgone');
    const application: TestingModule = await startApplication([
      MessagingModule.forRoot(
        messagingOptions(nats, { ...names, service: 'search-service', deadLetterWorker: true }),
      ),
    ]);
    await application.get(EventConsumers).subscribe({
      handler: 'index-task',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      handle: (): Promise<void> => Promise.resolve(),
    });
    const dlq: StreamInfo = await manager.streams.info('EVENTS_DLQ_dlqgone');
    await manager.streams.delete('EVENTS_DLQ_dlqgone');

    const poisoned: PubAck = await jetstream(client).publish('evt-dlqgone.task.updated.v1', '{}');
    await delay(600);
    await manager.streams.add(dlq.config);
    await waitFor(async () => (await deadLetters('EVENTS_DLQ_dlqgone')) === 1, 10_000);
    const deadLetter: StoredMsg = await lastDeadLetter(
      'EVENTS_DLQ_dlqgone',
      'dlq-dlqgone.search-service__index-task.evt-dlqgone.task.updated.v1',
    );
    await application.close();

    expect(deadLetter.header.get(DEAD_LETTER_SEQUENCE_HEADER)).toBe(String(poisoned.seq));
  });

  it('stores a dead letter once when two workers run and the advisory is repeated', async () => {
    const names: ReturnType<typeof isolatedNames> = isolatedNames('once');
    const first: TestingModule = await startApplication([
      MessagingModule.forRoot(
        messagingOptions(nats, { ...names, service: 'search-service', deadLetterWorker: true }),
      ),
    ]);
    const second: TestingModule = await startApplication([
      MessagingModule.forRoot(
        messagingOptions(nats, { ...names, service: 'search-service', deadLetterWorker: true }),
      ),
    ]);
    await first.get(EventConsumers).subscribe({
      handler: 'index-task',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      handle: (): Promise<void> => Promise.resolve(),
    });

    const published: PubAck = await jetstream(client).publish('evt-once.task.updated.v1', '{}');
    await waitFor(async () => (await deadLetters('EVENTS_DLQ_once')) === 1);
    // The server repeats nothing by itself: the spec plays a second, identical advisory.
    client.publish(
      '$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.EVENTS_once.search-service__index-task',
      JSON.stringify({
        stream: 'EVENTS_once',
        consumer: 'search-service__index-task',
        stream_seq: published.seq,
        deliveries: 1,
      }),
    );
    await client.flush();
    await delay(500);
    await first.close();
    await second.close();

    expect(await deadLetters('EVENTS_DLQ_once')).toBe(1);
  });

  it('copies nothing unless the worker is turned on', async () => {
    const names: ReturnType<typeof isolatedNames> = isolatedNames('off');
    const application: TestingModule = await startApplication([
      MessagingModule.forRoot(messagingOptions(nats, { ...names, service: 'search-service' })),
    ]);
    await application.get(EventConsumers).subscribe({
      handler: 'index-task',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      handle: (): Promise<void> => Promise.resolve(),
    });

    await jetstream(client).publish('evt-off.task.updated.v1', '{}');
    await waitFor(
      async () =>
        (await manager.consumers.info('EVENTS_off', 'search-service__index-task'))
          .num_ack_pending === 0 &&
        (await manager.consumers.info('EVENTS_off', 'search-service__index-task')).delivered
          .stream_seq === 1,
    );
    await delay(500);
    await application.close();

    expect(await deadLetters('EVENTS_DLQ_off')).toBe(0);
  });
});
