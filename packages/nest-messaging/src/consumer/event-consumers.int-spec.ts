import {
  getOrganizationContext,
  type HealthIndicator,
  type OrganizationContext,
} from '@cadenway/nest-common';
import {
  AckPolicy,
  jetstream,
  jetstreamManager,
  type ConsumerConfig,
  type ConsumerInfo,
  type JetStreamClient,
  type JetStreamManager,
} from '@nats-io/jetstream';
import { nanos, type NatsConnection } from '@nats-io/transport-node';
import { Logger } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { context, ROOT_CONTEXT, SpanStatusCode, trace, TraceFlags } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { z } from 'zod';

import {
  MessagingConnection,
  messagingHealthIndicator,
} from '../connection/messaging-connection.js';
import { MessagingModule } from '../wiring/messaging.module.js';
import { EventPublisher, type PublishedEvent } from '../publisher/event-publisher.js';
import {
  disableTracePropagation,
  enableTracePropagation,
  isolatedNames,
  messagingOptions,
  startApplication,
} from '../testing/application.js';
import {
  ATELIER_NORD,
  CAMILLE,
  eventSchemas,
  taskUpdated,
  userSignedUp,
  type TaskUpdatedV1,
  type UserSignedUpV1,
} from '../testing/events.js';
import { taskUpdatedV1Schema } from '../testing/contracts/events/task-service.js';
import { startTestNats, type TestNats } from '../testing/nats.js';
import { delay, waitFor } from '../testing/wait.js';
import { EventConsumers, type EventContext } from './event-consumers.js';

/**
 * Constant nextEventSchemas
 *
 * @description
 * The event `task.updated.v1` as a later minor of the contracts could generate it, with one more
 * kind of actor.
 *
 * @type {{ readonly 'task.updated.v1': z.ZodType<Omit<TaskUpdatedV1, 'actor'> & { actor: { type: string; id: string } }> }}
 */
const nextEventSchemas: {
  readonly 'task.updated.v1': z.ZodType<
    Omit<TaskUpdatedV1, 'actor'> & { actor: { type: string; id: string } }
  >;
} = {
  'task.updated.v1': taskUpdatedV1Schema.extend({
    actor: z.object({
      type: z.enum(['user', 'automation', 'git', 'system', 'service-account']),
      id: z.string(),
    }),
  }),
};

/**
 * Interface Delivery
 *
 * @description
 * What a handler of the specs records for each call.
 */
interface Delivery {
  // #region Properties
  /**
   * Property taskId
   *
   * @description
   * Task of the event received.
   *
   * @type {string}
   * @readonly
   */
  readonly taskId: string;

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
   * Property redelivered
   *
   * @description
   * Whether the handler was told the message is a redelivery.
   *
   * @type {boolean}
   * @readonly
   */
  readonly redelivered: boolean;

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
  // #endregion
}

/**
 * Function record
 *
 * @description
 * Builds the record of one handler call.
 *
 * @param {TaskUpdatedV1} payload - Payload received.
 * @param {EventContext} eventContext - Context received.
 * @returns {Delivery} The record.
 */
function record(payload: TaskUpdatedV1, eventContext: EventContext): Delivery {
  return {
    taskId: payload.taskId,
    deliveryCount: eventContext.deliveryCount,
    redelivered: eventContext.redelivered,
    at: Date.now(),
  };
}

// This spec imports the main entry point only: no database module, no deduplicator.
describe('event consumers on a real NATS server, without a database', () => {
  let nats: TestNats;
  let client: NatsConnection;
  let manager: JetStreamManager;

  beforeAll(async () => {
    enableTracePropagation();
    nats = await startTestNats();
    client = await nats.connect();
    manager = await jetstreamManager(client);
  });

  afterAll(async () => {
    await client.close();
    await nats.stop();
    disableTracePropagation();
  });

  it('delivers a published event to its handler, typed, inside the organization context and the trace of the publisher', async () => {
    const application: TestingModule = await startApplication([
      MessagingModule.forRoot(messagingOptions(nats, { service: 'search-service' })),
    ]);
    const seen: {
      payload: TaskUpdatedV1;
      eventContext: EventContext;
      organization: OrganizationContext | undefined;
      traceId: string | undefined;
      apply: boolean;
    }[] = [];
    await application.get(EventConsumers).subscribe({
      handler: 'index-task',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      handle: async (payload: TaskUpdatedV1, eventContext: EventContext): Promise<void> => {
        seen.push({
          payload,
          eventContext,
          organization: getOrganizationContext(),
          traceId: trace.getSpanContext(context.active())?.traceId,
          apply: await eventContext.claimVersion(payload.taskId),
        });
      },
    });

    const published: PublishedEvent = await context.with(
      trace.setSpanContext(ROOT_CONTEXT, {
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
        traceFlags: TraceFlags.SAMPLED,
      }),
      () =>
        application
          .get(EventPublisher)
          .publish(eventSchemas, 'task.updated.v1', taskUpdated({ version: 4 })),
    );
    await waitFor(() => seen.length === 1);
    await waitFor(
      async () =>
        (await manager.consumers.info('EVENTS', 'search-service__index-task')).num_ack_pending ===
        0,
    );
    const consumer: ConsumerInfo = await manager.consumers.info(
      'EVENTS',
      'search-service__index-task',
    );
    await application.close();

    expect(seen[0]?.payload).toMatchObject({
      id: published.id,
      organizationId: ATELIER_NORD,
      taskId: 'CAD-482',
      version: 4,
    });
    expect(seen[0]?.eventContext).toMatchObject({
      deliveryCount: 1,
      redelivered: false,
      streamSequence: published.streamSequence,
    });
    expect(seen[0]?.organization).toEqual({
      organizationId: ATELIER_NORD,
      actor: { type: 'user', id: CAMILLE },
      role: null,
      scopes: [],
    });
    expect(seen[0]?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(seen[0]?.apply).toBe(true);
    expect(consumer.config).toMatchObject({
      durable_name: 'search-service__index-task',
      filter_subject: 'evt.task.updated.v1',
      ack_policy: 'explicit',
      ack_wait: 30_000_000_000,
      max_deliver: 5,
      deliver_policy: 'all',
    });
    expect(consumer.config.backoff).toBeUndefined();
    expect(consumer.config.deliver_subject).toBeUndefined();
    expect(consumer.num_redelivered).toBe(0);
  });

  it('runs the handler of an event without an organization outside any organization', async () => {
    const application: TestingModule = await startApplication([
      MessagingModule.forRoot(
        messagingOptions(nats, { ...isolatedNames('signup'), service: 'notification-service' }),
      ),
    ]);
    const seen: (OrganizationContext | undefined)[] = [];
    const users: string[] = [];
    await application.get(EventConsumers).subscribe({
      handler: 'welcome',
      schemas: eventSchemas,
      event: 'user.signed-up.v1',
      handle: (payload: UserSignedUpV1): Promise<void> => {
        users.push(payload.userId);
        seen.push(getOrganizationContext());
        return Promise.resolve();
      },
    });

    await application
      .get(EventPublisher)
      .publish(eventSchemas, 'user.signed-up.v1', userSignedUp());
    await waitFor(() => seen.length === 1);
    await application.close();

    expect(users).toEqual([CAMILLE]);
    expect(seen[0]).toEqual({
      organizationId: null,
      actor: { type: 'user', id: CAMILLE },
      role: null,
      scopes: [],
    });
  });

  it('calls the handler for every copy of an event when the application has no deduplicator', async () => {
    const application: TestingModule = await startApplication([
      MessagingModule.forRoot(
        messagingOptions(nats, { ...isolatedNames('copies'), service: 'realtime-gateway' }),
      ),
    ]);
    const seen: string[] = [];
    await application.get(EventConsumers).subscribe({
      handler: 'push',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      handle: (payload: TaskUpdatedV1): Promise<void> => {
        seen.push(payload.id);
        return Promise.resolve();
      },
    });
    const first: PublishedEvent = await application
      .get(EventPublisher)
      .publish(eventSchemas, 'task.updated.v1', taskUpdated());
    await waitFor(() => seen.length === 1);

    // The same event stored a second time, as after the deduplication window of the stream.
    await jetstream(client).publish(
      'evt-copies.task.updated.v1',
      JSON.stringify({ ...taskUpdated(), id: first.id, occurredAt: '2026-11-14T09:30:00.000Z' }),
    );
    await waitFor(() => seen.length === 2);
    await application.close();

    expect(seen).toEqual([first.id, first.id]);
  });

  it('redelivers after a handler failure, following the retry delays, until the handler succeeds', async () => {
    const application: TestingModule = await startApplication(
      [
        MessagingModule.forRoot(
          messagingOptions(nats, { ...isolatedNames('retry'), service: 'search-service' }),
        ),
      ],
      { tuning: { retryDelaysMs: [300, 600, 50, 50] } },
    );
    const deliveries: Delivery[] = [];
    await application.get(EventConsumers).subscribe({
      handler: 'index-task',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      handle: (payload: TaskUpdatedV1, eventContext: EventContext): Promise<void> => {
        deliveries.push(record(payload, eventContext));
        return eventContext.deliveryCount < 3
          ? Promise.reject(new Error('index unavailable'))
          : Promise.resolve();
      },
    });

    await application.get(EventPublisher).publish(eventSchemas, 'task.updated.v1', taskUpdated());
    await waitFor(() => deliveries.length === 3);
    await waitFor(
      async () =>
        (await manager.consumers.info('EVENTS_retry', 'search-service__index-task'))
          .num_ack_pending === 0,
    );
    await delay(300);
    await application.close();

    expect(deliveries.map((delivery: Delivery) => delivery.deliveryCount)).toEqual([1, 2, 3]);
    expect(deliveries.map((delivery: Delivery) => delivery.redelivered)).toEqual([
      false,
      true,
      true,
    ]);
    const first: number = (deliveries[1]?.at ?? 0) - (deliveries[0]?.at ?? 0);
    const second: number = (deliveries[2]?.at ?? 0) - (deliveries[1]?.at ?? 0);
    expect(first).toBeGreaterThanOrEqual(280);
    expect(first).toBeLessThan(580);
    expect(second).toBeGreaterThanOrEqual(580);
    expect(second).toBeLessThan(2000);
  });

  it('refuses concurrent registrations of the same handler', async () => {
    const application: TestingModule = await startApplication([
      MessagingModule.forRoot(messagingOptions(nats, isolatedNames('twice'))),
    ]);
    const consumers: EventConsumers = application.get(EventConsumers);
    const register = (): Promise<void> =>
      consumers.subscribe({
        handler: 'notify',
        schemas: eventSchemas,
        event: 'task.updated.v1',
        handle: (): Promise<void> => Promise.resolve(),
      });
    const initial: Promise<void> = register();
    try {
      const duplicate = expect(register()).rejects.toThrow(/already registered/u);
      await Promise.all([initial, duplicate]);
    } finally {
      await application.close();
    }
  });

  it('rejects a pending registration if shutdown starts while opening the consumer', async () => {
    const application: TestingModule = await startApplication([
      MessagingModule.forRoot(messagingOptions(nats, isolatedNames('register-stop'))),
    ]);
    const consumers: EventConsumers = application.get(EventConsumers);
    const connection: MessagingConnection = application.get(MessagingConnection);
    let release: () => void = (): void => undefined;
    const gate: Promise<void> = new Promise<void>((resolve: () => void) => {
      release = resolve;
    });
    // The build removes the internal manager method from the public declaration.
    const lookup = vi
      .spyOn(
        connection as MessagingConnection & { manager(): Promise<JetStreamManager> },
        'manager',
      )
      .mockImplementationOnce(async () => {
        await gate;
        return manager;
      });
    const registering: Promise<void> = consumers.subscribe({
      handler: 'notify',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      handle: (): Promise<void> => Promise.resolve(),
    });

    try {
      expect(lookup).toHaveBeenCalledOnce();
      const stopped = expect(registering).rejects.toThrow(/application is shutting down/u);
      await consumers.beforeApplicationShutdown();
      release();
      await stopped;
    } finally {
      release();
      lookup.mockRestore();
      await application.close();
    }
  });

  it('refuses to turn the consumer of a handler towards another event', async () => {
    const first: TestingModule = await startApplication([
      MessagingModule.forRoot(messagingOptions(nats, isolatedNames('filter'))),
    ]);
    await first.get(EventConsumers).subscribe({
      handler: 'notify',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      handle: (): Promise<void> => Promise.resolve(),
    });
    await first.close();
    const second: TestingModule = await startApplication([
      MessagingModule.forRoot(messagingOptions(nats, isolatedNames('filter'))),
    ]);

    await expect(
      second.get(EventConsumers).subscribe({
        handler: 'notify',
        schemas: eventSchemas,
        event: 'user.signed-up.v1',
        handle: (): Promise<void> => Promise.resolve(),
      }),
    ).rejects.toThrow(/does not filter evt-filter\.user\.signed-up\.v1/u);
    await second.close();
  });

  it('binds to a consumer created elsewhere when it does not manage consumers, and fails clearly when it is missing', async () => {
    const owner: TestingModule = await startApplication([
      MessagingModule.forRoot(messagingOptions(nats, isolatedNames('bind'))),
    ]);
    const application: TestingModule = await startApplication([
      MessagingModule.forRoot(
        messagingOptions(nats, {
          ...isolatedNames('bind'),
          service: 'search-service',
          manageStreams: false,
          manageConsumers: false,
        }),
      ),
    ]);
    const consumers: EventConsumers = application.get(EventConsumers);
    const seen: string[] = [];

    await expect(
      consumers.subscribe({
        handler: 'index-task',
        schemas: eventSchemas,
        event: 'task.updated.v1',
        handle: (): Promise<void> => Promise.resolve(),
      }),
    ).rejects.toThrow(
      /The durable consumer search-service__index-task does not exist on the stream EVENTS_bind/u,
    );

    await manager.consumers.add('EVENTS_bind', {
      durable_name: 'search-service__index-task',
      name: 'search-service__index-task',
      filter_subject: 'evt-bind.task.updated.v1',
      ack_policy: AckPolicy.Explicit,
      ack_wait: nanos(30_000),
      max_deliver: 5,
    });
    await consumers.subscribe({
      handler: 'index-task',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      handle: (payload: TaskUpdatedV1): Promise<void> => {
        seen.push(payload.taskId);
        return Promise.resolve();
      },
    });
    await owner.get(EventPublisher).publish(eventSchemas, 'task.updated.v1', taskUpdated());
    await waitFor(() => seen.length === 1);
    await application.close();
    await owner.close();

    expect(seen).toEqual(['CAD-482']);
  });

  it('lets a running handler finish before the application closes', async () => {
    const application: TestingModule = await startApplication([
      MessagingModule.forRoot(
        messagingOptions(nats, { ...isolatedNames('shutdown'), service: 'search-service' }),
      ),
    ]);
    const steps: string[] = [];
    await application.get(EventConsumers).subscribe({
      handler: 'index-task',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      handle: async (): Promise<void> => {
        steps.push('started');
        await delay(400);
        steps.push('finished');
      },
    });
    await application.get(EventPublisher).publish(eventSchemas, 'task.updated.v1', taskUpdated());
    await waitFor(() => steps.length === 1);

    await application.close();
    steps.push('closed');
    const consumer: ConsumerInfo = await manager.consumers.info(
      'EVENTS_shutdown',
      'search-service__index-task',
    );

    expect(steps).toEqual(['started', 'finished', 'closed']);
    expect(consumer.num_ack_pending).toBe(0);
  });

  it('opens the context as the system for an actor kind the kit does not know, and warns once', async () => {
    const warn: MockInstance = vi.spyOn(Logger.prototype, 'warn');
    const application: TestingModule = await startApplication([
      MessagingModule.forRoot(
        messagingOptions(nats, { ...isolatedNames('actor'), service: 'search-service' }),
      ),
    ]);
    const seen: (OrganizationContext | undefined)[] = [];
    await application.get(EventConsumers).subscribe({
      handler: 'index-task',
      schemas: nextEventSchemas,
      event: 'task.updated.v1',
      handle: (): Promise<void> => {
        seen.push(getOrganizationContext());
        return Promise.resolve();
      },
    });
    const raw: JetStreamClient = jetstream(client);
    for (const id of [
      '0193a1f0-0000-7000-8000-0000000000d1',
      '0193a1f0-0000-7000-8000-0000000000d2',
    ]) {
      await raw.publish(
        'evt-actor.task.updated.v1',
        JSON.stringify({
          ...taskUpdated(),
          id,
          occurredAt: '2026-11-14T09:30:00.000Z',
          actor: { type: 'service-account', id: 'robot-1' },
        }),
      );
    }
    await waitFor(() => seen.length === 2);
    await application.close();
    const warnings: unknown[] = warn.mock.calls.filter(
      (call: unknown[]) =>
        call[1] === 'unknown actor type: handled as the system; upgrade @cadenway/nest-messaging',
    );
    warn.mockRestore();

    expect(seen).toEqual([
      { organizationId: ATELIER_NORD, actor: { type: 'system', id: null }, role: null, scopes: [] },
      { organizationId: ATELIER_NORD, actor: { type: 'system', id: null }, role: null, scopes: [] },
    ]);
    expect(warnings).toEqual([
      [
        { consumer: 'search-service__index-task', actorType: 'service-account' },
        expect.any(String),
      ],
    ]);
  });

  it('records only the class of a handler error on its span, never its message', async () => {
    const exporter: InMemorySpanExporter = new InMemorySpanExporter();
    trace.setGlobalTracerProvider(
      new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] }),
    );
    const application: TestingModule = await startApplication(
      [
        MessagingModule.forRoot(
          messagingOptions(nats, { ...isolatedNames('span'), service: 'search-service' }),
        ),
      ],
      { tuning: { retryDelaysMs: [60_000] } },
    );
    await application.get(EventConsumers).subscribe({
      handler: 'index-task',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      handle: (): Promise<void> =>
        Promise.reject(new TypeError('cannot index secret-code-482913 for camille@example.test')),
    });

    await application.get(EventPublisher).publish(eventSchemas, 'task.updated.v1', taskUpdated());
    await waitFor(() => exporter.getFinishedSpans().length === 1);
    await application.close();
    const span: ReadableSpan | undefined = exporter.getFinishedSpans()[0];
    trace.disable();

    expect(span?.name).toBe('process task.updated.v1');
    expect(span?.status).toEqual({ code: SpanStatusCode.ERROR, message: 'TypeError' });
    expect(span?.attributes['error.type']).toBe('TypeError');
    expect(span?.events).toEqual([]);
    expect(JSON.stringify([span?.attributes, span?.status, span?.events])).not.toMatch(
      /secret-code|camille/u,
    );
  });

  it('skips existing history on first registration and replays retained events after durable deletion', async () => {
    const application: TestingModule = await startApplication([
      MessagingModule.forRoot(
        messagingOptions(nats, { ...isolatedNames('deleted'), service: 'search-service' }),
      ),
    ]);
    const received: string[] = [];
    const publisher: EventPublisher = application.get(EventPublisher);
    await publisher.publish(
      eventSchemas,
      'task.updated.v1',
      taskUpdated({ taskId: 'CAD-HISTORY' }),
    );
    await application.get(EventConsumers).subscribe({
      handler: 'index-task',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      deliverPolicy: 'new',
      handle: (payload: TaskUpdatedV1): Promise<void> => {
        received.push(payload.taskId);
        return Promise.resolve();
      },
    });
    await publisher.publish(eventSchemas, 'task.updated.v1', taskUpdated({ taskId: 'CAD-BEFORE' }));
    await waitFor(async () => {
      const consumer: ConsumerInfo = await manager.consumers.info(
        'EVENTS_deleted',
        'search-service__index-task',
      );
      return consumer.ack_floor.stream_seq >= 1 && consumer.num_waiting > 0;
    });

    expect(received).toEqual(['CAD-BEFORE']);
    await manager.consumers.delete('EVENTS_deleted', 'search-service__index-task');
    await publisher.publish(eventSchemas, 'task.updated.v1', taskUpdated({ taskId: 'CAD-GAP' }));
    await waitFor(() => received.includes('CAD-GAP'), 15_000);
    const recreated: ConsumerInfo = await manager.consumers.info(
      'EVENTS_deleted',
      'search-service__index-task',
    );
    await expect(
      messagingHealthIndicator(application.get(MessagingConnection)).check(),
    ).resolves.toBeUndefined();
    await application.close();

    expect(recreated.config).toMatchObject({
      deliver_policy: 'all',
      filter_subject: 'evt-deleted.task.updated.v1',
      max_deliver: 5,
    });
    expect(received).toEqual(['CAD-BEFORE', 'CAD-HISTORY', 'CAD-BEFORE', 'CAD-GAP']);
  });

  it('reports a missing consumer to readiness until it exists again, then resumes', async () => {
    const consumerConfig: Partial<ConsumerConfig> = {
      durable_name: 'search-service__index-task',
      name: 'search-service__index-task',
      filter_subject: 'evt-ready.task.updated.v1',
      ack_policy: AckPolicy.Explicit,
      ack_wait: nanos(30_000),
      max_deliver: 5,
    };
    const owner: TestingModule = await startApplication([
      MessagingModule.forRoot(messagingOptions(nats, isolatedNames('ready'))),
    ]);
    await manager.consumers.add('EVENTS_ready', consumerConfig);
    const application: TestingModule = await startApplication([
      MessagingModule.forRoot(
        messagingOptions(nats, {
          ...isolatedNames('ready'),
          service: 'search-service',
          manageStreams: false,
          manageConsumers: false,
        }),
      ),
    ]);
    const readiness: HealthIndicator = messagingHealthIndicator(
      application.get(MessagingConnection),
    );
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
    await expect(readiness.check()).resolves.toBeUndefined();

    await manager.consumers.delete('EVENTS_ready', 'search-service__index-task');
    await waitFor(async () => {
      try {
        await readiness.check();
        return false;
      } catch (error) {
        return (
          error instanceof Error && error.message.includes('search-service__index-task: missing')
        );
      }
    }, 15_000);
    await manager.consumers.add('EVENTS_ready', consumerConfig);
    await waitFor(async () => {
      try {
        await readiness.check();
        return true;
      } catch {
        return false;
      }
    }, 15_000);
    await owner.get(EventPublisher).publish(eventSchemas, 'task.updated.v1', taskUpdated());
    await waitFor(() => received.length === 1);
    await application.close();
    await owner.close();

    expect(received).toEqual(['CAD-482']);
  });
});
