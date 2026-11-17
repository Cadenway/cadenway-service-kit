import {
  AckPolicy,
  jetstreamManager,
  type ConsumerInfo,
  type JetStreamManager,
  type StoredMsg,
} from '@nats-io/jetstream';
import { nanos, type NatsConnection } from '@nats-io/transport-node';
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MessagingModule } from '../../wiring/messaging.module.js';
import { EventPublisher, type PublishedEvent } from '../../publisher/event-publisher.js';
import {
  DEAD_LETTER_DELIVERIES_HEADER,
  DEAD_LETTER_REASON_HEADER,
  DEAD_LETTER_SEQUENCE_HEADER,
} from '../../transport/event-headers.js';
import { isolatedNames, messagingOptions, startApplication } from '../../testing/application.js';
import { eventSchemas, taskUpdated, type TaskUpdatedV1 } from '../../testing/events.js';
import { startTestNats, type TestNats } from '../../testing/nats.js';
import { delay, waitFor } from '../../testing/wait.js';
import { EventConsumers, type EventContext } from '../event-consumers.js';
import type { EventRedelivery } from './event-redelivery.js';

/**
 * Interface Attempt
 *
 * @description
 * One call of a failing handler, as the specs record it.
 */
interface Attempt {
  // #region Properties
  /**
   * Property deliveryCount
   *
   * @description
   * Delivery number the handler was told.
   *
   * @type {number}
   * @readonly
   */
  readonly deliveryCount: number;

  /**
   * Property at
   *
   * @description
   * Instant of the call, in milliseconds.
   *
   * @type {number}
   * @readonly
   */
  readonly at: number;

  /**
   * Property deadLetters
   *
   * @description
   * Number of dead letters stored when the call started.
   *
   * @type {number}
   * @readonly
   */
  readonly deadLetters: number;
  // #endregion
}

describe('per-subscription redelivery schedule on a real NATS server', () => {
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
    return (await manager.streams.info(stream)).state.messages;
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

  /**
   * Function startFailing
   *
   * @description
   * Starts an application whose one handler always fails, with the given schedule, and records
   * its calls with the dead letters stored at that time.
   *
   * @param {string} suffix - Isolated stream and subject names of the spec.
   * @param {EventRedelivery | undefined} redelivery - Schedule of the handler.
   * @param {Attempt[]} attempts - Calls of the handler, appended to.
   * @returns {Promise<TestingModule>} The running application.
   */
  async function startFailing(
    suffix: string,
    redelivery: EventRedelivery | undefined,
    attempts: Attempt[],
  ): Promise<TestingModule> {
    const application: TestingModule = await startApplication([
      MessagingModule.forRoot(
        messagingOptions(nats, {
          ...isolatedNames(suffix),
          service: 'search-service',
          deadLetterWorker: true,
        }),
      ),
    ]);
    await application.get(EventConsumers).subscribe({
      handler: 'index-task',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      ...(redelivery === undefined ? {} : { redelivery }),
      handle: async (_payload: TaskUpdatedV1, eventContext: EventContext): Promise<void> => {
        attempts.push({
          deliveryCount: eventContext.deliveryCount,
          at: Date.now(),
          deadLetters: await deadLetters(`EVENTS_DLQ_${suffix}`),
        });
        throw new Error('projection store unavailable');
      },
    });
    return application;
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

  it('redelivers a failing handler on its own schedule, repeating the last delay, and dead-letters it only after its delivery limit', async () => {
    const attempts: Attempt[] = [];
    const application: TestingModule = await startFailing(
      'sched',
      { delaysMs: [300, 600, 900], maxDeliveries: 6 },
      attempts,
    );
    const consumer: ConsumerInfo = await manager.consumers.info(
      'EVENTS_sched',
      'search-service__index-task',
    );

    const published: PublishedEvent = await application
      .get(EventPublisher)
      .publish(eventSchemas, 'task.updated.v1', taskUpdated());
    await waitFor(async () => (await deadLetters('EVENTS_DLQ_sched')) === 1, 20_000);
    const deadLetter: StoredMsg = await lastDeadLetter(
      'EVENTS_DLQ_sched',
      'dlq-sched.search-service__index-task.evt-sched.task.updated.v1',
    );
    await delay(1500);
    await application.close();

    expect(consumer.config).toMatchObject({
      ack_policy: 'explicit',
      ack_wait: nanos(30_000),
      max_deliver: 6,
    });
    expect(consumer.config.backoff).toBeUndefined();
    expect(attempts.map((attempt: Attempt) => attempt.deliveryCount)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(attempts.map((attempt: Attempt) => attempt.deadLetters)).toEqual([0, 0, 0, 0, 0, 0]);
    const gaps: number[] = attempts
      .slice(1)
      .map((attempt: Attempt, index: number) => attempt.at - (attempts[index]?.at ?? 0));
    const expected: number[] = [300, 600, 900, 900, 900];
    gaps.forEach((gap: number, index: number) => {
      expect(gap).toBeGreaterThanOrEqual((expected[index] ?? 0) - 20);
      expect(gap).toBeLessThan((expected[index] ?? 0) + 1000);
    });
    expect(deadLetter.header.get(DEAD_LETTER_REASON_HEADER)).toBe('max-deliveries');
    expect(deadLetter.header.get(DEAD_LETTER_DELIVERIES_HEADER)).toBe('6');
    expect(deadLetter.header.get(DEAD_LETTER_SEQUENCE_HEADER)).toBe(
      String(published.streamSequence),
    );
    expect(await deadLetters('EVENTS_DLQ_sched')).toBe(1);
  });

  it('keeps the default schedule for a handler without its own, next to one with a schedule', async () => {
    const application: TestingModule = await startApplication([
      MessagingModule.forRoot(
        messagingOptions(nats, { ...isolatedNames('mixed'), service: 'search-service' }),
      ),
    ]);
    const consumers: EventConsumers = application.get(EventConsumers);
    await consumers.subscribe({
      handler: 'default-handler',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      handle: (): Promise<void> => Promise.resolve(),
    });
    await consumers.subscribe({
      handler: 'scheduled-handler',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      redelivery: { delaysMs: [1000, 60_000], maxDeliveries: 12 },
      handle: (): Promise<void> => Promise.resolve(),
    });
    const ordinary: ConsumerInfo = await manager.consumers.info(
      'EVENTS_mixed',
      'search-service__default-handler',
    );
    const scheduled: ConsumerInfo = await manager.consumers.info(
      'EVENTS_mixed',
      'search-service__scheduled-handler',
    );
    await application.close();

    expect(ordinary.config.max_deliver).toBe(5);
    expect(scheduled.config.max_deliver).toBe(12);
    expect(ordinary.config.ack_wait).toBe(nanos(30_000));
    expect(scheduled.config.ack_wait).toBe(nanos(30_000));
    expect(scheduled.config.backoff).toBeUndefined();
  });

  it('updates the delivery limit of an existing durable consumer in place, keeping its position and pending messages', async () => {
    const attempts: Attempt[] = [];
    const first: TestingModule = await startFailing(
      'inplace',
      { delaysMs: [1500], maxDeliveries: 3 },
      attempts,
    );
    const before: ConsumerInfo = await manager.consumers.info(
      'EVENTS_inplace',
      'search-service__index-task',
    );
    await first.get(EventPublisher).publish(eventSchemas, 'task.updated.v1', taskUpdated());
    await waitFor(() => attempts.length === 2);
    await first.close();

    const second: TestingModule = await startFailing(
      'inplace',
      { delaysMs: [200], maxDeliveries: 5 },
      attempts,
    );
    const after: ConsumerInfo = await manager.consumers.info(
      'EVENTS_inplace',
      'search-service__index-task',
    );
    await waitFor(async () => (await deadLetters('EVENTS_DLQ_inplace')) === 1, 20_000);
    const deadLetter: StoredMsg = await lastDeadLetter(
      'EVENTS_DLQ_inplace',
      'dlq-inplace.search-service__index-task.evt-inplace.task.updated.v1',
    );
    await delay(600);
    await second.close();

    expect(before.config.max_deliver).toBe(3);
    expect(after.config.max_deliver).toBe(5);
    expect(after.created).toBe(before.created);
    expect(attempts.map((attempt: Attempt) => attempt.deliveryCount)).toEqual([1, 2, 3, 4, 5]);
    expect(deadLetter.header.get(DEAD_LETTER_DELIVERIES_HEADER)).toBe('5');
  });

  it('dead-letters a pending message that already reached a lowered delivery limit without delivering it again', async () => {
    const attempts: Attempt[] = [];
    const first: TestingModule = await startFailing(
      'lower',
      { delaysMs: [1500], maxDeliveries: 10 },
      attempts,
    );
    await first.get(EventPublisher).publish(eventSchemas, 'task.updated.v1', taskUpdated());
    await waitFor(() => attempts.length === 3, 20_000);
    await first.close();

    const second: TestingModule = await startFailing(
      'lower',
      { delaysMs: [200], maxDeliveries: 2 },
      attempts,
    );
    await waitFor(async () => (await deadLetters('EVENTS_DLQ_lower')) === 1, 20_000);
    const deadLetter: StoredMsg = await lastDeadLetter(
      'EVENTS_DLQ_lower',
      'dlq-lower.search-service__index-task.evt-lower.task.updated.v1',
    );
    const consumer: ConsumerInfo = await manager.consumers.info(
      'EVENTS_lower',
      'search-service__index-task',
    );
    await delay(600);
    await second.close();

    expect(consumer.config.max_deliver).toBe(2);
    expect(consumer.num_ack_pending).toBe(0);
    expect(attempts.map((attempt: Attempt) => attempt.deliveryCount)).toEqual([1, 2, 3]);
    expect(deadLetter.header.get(DEAD_LETTER_REASON_HEADER)).toBe('max-deliveries');
    expect(deadLetter.header.get(DEAD_LETTER_DELIVERIES_HEADER)).toBe('3');
  });

  it('refuses an invalid schedule before creating the consumer', async () => {
    const application: TestingModule = await startApplication([
      MessagingModule.forRoot(
        messagingOptions(nats, { ...isolatedNames('invalid'), service: 'search-service' }),
      ),
    ]);
    const consumers: EventConsumers = application.get(EventConsumers);

    await expect(
      consumers.subscribe({
        handler: 'index-task',
        schemas: eventSchemas,
        event: 'task.updated.v1',
        redelivery: { delaysMs: [1000, 2000, 3000], maxDeliveries: 3 },
        handle: (): Promise<void> => Promise.resolve(),
      }),
    ).rejects.toThrow(/must exceed its 3 redelivery delays/u);
    await expect(
      consumers.subscribe({
        handler: 'index-task',
        schemas: eventSchemas,
        event: 'task.updated.v1',
        redelivery: { delaysMs: [86_400_000], maxDeliveries: 8 },
        handle: (): Promise<void> => Promise.resolve(),
      }),
    ).rejects.toThrow(/would be dropped before its dead letter/u);
    await expect(
      manager.consumers.info('EVENTS_invalid', 'search-service__index-task'),
    ).rejects.toThrow(/consumer not found/iu);
    await consumers.subscribe({
      handler: 'index-task',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      redelivery: { delaysMs: [1000, 2000, 3000], maxDeliveries: 4 },
      handle: (): Promise<void> => Promise.resolve(),
    });
    await application.close();
  });

  it('checks the delivery limit of a consumer it does not manage against a custom schedule only', async () => {
    const owner: TestingModule = await startApplication([
      MessagingModule.forRoot(messagingOptions(nats, isolatedNames('unmanaged'))),
    ]);
    await manager.consumers.add('EVENTS_unmanaged', {
      durable_name: 'search-service__index-task',
      name: 'search-service__index-task',
      filter_subject: 'evt-unmanaged.task.updated.v1',
      ack_policy: AckPolicy.Explicit,
      ack_wait: nanos(30_000),
      max_deliver: 5,
    });
    const application: TestingModule = await startApplication([
      MessagingModule.forRoot(
        messagingOptions(nats, {
          ...isolatedNames('unmanaged'),
          service: 'search-service',
          manageStreams: false,
          manageConsumers: false,
        }),
      ),
    ]);
    const consumers: EventConsumers = application.get(EventConsumers);

    await expect(
      consumers.subscribe({
        handler: 'index-task',
        schemas: eventSchemas,
        event: 'task.updated.v1',
        redelivery: { delaysMs: [1000, 60_000], maxDeliveries: 32 },
        handle: (): Promise<void> => Promise.resolve(),
      }),
    ).rejects.toThrow(/allows 5 deliveries, but its handler expects 32/u);
    await consumers.subscribe({
      handler: 'index-task',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      redelivery: { delaysMs: [1000, 60_000, 60_000, 60_000] },
      handle: (): Promise<void> => Promise.resolve(),
    });
    const consumer: ConsumerInfo = await manager.consumers.info(
      'EVENTS_unmanaged',
      'search-service__index-task',
    );
    await application.close();
    await owner.close();

    expect(consumer.config.max_deliver).toBe(5);
  });
});
