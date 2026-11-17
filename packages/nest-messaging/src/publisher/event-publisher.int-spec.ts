import {
  jetstreamManager,
  type JetStreamManager,
  type StoredMsg,
  type StreamInfo,
} from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';
import type { TestingModule } from '@nestjs/testing';
import { context, ROOT_CONTEXT, trace, TraceFlags } from '@opentelemetry/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { EventValidationError } from '../events/event-validation-error.js';
import { MessagingModule } from '../wiring/messaging.module.js';
import {
  disableTracePropagation,
  enableTracePropagation,
  messagingOptions,
  startApplication,
} from '../testing/application.js';
import {
  ATELIER_NORD,
  eventSchemas,
  taskUpdated,
  userSignedUp,
  type TaskUpdatedV1,
} from '../testing/events.js';
import { startTestNats, type TestNats } from '../testing/nats.js';
import {
  EVENT_NAME_HEADER,
  ORGANIZATION_ID_HEADER,
  TRACEPARENT_HEADER,
} from '../transport/event-headers.js';
import { EventPublisher, type PublishedEvent } from './event-publisher.js';

describe('event publisher on a real NATS server', () => {
  let nats: TestNats;
  let client: NatsConnection;
  let manager: JetStreamManager;
  let application: TestingModule;
  let publisher: EventPublisher;

  /**
   * Function stored
   *
   * @description
   * Reads a message of the events stream by its sequence.
   *
   * @param {number} sequence - Sequence in the stream.
   * @returns {Promise<StoredMsg>} The stored message.
   */
  async function stored(sequence: number): Promise<StoredMsg> {
    const message: StoredMsg | null = await manager.streams.getMessage('EVENTS', { seq: sequence });
    if (message === null) {
      throw new Error(`No message at sequence ${String(sequence)}.`);
    }
    return message;
  }

  beforeAll(async () => {
    enableTracePropagation();
    nats = await startTestNats();
    client = await nats.connect();
    manager = await jetstreamManager(client);
    application = await startApplication([
      MessagingModule.forRoot(messagingOptions(nats, { service: 'api-gateway' })),
    ]);
    publisher = application.get(EventPublisher);
  });

  afterAll(async () => {
    await application.close();
    await client.close();
    await nats.stop();
    disableTracePropagation();
  });

  it('completes, validates and publishes an event on its derived subject with its headers', async () => {
    const before: number = Date.now();
    const published: PublishedEvent = await context.with(
      trace.setSpanContext(ROOT_CONTEXT, {
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
        traceFlags: TraceFlags.SAMPLED,
      }),
      () => publisher.publish(eventSchemas, 'task.updated.v1', taskUpdated({ version: 7 })),
    );
    const message: StoredMsg = await stored(published.streamSequence);
    const payload: TaskUpdatedV1 = message.json<TaskUpdatedV1>();

    expect(published).toMatchObject({ stream: 'EVENTS', duplicate: false });
    expect(message.subject).toBe('evt.task.updated.v1');
    expect(z.uuidv7().safeParse(published.id).success).toBe(true);
    expect(payload).toEqual({
      ...taskUpdated({ version: 7 }),
      id: published.id,
      occurredAt: payload.occurredAt,
    });
    expect(Date.parse(payload.occurredAt)).toBeGreaterThanOrEqual(before);
    expect(message.header.get('Nats-Msg-Id')).toBe(published.id);
    expect(message.header.get(EVENT_NAME_HEADER)).toBe('task.updated.v1');
    expect(message.header.get(ORGANIZATION_ID_HEADER)).toBe(ATELIER_NORD);
    expect(message.header.get(TRACEPARENT_HEADER)).toBe(
      '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    );
  });

  it('sends no organization header for an event outside any organization, and no trace context outside a trace', async () => {
    const published: PublishedEvent = await publisher.publish(
      eventSchemas,
      'user.signed-up.v1',
      userSignedUp(),
    );
    const message: StoredMsg = await stored(published.streamSequence);

    expect(message.subject).toBe('evt.user.signed-up.v1');
    expect(message.header.has(ORGANIZATION_ID_HEADER)).toBe(false);
    expect(message.header.has(TRACEPARENT_HEADER)).toBe(false);
    expect(message.header.get(EVENT_NAME_HEADER)).toBe('user.signed-up.v1');
  });

  it('sends nothing when the payload does not match its contract', async () => {
    const before: StreamInfo = await manager.streams.info('EVENTS');

    await expect(
      publisher.publish(eventSchemas, 'task.updated.v1', taskUpdated({ version: 1.5 })),
    ).rejects.toThrow(EventValidationError);

    const after: StreamInfo = await manager.streams.info('EVENTS');
    expect(after.state.messages).toBe(before.state.messages);
  });

  it('lets the server drop an event published twice with the same id', async () => {
    const first: PublishedEvent = await publisher.publish(
      eventSchemas,
      'task.updated.v1',
      taskUpdated(),
    );
    const payload: TaskUpdatedV1 = (await stored(first.streamSequence)).json<TaskUpdatedV1>();

    const again: PublishedEvent = await publisher.publishEnvelope({
      name: 'task.updated.v1',
      subject: 'evt.task.updated.v1',
      stream: 'EVENTS',
      payload,
      traceparent: null,
    });

    expect(again).toEqual({ ...first, duplicate: true });
  });

  it('refuses to publish when the subject is stored by another stream than the expected one', async () => {
    const payload: TaskUpdatedV1 = {
      ...taskUpdated(),
      id: '0193a1f0-0000-7000-8000-0000000000e9',
      occurredAt: '2026-11-14T09:30:00.000Z',
    };
    const before: StreamInfo = await manager.streams.info('EVENTS');

    await expect(
      publisher.publishEnvelope({
        name: 'task.updated.v1',
        subject: 'evt.task.updated.v1',
        stream: 'EVENTS_RESTRICTED',
        payload,
        traceparent: null,
      }),
    ).rejects.toThrow(/expected stream does not match/u);

    expect((await manager.streams.info('EVENTS')).state.messages).toBe(before.state.messages);
  });
});
