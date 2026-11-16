import { getOrganizationContext, runWithOrganizationContext } from '@cadenway/nest-common';
import type { TestingModule } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { EventConsumers } from '../../consumer/event-consumers.js';
import { MessagingModule } from '../../wiring/messaging.module.js';
import { messagingOptions, startApplication } from '../../testing/application.js';
import { ATELIER_NORD, CAMILLE } from '../../testing/events.js';
import { startTestNats, type TestNats } from '../../testing/nats.js';
import { delay, waitFor } from '../../testing/wait.js';
import {
  RebuildConsumerUnavailableError,
  RebuildEmitter,
  RebuildItemError,
  RebuildRejectedError,
} from './rebuild-emitter.js';

/**
 * Interface TaskItem
 *
 * @description
 * Current state of a task, as its owner re-emits it for the search index.
 */
interface TaskItem {
  // #region Properties
  /**
   * Property taskId
   *
   * @description
   * Id of the task.
   *
   * @type {string}
   * @readonly
   */
  readonly taskId: string;

  /**
   * Property title
   *
   * @description
   * Title of the task.
   *
   * @type {string}
   * @readonly
   */
  readonly title: string;
  // #endregion
}

/**
 * Constant taskItemSchema
 *
 * @description
 * Schema both sides validate a task item with.
 *
 * @type {z.ZodType<TaskItem>}
 */
const taskItemSchema: z.ZodType<TaskItem> = z.object({
  taskId: z.string().min(1),
  title: z.string().min(1).max(40),
});

/**
 * Constant looseTaskItemSchema
 *
 * @description
 * Schema of an emitter that drifted from its consumer: it accepts any title.
 *
 * @type {z.ZodType<TaskItem>}
 */
const looseTaskItemSchema: z.ZodType<TaskItem> = z.object({
  taskId: z.string(),
  title: z.string(),
});

describe('rebuild on a real NATS server', () => {
  let nats: TestNats;
  let owner: TestingModule;
  let plainOwner: TestingModule;
  let consumer: TestingModule;
  let emitter: RebuildEmitter;
  let plainEmitter: RebuildEmitter;

  beforeAll(async () => {
    nats = await startTestNats();
  });

  beforeEach(async () => {
    owner = await startApplication([
      MessagingModule.forRoot(
        messagingOptions(nats, {
          service: 'task-service',
          rebuildAcknowledgement: 'reply',
          rebuildTimeoutMs: 1000,
        }),
      ),
    ]);
    plainOwner = await startApplication([
      MessagingModule.forRoot(
        messagingOptions(nats, { service: 'document-service', rebuildFlushEvery: 2 }),
      ),
    ]);
    consumer = await startApplication([
      MessagingModule.forRoot(
        messagingOptions(nats, { service: 'search-service', rebuildName: 'search' }),
      ),
    ]);
    emitter = owner.get(RebuildEmitter);
    plainEmitter = plainOwner.get(RebuildEmitter);
  });

  afterEach(async () => {
    await owner.close();
    await plainOwner.close();
    await consumer.close();
  });

  afterAll(async () => {
    await nats.stop();
  });

  it('publishes items without waiting for the consumer by default, and the consumer applies them', async () => {
    const applied: string[] = [];
    await consumer.get(EventConsumers).onRebuild({
      entity: 'task',
      schema: taskItemSchema,
      handle: async (item: TaskItem): Promise<void> => {
        await delay(50);
        applied.push(item.taskId);
      },
    });

    const started: number = Date.now();
    for (const taskId of ['CAD-1', 'CAD-2', 'CAD-3', 'CAD-4', 'CAD-5']) {
      await plainEmitter.emit(
        { consumer: 'search', entity: 'task', schema: taskItemSchema },
        { taskId, title: 'A' },
      );
    }
    await plainEmitter.flush();
    const elapsed: number = Date.now() - started;
    await waitFor(() => applied.length === 5);

    expect(elapsed).toBeLessThan(200);
    expect(applied).toEqual(['CAD-1', 'CAD-2', 'CAD-3', 'CAD-4', 'CAD-5']);
  });

  it('loses an item nobody listens to or the consumer refuses, without failing the emitter', async () => {
    const applied: string[] = [];
    await consumer.get(EventConsumers).onRebuild({
      entity: 'task',
      schema: taskItemSchema,
      handle: (item: TaskItem): Promise<void> => {
        applied.push(item.taskId);
        return Promise.resolve();
      },
    });

    await expect(
      plainEmitter.emit(
        { consumer: 'search', entity: 'document', schema: taskItemSchema },
        { taskId: 'DOC-1', title: 'A' },
      ),
    ).resolves.toBeUndefined();
    await expect(
      plainEmitter.emit(
        { consumer: 'search', entity: 'task', schema: looseTaskItemSchema },
        {
          taskId: 'CAD-1',
          title: 'x'.repeat(41),
        },
      ),
    ).resolves.toBeUndefined();
    await expect(
      plainEmitter.emit(
        { consumer: 'search', entity: 'task', schema: taskItemSchema },
        { taskId: '', title: 'A' },
      ),
    ).rejects.toThrow(RebuildItemError);
    await plainEmitter.emit(
      { consumer: 'search', entity: 'task', schema: taskItemSchema },
      { taskId: 'CAD-2', title: 'B' },
    );
    await plainEmitter.flush();
    await waitFor(() => applied.length === 1);
    await delay(200);

    expect(applied).toEqual(['CAD-2']);
  });

  it('hands each item to the consumer and resolves once it was applied, one item at a time', async () => {
    const applied: string[] = [];
    let running: number = 0;
    let overlapped: boolean = false;
    await consumer.get(EventConsumers).onRebuild({
      entity: 'task',
      schema: taskItemSchema,
      handle: async (item: TaskItem): Promise<void> => {
        running += 1;
        overlapped ||= running > 1;
        await delay(120);
        applied.push(`${item.taskId}:${String(getOrganizationContext()?.organizationId)}`);
        running -= 1;
      },
    });

    const started: number = Date.now();
    await emitter.emit(
      { consumer: 'search', entity: 'task', schema: taskItemSchema },
      { taskId: 'CAD-1', title: 'A' },
    );
    const afterFirst: string[] = [...applied];
    await Promise.all([
      emitter.emit(
        { consumer: 'search', entity: 'task', schema: taskItemSchema },
        { taskId: 'CAD-2', title: 'B' },
      ),
      emitter.emit(
        { consumer: 'search', entity: 'task', schema: taskItemSchema },
        { taskId: 'CAD-3', title: 'C' },
      ),
    ]);

    expect(afterFirst).toEqual(['CAD-1:null']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    expect(applied).toHaveLength(3);
    expect(overlapped).toBe(false);
  });

  it('sends nothing when the item does not match the schema of the emitter', async () => {
    const applied: TaskItem[] = [];
    await consumer.get(EventConsumers).onRebuild({
      entity: 'task',
      schema: taskItemSchema,
      handle: (item: TaskItem): Promise<void> => {
        applied.push(item);
        return Promise.resolve();
      },
    });

    await expect(
      emitter.emit(
        { consumer: 'search', entity: 'task', schema: taskItemSchema },
        { taskId: '', title: 'A' },
      ),
    ).rejects.toThrow(RebuildItemError);
    await expect(
      emitter.emit(
        { consumer: 'search', entity: 'task', schema: taskItemSchema },
        { taskId: '', title: 'A' },
      ),
    ).rejects.toThrow(/taskId/u);
    expect(applied).toEqual([]);
  });

  it('tells the emitter when the consumer refuses an item or its handler fails', async () => {
    await consumer.get(EventConsumers).onRebuild({
      entity: 'task',
      schema: taskItemSchema,
      handle: (item: TaskItem): Promise<void> =>
        item.taskId === 'CAD-500'
          ? Promise.reject(new Error('index unavailable'))
          : Promise.resolve(),
    });

    await expect(
      emitter.emit(
        { consumer: 'search', entity: 'task', schema: looseTaskItemSchema },
        {
          taskId: 'CAD-1',
          title: 'x'.repeat(41),
        },
      ),
    ).rejects.toMatchObject({ name: 'RebuildRejectedError', reason: 'invalid-item' });
    await expect(
      emitter.emit(
        { consumer: 'search', entity: 'task', schema: taskItemSchema },
        { taskId: 'CAD-500', title: 'A' },
      ),
    ).rejects.toMatchObject({ name: 'RebuildRejectedError', reason: 'handler-failed' });
    await expect(
      emitter.emit(
        { consumer: 'search', entity: 'task', schema: taskItemSchema },
        { taskId: 'CAD-500', title: 'A' },
      ),
    ).rejects.toThrow(RebuildRejectedError);
    await expect(
      emitter.emit(
        { consumer: 'search', entity: 'task', schema: taskItemSchema },
        { taskId: 'CAD-2', title: 'B' },
      ),
    ).resolves.toBeUndefined();
  });

  it('fails at once when no consumer listens, and after the timeout when it does not answer', async () => {
    await consumer.get(EventConsumers).onRebuild({
      entity: 'task',
      schema: taskItemSchema,
      handle: async (): Promise<void> => {
        await delay(1500);
      },
    });

    await expect(
      emitter.emit(
        { consumer: 'search', entity: 'document', schema: taskItemSchema },
        { taskId: 'CAD-1', title: 'A' },
      ),
    ).rejects.toThrow(RebuildConsumerUnavailableError);
    await expect(
      emitter.emit(
        { consumer: 'search', entity: 'task', schema: taskItemSchema },
        { taskId: 'CAD-1', title: 'A' },
      ),
    ).rejects.toThrow(/timeout/iu);
  });

  it('refuses to register the same entity twice', async () => {
    const consumers: EventConsumers = consumer.get(EventConsumers);
    await consumers.onRebuild({
      entity: 'task',
      schema: taskItemSchema,
      handle: (): Promise<void> => Promise.resolve(),
    });

    await expect(
      consumers.onRebuild({
        entity: 'task',
        schema: taskItemSchema,
        handle: (): Promise<void> => Promise.resolve(),
      }),
    ).rejects.toThrow(/already registered/u);
  });

  it('applies items outside any organization, whatever the context the handler was registered in', async () => {
    const seen: (string | null | undefined)[] = [];
    await runWithOrganizationContext(
      {
        organizationId: ATELIER_NORD,
        actor: { type: 'user', id: CAMILLE },
        role: 'owner',
        scopes: ['tasks:write'],
      },
      () =>
        consumer.get(EventConsumers).onRebuild({
          entity: 'task',
          schema: taskItemSchema,
          handle: (): Promise<void> => {
            seen.push(getOrganizationContext()?.organizationId);
            return Promise.resolve();
          },
        }),
    );

    await emitter.emit(
      { consumer: 'search', entity: 'task', schema: taskItemSchema },
      { taskId: 'CAD-1', title: 'A' },
    );

    expect(seen).toEqual([null]);
  });

  it('drops the oldest items while more than the pending limit wait at the consumer', async () => {
    const bounded: TestingModule = await startApplication([
      MessagingModule.forRoot(
        messagingOptions(nats, {
          service: 'index-service',
          rebuildName: 'bounded',
          rebuildMaxPending: 3,
        }),
      ),
    ]);
    const applied: string[] = [];
    await bounded.get(EventConsumers).onRebuild({
      entity: 'task',
      schema: taskItemSchema,
      handle: async (item: TaskItem): Promise<void> => {
        await delay(100);
        applied.push(item.taskId);
      },
    });

    // An emitter that flushes once: the 30 items reach the consumer in one burst.
    const burst: TestingModule = await startApplication([
      MessagingModule.forRoot(messagingOptions(nats, { service: 'burst-service' })),
    ]);
    const burstEmitter: RebuildEmitter = burst.get(RebuildEmitter);
    for (let index: number = 0; index < 30; index += 1) {
      await burstEmitter.emit(
        { consumer: 'bounded', entity: 'task', schema: taskItemSchema },
        { taskId: `CAD-${String(index)}`, title: 'A' },
      );
    }
    await burstEmitter.flush();
    await waitFor(() => applied.includes('CAD-29'), 5000);
    await delay(300);
    await burst.close();
    await bounded.close();

    // The item being applied when the burst arrived, then the newest three: the rest is dropped.
    expect(applied.length).toBeLessThanOrEqual(5);
    expect(applied.slice(-3)).toEqual(['CAD-27', 'CAD-28', 'CAD-29']);
  });

  it('refuses queued requests immediately on overflow and waits only for the active handler at shutdown', async () => {
    const bounded: TestingModule = await startApplication([
      MessagingModule.forRoot(
        messagingOptions(nats, {
          service: 'index-service',
          rebuildName: 'bounded-replies',
          rebuildMaxPending: 1,
        }),
      ),
    ]);
    let release: () => void = (): void => undefined;
    const gate: Promise<void> = new Promise<void>((resolve: () => void) => {
      release = resolve;
    });
    const handled: string[] = [];
    await bounded.get(EventConsumers).onRebuild({
      entity: 'task',
      schema: taskItemSchema,
      handle: async (item: TaskItem): Promise<void> => {
        handled.push(item.taskId);
        await gate;
      },
    });
    const target = { consumer: 'bounded-replies', entity: 'task', schema: taskItemSchema };
    const active: Promise<void> = emitter.emit(target, { taskId: 'CAD-ACTIVE', title: 'A' });
    const activeResult: Promise<PromiseSettledResult<void>[]> = Promise.allSettled([active]);
    let shutdown: Promise<void> | undefined;
    try {
      await waitFor(() => handled.length === 1, 800);
      const evicted: Promise<void> = emitter.emit(target, { taskId: 'CAD-EVICT', title: 'B' });
      const waiting: Promise<void> = emitter.emit(target, { taskId: 'CAD-WAIT', title: 'C' });
      // Attach both expectations before shutdown can settle either request.
      const overflow = expect(evicted).rejects.toMatchObject({ reason: 'overloaded' });
      const interrupted = expect(waiting).rejects.toMatchObject({ reason: 'handler-failed' });
      await overflow;
      shutdown = bounded.close();
      await interrupted;
      expect(handled).toEqual(['CAD-ACTIVE']);
    } finally {
      release();
      await (shutdown ?? bounded.close());
      expect(await activeResult).toEqual([{ status: 'fulfilled', value: undefined }]);
    }
  });
});
