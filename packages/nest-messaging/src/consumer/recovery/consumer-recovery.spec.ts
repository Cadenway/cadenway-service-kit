import type { Consumer, ConsumerMessages, JsMsg } from '@nats-io/jetstream';
import { Logger } from '@nestjs/common';
import { expect, it, vi } from 'vitest';

import type { MessagingConnection } from '../../connection/messaging-connection.js';
import { EventDelivery } from '../delivery/event-delivery.js';
import type { RunningConsumer } from '../subscriptions/running-consumer.js';
import { ConsumerRecovery } from './consumer-recovery.js';

it('leaves a buffered message unsettled when admission closes during the active delivery', async () => {
  const shutdown: AbortController = new AbortController();
  const logger: Logger = new Logger('consumer recovery spec');
  const delivery: EventDelivery = new EventDelivery(logger, 1000);
  const deliver = vi.spyOn(delivery, 'deliver').mockImplementation(() => {
    shutdown.abort();
    return Promise.resolve();
  });
  const active = {} as JsMsg;
  const buffered = {} as JsMsg;
  const items = Object.assign([active, buffered], {
    status: () => [],
  }) as unknown as ConsumerMessages;
  const consumer = {
    consume: () => Promise.resolve(items),
  } as unknown as Consumer;
  const connection = { reportConsumer: vi.fn() } as unknown as MessagingConnection;
  const running: RunningConsumer = {
    target: {
      consumer: 'search-service__index-task',
      event: 'task.updated.v1',
      route: { stream: 'EVENTS', subject: 'evt.task.updated.v1', restricted: false },
      redelivery: { delaysMs: [100], maxDeliveries: 2, custom: false },
      prepare: () => {
        throw new Error('This test isolates message admission.');
      },
    },
    messages: undefined,
    done: Promise.resolve(),
  };

  await new ConsumerRecovery(
    connection,
    logger,
    shutdown.signal,
    [],
    () => Promise.resolve(consumer),
    delivery,
  ).run(running, consumer);
  expect(deliver).toHaveBeenCalledExactlyOnceWith(running.target, active);
});
