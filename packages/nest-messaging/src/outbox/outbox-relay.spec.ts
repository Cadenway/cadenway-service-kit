import type { DatabaseSchema, SystemTransactionRunner } from '@cadenway/nest-common/database';
import { JetStreamApiError } from '@nats-io/jetstream';
import { PermissionViolationError, TimeoutError } from '@nats-io/transport-node';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventStreamUnavailableError, type EventPublisher } from '../publisher/event-publisher.js';
import { resolveOutboxOptions } from './outbox-options.js';
import { OutboxRelay, rowBackoffMs, stopsPass } from './outbox-relay.js';

describe('stopsPass', () => {
  it('stops the pass on failures that concern every row', () => {
    expect(stopsPass(new EventStreamUnavailableError('evt.task.updated.v1', 'EVENTS', null))).toBe(
      true,
    );
    expect(stopsPass(new TimeoutError())).toBe(true);
    expect(
      stopsPass(new PermissionViolationError('denied', 'publish', 'evt.task.updated.v1')),
    ).toBe(true);
    expect(
      stopsPass(
        new Error('request failed', {
          cause: new PermissionViolationError('denied', 'subscription', '_INBOX.>'),
        }),
      ),
    ).toBe(true);
    for (const code of [10002, 10023, 10028, 10047, 10077]) {
      expect(
        stopsPass(new JetStreamApiError({ code: 503, err_code: code, description: 'limit' })),
      ).toBe(true);
    }
  });

  it('lets the pass go on after a failure of one row', () => {
    expect(
      stopsPass(
        new JetStreamApiError({ code: 400, err_code: 10054, description: 'message too large' }),
      ),
    ).toBe(false);
    expect(stopsPass(new Error('unexpected'))).toBe(false);
  });
});

describe('rowBackoffMs', () => {
  it('waits 1 s after the first failure and doubles, up to five minutes', () => {
    expect([1, 2, 3, 4, 10, 20].map(rowBackoffMs)).toEqual([
      1000, 2000, 4000, 8000, 300_000, 300_000,
    ]);
  });
});

describe('OutboxRelay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('backs off while the database cannot be reached, then polls normally again', async () => {
    let databaseUp: boolean = false;
    const run: ReturnType<typeof vi.fn> = vi.fn(() =>
      databaseUp
        ? Promise.resolve({ published: 0, failed: 0, interrupted: false })
        : Promise.reject(new Error('connect ECONNREFUSED')),
    );
    const relay: OutboxRelay = new OutboxRelay(
      { run } as unknown as SystemTransactionRunner<DatabaseSchema>,
      {} as EventPublisher,
      resolveOutboxOptions({ pollIntervalMs: 1000, purgeIntervalMs: 0 }),
    );

    relay.onApplicationBootstrap();
    const calls: number[] = [];
    for (let second: number = 0; second <= 40; second += 1) {
      await vi.advanceTimersByTimeAsync(1000);
      calls.push(run.mock.calls.length);
    }
    const whileDown: number = run.mock.calls.length;
    databaseUp = true;
    await vi.advanceTimersByTimeAsync(19_500);
    const recovered: number = run.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    await relay.beforeApplicationShutdown();

    // Passes at 0 s, 2 s, 6 s, 14 s and 30 s (pauses of 2, 4, 8, 16 then 30 s), the next at 60 s.
    expect(calls.slice(0, 7)).toEqual([1, 2, 2, 2, 2, 3, 3]);
    expect(whileDown).toBe(5);
    expect(recovered).toBe(whileDown + 1);
    // Once a pass succeeds, the relay polls every second again.
    expect(run.mock.calls.length - recovered).toBeGreaterThanOrEqual(4);
  });
});
