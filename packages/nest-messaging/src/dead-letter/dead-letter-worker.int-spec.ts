import {
  jetstream,
  jetstreamManager,
  type JetStreamManager,
  type PubAck,
  type StoredMsg,
  type StreamInfo,
} from '@nats-io/jetstream';
import { headers, type MsgHdrs, type NatsConnection } from '@nats-io/transport-node';
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EventConsumers } from '../consumer/event-consumers.js';
import { MessagingModule } from '../messaging.module.js';
import {
  DEAD_LETTER_CONSUMER_HEADER,
  DEAD_LETTER_DELIVERIES_HEADER,
  DEAD_LETTER_REASON_HEADER,
  DEAD_LETTER_SEQUENCE_HEADER,
  EVENT_NAME_HEADER,
  ORGANIZATION_ID_HEADER,
} from '../publisher/event-headers.js';
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

  beforeAll(async () => {
    nats = await startTestNats();
    client = await nats.connect();
    manager = await jetstreamManager(client);
  });

  afterAll(async () => {
    await client.close();
    await nats.stop();
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
    const application: TestingModule = await startApplication([
      MessagingModule.forRoot(
        messagingOptions(nats, {
          ...names,
          service: 'search-service',
          deadLetterWorker: true,
          retryDelaysMs: [50, 50, 50, 50],
        }),
      ),
    ]);
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

  it('copies a restricted event from the restricted stream as well', async () => {
    const names: ReturnType<typeof isolatedNames> = isolatedNames('restr');
    const application: TestingModule = await startApplication([
      MessagingModule.forRoot(
        messagingOptions(nats, {
          ...names,
          service: 'notification-service',
          deadLetterWorker: true,
          restrictedEvents: ['task.updated.v1'],
          retryDelaysMs: [50],
        }),
      ),
    ]);
    await application.get(EventConsumers).subscribe({
      handler: 'send-code',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      handle: (): Promise<void> => Promise.reject(new Error('mail server unavailable')),
    });

    const published: PublishedEvent = await application
      .get(EventPublisher)
      .publish(eventSchemas, 'task.updated.v1', taskUpdated());
    await waitFor(async () => (await deadLetters('EVENTS_DLQ_restr')) === 1);
    const deadLetter: StoredMsg = await lastDeadLetter(
      'EVENTS_DLQ_restr',
      'dlq-restr.notification-service__send-code.restricted-restr.task.updated.v1',
    );
    await application.close();

    expect(published.stream).toBe('EVENTS_RESTRICTED_restr');
    expect((await manager.streams.info('EVENTS_restr')).state.messages).toBe(0);
    expect(deadLetter.json<TaskUpdatedV1>()).toMatchObject({ id: published.id });
    expect(deadLetter.header.get(DEAD_LETTER_REASON_HEADER)).toBe('max-deliveries');
    expect(deadLetter.header.get(DEAD_LETTER_DELIVERIES_HEADER)).toBe('2');
    expect(deadLetter.header.get('Nats-Msg-Id')).toBe(
      `EVENTS_RESTRICTED_restr.notification-service__send-code.${String(published.streamSequence)}`,
    );
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
