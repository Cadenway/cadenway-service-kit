import { jetstreamManager, type JetStreamManager, type StreamInfo } from '@nats-io/jetstream';
import { RequestError, type NatsConnection } from '@nats-io/transport-node';
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { z } from 'zod';

import { EventConsumers } from '../consumer/event-consumers.js';
import { MessagingModule } from '../wiring/messaging.module.js';
import { EventStreamUnavailableError, RebuildFlushTimeoutError } from '../index.js';
import { EventPublisher } from '../publisher/event-publisher.js';
import { RebuildEmitter } from '../rebuild/emitter/rebuild-emitter.js';
import { isolatedNames, messagingOptions, startApplication } from '../testing/application.js';
import { eventSchemas, taskUpdated, type TaskUpdatedV1 } from '../testing/events.js';
import { startTestNats, type TestNats } from '../testing/nats.js';
import { waitFor } from '../testing/wait.js';
import { MessagingConnection, messagingHealthIndicator } from './messaging-connection.js';

/**
 * Constant taskItemSchema
 *
 * @description
 * Schema of the rebuild items of the specs.
 *
 * @type {z.ZodType<{ taskId: string }>}
 */
const taskItemSchema: z.ZodType<{ taskId: string }> = z.object({ taskId: z.string() });

/**
 * Constant DAY_NS
 *
 * @description
 * Nanoseconds in a day, the unit JetStream reports a maximum age in.
 *
 * @type {number}
 */
const DAY_NS: number = 86_400_000_000_000;

/**
 * Constant HOUR_NS
 *
 * @description
 * Nanoseconds in an hour, the maximum age of the restricted stream.
 *
 * @type {number}
 */
const HOUR_NS: number = 3_600_000_000_000;

describe('messaging connection on a real NATS server', () => {
  let nats: TestNats;
  let client: NatsConnection;
  let manager: JetStreamManager;

  beforeAll(async () => {
    nats = await startTestNats();
    client = await nats.connect();
    manager = await jetstreamManager(client);
  });

  afterAll(async () => {
    await client.close();
    await nats.stop();
  });

  it('creates the three streams with the limits of cadenway-ops when it manages them', async () => {
    const application: TestingModule = await startApplication([
      MessagingModule.forRoot(messagingOptions(nats)),
    ]);
    const events: StreamInfo = await manager.streams.info('EVENTS');
    const restricted: StreamInfo = await manager.streams.info('EVENTS_RESTRICTED');
    const deadLetters: StreamInfo = await manager.streams.info('EVENTS_DLQ');
    await application.close();

    const common: Record<string, unknown> = {
      storage: 'file',
      retention: 'limits',
      discard: 'old',
      duplicate_window: 120_000_000_000,
    };
    expect(events.config).toMatchObject({
      ...common,
      subjects: ['evt.>'],
      max_age: 7 * DAY_NS,
      max_bytes: 1_073_741_824,
    });
    expect(restricted.config).toMatchObject({
      ...common,
      subjects: ['restricted.>'],
      max_age: HOUR_NS,
      max_bytes: 67_108_864,
    });
    expect(deadLetters.config).toMatchObject({
      ...common,
      subjects: ['dlq.>'],
      max_age: 30 * DAY_NS,
      max_bytes: 268_435_456,
    });
    expect(events.config.allow_direct).toBe(false);
  });

  it('updates the limits of a stream that already exists', async () => {
    const application: TestingModule = await startApplication([
      MessagingModule.forRoot(
        messagingOptions(nats, { eventsMaxBytes: 2_097_152, deadLetterMaxAgeDays: 10 }),
      ),
    ]);
    const events: StreamInfo = await manager.streams.info('EVENTS');
    const deadLetters: StreamInfo = await manager.streams.info('EVENTS_DLQ');
    await application.close();

    expect(events.config.max_bytes).toBe(2_097_152);
    expect(deadLetters.config.max_age).toBe(10 * DAY_NS);
  });

  it('creates no stream by default and refuses to start when a stream it uses is missing', async () => {
    await expect(
      startApplication([
        MessagingModule.forRoot(
          messagingOptions(nats, { ...isolatedNames('missing'), manageStreams: false }),
        ),
      ]),
    ).rejects.toThrow(/The stream EVENTS_missing does not exist/u);
    await expect(
      startApplication([
        MessagingModule.forRoot(
          messagingOptions(nats, {
            ...isolatedNames('missing'),
            manageStreams: false,
            deadLetterWorker: true,
          }),
        ),
      ]),
    ).rejects.toThrow(
      /The stream EVENTS_missing, EVENTS_RESTRICTED_missing, EVENTS_DLQ_missing does not exist/u,
    );

    await expect(manager.streams.info('EVENTS_missing')).rejects.toThrow(/stream not found/u);
  });

  it('checks only the streams it uses when it does not manage them', async () => {
    await manager.streams.add({ name: 'EVENTS_partial', subjects: ['evt-partial.>'] });

    const application: TestingModule = await startApplication([
      MessagingModule.forRoot(
        messagingOptions(nats, { ...isolatedNames('partial'), manageStreams: false }),
      ),
    ]);
    await application.close();
    await expect(
      startApplication([
        MessagingModule.forRoot(
          messagingOptions(nats, {
            ...isolatedNames('partial'),
            manageStreams: false,
            restrictedEvents: ['user.sign-in-code-issued.v1'],
          }),
        ),
      ]),
    ).rejects.toThrow(/The stream EVENTS_RESTRICTED_partial does not exist/u);
  });

  it('fails clearly when a stream it uses disappears after start-up', async () => {
    const application: TestingModule = await startApplication([
      MessagingModule.forRoot(messagingOptions(nats, isolatedNames('lost'))),
    ]);
    await manager.streams.delete('EVENTS_lost');

    await expect(
      application.get(EventPublisher).publish(eventSchemas, 'task.updated.v1', taskUpdated()),
    ).rejects.toThrow(EventStreamUnavailableError);
    await expect(
      application.get(EventPublisher).publish(eventSchemas, 'task.updated.v1', taskUpdated()),
    ).rejects.toThrow(/stream EVENTS_lost is missing/u);
    await expect(
      application.get(EventConsumers).subscribe({
        handler: 'index-task',
        schemas: eventSchemas,
        event: 'task.updated.v1',
        handle: (): Promise<void> => Promise.resolve(),
      }),
    ).rejects.toThrow(/The stream EVENTS_lost does not exist/u);
    await application.close();
  });

  it('reports NATS ready through the health indicator, and down once the connection is closed', async () => {
    const application: TestingModule = await startApplication([
      MessagingModule.forRoot(messagingOptions(nats)),
    ]);
    const connection: MessagingConnection = application.get(MessagingConnection);

    expect(messagingHealthIndicator(connection).name).toBe('nats');
    await expect(messagingHealthIndicator(connection).check()).resolves.toBeUndefined();

    await application.close();

    expect(connection.isClosed()).toBe(true);
    await expect(messagingHealthIndicator(connection, 'events').check()).rejects.toThrow(/closed/u);
  });

  it('refuses wrong credentials instead of waiting for a connection forever', async () => {
    await expect(
      startApplication([
        MessagingModule.forRoot(messagingOptions(nats, { password: 'not-the-password' })),
      ]),
    ).rejects.toThrow();
  });

  it('closes within the shutdown timeout, and fails a rebuild flush in time, once the server is gone', async () => {
    const lost: TestNats = await startTestNats();
    const application: TestingModule = await startApplication([
      MessagingModule.forRoot(
        messagingOptions(lost, { shutdownTimeoutMs: 1000, rebuildTimeoutMs: 500 }),
      ),
    ]);
    await application.get(EventConsumers).subscribe({
      handler: 'index-task',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      handle: (): Promise<void> => Promise.resolve(),
    });
    await lost.stop();
    const emitter: RebuildEmitter = application.get(RebuildEmitter);

    const flushStarted: number = Date.now();
    await expect(
      emitter.emit({ consumer: 'search', entity: 'task', schema: taskItemSchema }, { taskId: 'A' }),
    ).resolves.toBeUndefined();
    // The client may detect the disconnect before the kit's flush timer expires.
    const failure: unknown = await emitter.flush().catch((error: unknown) => error);
    expect(
      failure instanceof RebuildFlushTimeoutError ||
        (failure instanceof RequestError && failure.message === 'connection disconnected'),
    ).toBe(true);
    const flushTook: number = Date.now() - flushStarted;
    const closeStarted: number = Date.now();
    await application.close();
    const closeTook: number = Date.now() - closeStarted;

    expect(flushTook).toBeLessThan(2000);
    expect(closeTook).toBeLessThan(4000);
    expect(application.get(MessagingConnection).isClosed()).toBe(true);
  }, 60_000);

  it('resumes publishing and consuming after a NATS restart', async () => {
    const application: TestingModule = await startApplication([
      MessagingModule.forRoot(messagingOptions(nats, isolatedNames('restart'))),
    ]);
    const publisher: EventPublisher = application.get(EventPublisher);
    const connection: MessagingConnection = application.get(MessagingConnection);
    const availability: boolean[] = [];
    const rejected: boolean[] = [];
    const removed: boolean[] = [];
    const rejectingListener = (available: boolean): Promise<never> => {
      rejected.push(available);
      return Promise.reject(new Error('The observer rejected.'));
    };
    const watchRejecting: (listener: typeof rejectingListener) => () => void =
      connection.watchAvailability.bind(connection);
    const unwatchRejected: () => void = watchRejecting(rejectingListener);
    const unwatch: () => void = connection.watchAvailability((available) => {
      availability.push(available);
    });
    connection.watchAvailability((available) => {
      removed.push(available);
    })();
    const received: string[] = [];
    await application.get(EventConsumers).subscribe({
      handler: 'index-task',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      handle: (payload: TaskUpdatedV1): Promise<void> => {
        received.push(payload.taskId);
        return Promise.resolve();
      },
    });
    await publisher.publish(eventSchemas, 'task.updated.v1', taskUpdated({ taskId: 'CAD-1' }));
    await waitFor(() => received.length === 1);
    expect(availability).toEqual([true]);

    await nats.restart();
    await waitFor(async () => {
      try {
        await publisher.publish(eventSchemas, 'task.updated.v1', taskUpdated({ taskId: 'CAD-2' }));
        return true;
      } catch {
        return false;
      }
    }, 60_000);
    await waitFor(() => received.includes('CAD-2'), 60_000);
    await waitFor(() => availability.includes(false) && availability.at(-1) === true, 60_000);
    await application.close();
    unwatch();
    unwatchRejected();

    expect(received[0]).toBe('CAD-1');
    expect(connection.isClosed()).toBe(true);
    expect(availability.at(-1)).toBe(false);
    expect(rejected).toEqual(availability);
    expect(removed).toEqual([true]);
  }, 120_000);
});
