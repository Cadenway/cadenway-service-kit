import { expect, it, vi } from 'vitest';

import type { MessagingConnection } from '../../connection/messaging-connection.js';
import { resolveMessagingOptions } from '../../configuration/resolve-messaging-options.js';
import { RebuildFlushTimeoutError } from '../../index.js';
import { RebuildEmitter } from './rebuild-emitter.js';

it('times out a rebuild flush when the broker leaves it pending', async () => {
  vi.useFakeTimers();
  try {
    const connection: Pick<MessagingConnection, 'flush'> = {
      flush: (): Promise<void> => new Promise<void>(() => undefined),
    };
    const emitter: RebuildEmitter = new RebuildEmitter(
      connection as MessagingConnection,
      resolveMessagingOptions({
        service: 'test-service',
        servers: 'nats://localhost:4222',
        rebuildTimeoutMs: 500,
      }),
    );

    const result = expect(emitter.flush()).rejects.toThrow(RebuildFlushTimeoutError);
    await vi.advanceTimersByTimeAsync(500);
    await result;
  } finally {
    vi.useRealTimers();
  }
});
