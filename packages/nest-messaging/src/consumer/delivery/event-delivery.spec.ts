import type { JsMsg } from '@nats-io/jetstream';
import { ClosedConnectionError } from '@nats-io/transport-node';
import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { EventValidationError } from '../../events/event-validation-error.js';
import { taskUpdated, type TaskUpdatedV1 } from '../../testing/events.js';
import { deferred } from '../../testing/wait.js';
import type { EventTarget } from '../subscriptions/event-target.js';
import type { EventContext } from './event-context.js';
import type { EventDeduplicator } from './event-deduplicator.js';
import { answerSafely, contextActorOf, EventDelivery } from './event-delivery.js';

describe('contextActorOf', () => {
  it.each(['user', 'automation', 'git', 'system'])(
    'keeps the actor kind %s the kit knows, with its id',
    (type: string) => {
      expect(contextActorOf({ type, id: 'actor-1' })).toEqual({ type, id: 'actor-1' });
    },
  );

  it.each(['service-account', 'anonymous', ''])(
    'refuses the actor kind "%s", which the contracts do not define today',
    (type: string) => {
      expect(contextActorOf({ type, id: 'actor-1' })).toBeUndefined();
    },
  );
});

describe('answerSafely', () => {
  it('sends the answer', () => {
    const sent: string[] = [];

    answerSafely(
      () => {
        sent.push('ack');
      },
      () => {
        sent.push('error');
      },
    );

    expect(sent).toEqual(['ack']);
  });

  it('reports an answer the closed connection could not send instead of throwing', () => {
    const errors: unknown[] = [];

    expect(() => {
      answerSafely(
        () => {
          throw new ClosedConnectionError();
        },
        (error: unknown) => {
          errors.push(error);
        },
      );
    }).not.toThrow();
    expect(errors[0]).toBeInstanceOf(ClosedConnectionError);
  });
});

it('never starts a handler when deduplication reaches it after the delivery deadline', async () => {
  vi.useFakeTimers();
  try {
    let release: () => void = (): void => undefined;
    const claim: Promise<void> = new Promise<void>((resolve: () => void) => {
      release = resolve;
    });
    const run = vi.fn<EventDeduplicator['run']>(async (_delivery, handle) => {
      await claim;
      await handle(() => Promise.resolve(true));
      return 'handled';
    });
    const payload: TaskUpdatedV1 = {
      ...taskUpdated(),
      id: '0193a1f0-0000-7000-8000-000000000001',
      occurredAt: '2026-01-01T00:00:00.000Z',
    };
    const subject: string = 'evt.task.updated.v1';
    const handler = vi.fn((): Promise<void> => Promise.resolve());
    const target: EventTarget = {
      consumer: 'search-service__index-task',
      event: 'task.updated.v1',
      route: { stream: 'EVENTS', subject, restricted: false },
      prepare: () => ({ envelope: payload, handle: handler }),
    };
    const ack = vi.fn<JsMsg['ack']>();
    const nak = vi.fn<JsMsg['nak']>();
    const message: JsMsg = {
      info: { deliveryCount: 1, streamSequence: 10 },
      subject,
      redelivered: false,
      string: (): string => JSON.stringify(payload),
      ack,
      nak,
    } as unknown as JsMsg;
    const delivery: EventDelivery = new EventDelivery(
      new Logger('event delivery spec', { timestamp: false }),
      100,
      [1000],
      { run },
    );

    const attempting: Promise<void> = delivery.deliver(target, message);
    await vi.advanceTimersByTimeAsync(100);
    await attempting;
    expect(nak).toHaveBeenCalledExactlyOnceWith(1000);

    release();
    await expect(run.mock.results[0]?.value).rejects.toThrow(/did not finish within 100 ms/u);
    expect(handler).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

function testDelivery(handle: (context: EventContext) => Promise<void> = () => Promise.resolve()) {
  const envelope: TaskUpdatedV1 = {
    ...taskUpdated(),
    id: '0193a1f0-0000-7000-8000-000000000001',
    occurredAt: '2026-01-01T00:00:00.000Z',
  };
  const subject: string = 'evt.task.updated.v1';
  const target: EventTarget = {
    consumer: 'search-service__index-task',
    event: 'task.updated.v1',
    route: { stream: 'EVENTS', subject, restricted: false },
    prepare: () => ({ envelope, handle }),
  };
  const ack = vi.fn<JsMsg['ack']>();
  const nak = vi.fn<JsMsg['nak']>();
  const term = vi.fn<JsMsg['term']>();
  const message = {
    info: { deliveryCount: 1, streamSequence: 10 },
    subject,
    redelivered: false,
    string: (): string => JSON.stringify(envelope),
    ack,
    nak,
    term,
  } as unknown as JsMsg;
  return { target, message, ack, nak, term, envelope };
}

it.each(['resolves', 'rejects'] as const)(
  'aborts a delivery left running at shutdown and sends no answer if the handler %s later',
  async (outcome) => {
    const abandon: AbortController = new AbortController();
    const handler = deferred<undefined>();
    const handle = vi.fn<(context: EventContext) => Promise<void>>(() => handler.promise);
    const { target, message, ack, nak, term } = testDelivery(handle);
    const delivery: EventDelivery = new EventDelivery(
      new Logger('event delivery spec'),
      1000,
      [100],
      undefined,
      abandon.signal,
    );

    const attempting: Promise<void> = delivery.deliver(target, message);
    const handlerContext: EventContext | undefined = handle.mock.calls[0]?.[0];
    expect(handlerContext?.signal.aborted).toBe(false);
    abandon.abort();
    await attempting;
    expect(handlerContext?.signal.aborted).toBe(true);

    if (outcome === 'resolves') {
      handler.resolve(undefined);
    } else {
      handler.reject(new Error('late failure'));
    }
    await handler.promise.catch(() => undefined);
    expect(ack).not.toHaveBeenCalled();
    expect(nak).not.toHaveBeenCalled();
    expect(term).not.toHaveBeenCalled();
  },
);

it('terminates an invalid payload without invoking the handler', async () => {
  const handle = vi.fn(() => Promise.resolve());
  const { target, message, ack, nak, term } = testDelivery(handle);
  const invalid: EventTarget = {
    ...target,
    prepare: () => {
      throw new EventValidationError(target.event, [{ path: 'version', code: 'invalid_type' }]);
    },
  };
  const logger = new Logger('event delivery spec');
  const log = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  await new EventDelivery(logger, 100, [1000]).deliver(invalid, message);

  expect(term).toHaveBeenCalledExactlyOnceWith('invalid-payload');
  expect(log).toHaveBeenCalledWith(
    expect.objectContaining({ issues: [{ path: 'version', code: 'invalid_type' }] }),
    'event does not match its contract: terminated',
  );
  expect(handle).not.toHaveBeenCalled();
  expect(ack).not.toHaveBeenCalled();
  expect(nak).not.toHaveBeenCalled();
});

it('logs a fixed error category and retries without forwarding exception data', async () => {
  const failure: TypeError = new TypeError('synthetic exception data', {
    cause: new Error('synthetic cause'),
  });
  failure.name = 'synthetic exception name';
  const { target, message, nak, envelope } = testDelivery(() => Promise.reject(failure));
  const logger = new Logger('event delivery spec');
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  await new EventDelivery(logger, 100, [1000]).deliver(target, message);

  expect(nak).toHaveBeenCalledExactlyOnceWith(1000);
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    {
      consumer: target.consumer,
      event: target.event,
      eventId: envelope.id,
      streamSequence: 10,
      deliveryCount: 1,
      retryInMs: 1000,
      errorClass: 'TypeError',
    },
    'event handler failed: will retry',
  );
});
