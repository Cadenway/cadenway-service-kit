import type {
  DatabaseSchema,
  SystemTransactionRunner,
  TransactionClient,
  TransactionScope,
} from '@cadenway/nest-common/database';
import { JetStreamApiError } from '@nats-io/jetstream';
import { PermissionViolationError, TimeoutError } from '@nats-io/transport-node';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EventStreamUnavailableError,
  type EventPublisher,
  type OutgoingEvent,
} from '../../publisher/event-publisher.js';
import { resolveOutboxOptions } from '../wiring/outbox-options.js';
import type { PendingRow } from './outbox-relay-store.js';
import { OutboxRelay } from './outbox-relay.js';
import { rowBackoffMs, stopsPass } from './outbox-retry-policy.js';

function pendingRow(id: string): PendingRow {
  return {
    id,
    event_name: 'task.updated.v1',
    subject: 'evt.task.updated.v1',
    stream: 'EVENTS',
    payload: {
      id,
      occurredAt: '2026-04-20T00:00:00Z',
      organizationId: null,
      actor: { type: 'system', id: 'local-test' },
      version: 1,
    },
    traceparent: null,
    attempts: 0,
  };
}

function systemWith(query: TransactionClient['query']): SystemTransactionRunner<DatabaseSchema> {
  return {
    run: <TResult>(work: (tx: TransactionScope<DatabaseSchema>) => Promise<TResult>) =>
      work({ client: { query } } as TransactionScope<DatabaseSchema>),
  } as SystemTransactionRunner<DatabaseSchema>;
}

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

  it('waits for the current acknowledgement, then settles only the rows processed before expiry', async () => {
    let elapsedMs: number = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsedMs);
    const publishEnvelope = vi
      .fn<(event: OutgoingEvent) => Promise<void>>()
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, 10)));
    const query = vi
      .fn<TransactionClient['query']>()
      .mockResolvedValueOnce({ rows: [pendingRow('first'), pendingRow('second')] })
      .mockResolvedValue({ rows: [] });
    const relay: OutboxRelay = new OutboxRelay(
      systemWith(query),
      { publishEnvelope } as unknown as EventPublisher,
      resolveOutboxOptions({ batchSize: 3 }),
    );

    const pass: Promise<unknown> = relay.publishPending();
    await vi.advanceTimersByTimeAsync(0);
    expect(query).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('for update skip locked'),
      [3],
    );
    expect(publishEnvelope).toHaveBeenCalledTimes(1);

    elapsedMs = 5000;
    await vi.advanceTimersByTimeAsync(10);
    await expect(pass).resolves.toEqual({ published: 1, failed: 0, interrupted: false });
    expect(publishEnvelope).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("status = 'sent'"), [
      ['first'],
      [],
    ]);
  });

  it('immediately resumes a partial batch deferred by the budget, then returns to its poll interval', async () => {
    let elapsedMs: number = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsedMs);
    const publishEnvelope = vi.fn<(event: OutgoingEvent) => Promise<void>>(() => {
      elapsedMs += 5001;
      return Promise.resolve();
    });
    const selected = vi
      .fn<() => PendingRow[]>()
      .mockReturnValueOnce([pendingRow('first'), pendingRow('second')])
      .mockReturnValueOnce([pendingRow('second')])
      .mockReturnValue([]);
    const query: TransactionClient['query'] = (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.startsWith('select id, event_name')) {
        return Promise.resolve({ rows: selected() });
      }
      if (sql.includes('pg_try_advisory_xact_lock')) {
        return Promise.resolve({ rows: [{ acquired: true }] });
      }
      return Promise.resolve({ rows: [{ count: 0 }] });
    };
    const relay: OutboxRelay = new OutboxRelay(
      systemWith(query),
      { publishEnvelope } as unknown as EventPublisher,
      resolveOutboxOptions({ batchSize: 3, pollIntervalMs: 1000, purgeIntervalMs: 0 }),
    );

    try {
      relay.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(5);
      expect(publishEnvelope.mock.calls.map(([event]) => event.payload.id)).toEqual([
        'first',
        'second',
      ]);
      expect(selected).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1000);
      expect(selected).toHaveBeenCalledTimes(3);
      expect(publishEnvelope).toHaveBeenCalledTimes(2);
    } finally {
      await relay.beforeApplicationShutdown();
    }
  });

  it('backs off while the database cannot be reached, then polls normally again', async () => {
    let databaseUp: boolean = false;
    const publish = vi.fn();
    const query: TransactionClient['query'] = (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.startsWith('select id, event_name')) {
        publish();
      }
      if (!databaseUp) {
        return Promise.reject(new Error('connect ECONNREFUSED'));
      }
      return Promise.resolve({
        rows: sql.startsWith('select id, event_name') ? [] : [{ acquired: true, count: 0 }],
      });
    };
    const relay: OutboxRelay = new OutboxRelay(
      systemWith(query),
      {} as EventPublisher,
      resolveOutboxOptions({ pollIntervalMs: 1000, purgeIntervalMs: 0 }),
    );

    relay.onApplicationBootstrap();
    const calls: number[] = [];
    for (let second: number = 0; second <= 40; second += 1) {
      await vi.advanceTimersByTimeAsync(1000);
      calls.push(publish.mock.calls.length);
    }
    const whileDown: number = publish.mock.calls.length;
    databaseUp = true;
    await vi.advanceTimersByTimeAsync(19_500);
    const recovered: number = publish.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    await relay.beforeApplicationShutdown();

    // Passes at 0 s, 2 s, 6 s, 14 s and 30 s (pauses of 2, 4, 8, 16 then 30 s), the next at 60 s.
    expect(calls.slice(0, 7)).toEqual([1, 2, 2, 2, 2, 3, 3]);
    expect(whileDown).toBe(5);
    expect(recovered).toBe(whileDown + 1);
    // Once a pass succeeds, the relay polls every second again.
    expect(publish.mock.calls.length - recovered).toBeGreaterThanOrEqual(4);
  });

  it('retries the initial sweep after failure while publication still responds to a wake', async () => {
    const warn: ReturnType<typeof vi.spyOn> = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const publish = vi.fn();
    const sweep = vi
      .fn<() => Promise<{ rows: unknown[] }>>()
      .mockRejectedValueOnce(new Error('first maintenance transaction failed'))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve({ rows: [{ count: 1 }] });
            }, 500);
          }),
      );
    const query: TransactionClient['query'] = (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.startsWith('select id, event_name')) {
        publish();
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('pg_try_advisory_xact_lock')) {
        return Promise.resolve({ rows: [{ acquired: true }] });
      }
      return sweep();
    };
    const relay: OutboxRelay = new OutboxRelay(
      systemWith(query),
      {} as EventPublisher,
      resolveOutboxOptions({ pollIntervalMs: 1000, purgeIntervalMs: 0 }),
    );

    try {
      relay.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(0);
      expect(sweep).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(sweep).toHaveBeenCalledTimes(2);
      expect(publish).toHaveBeenCalledTimes(2);
      relay.wake();
      await vi.advanceTimersByTimeAsync(1);
      expect(publish).toHaveBeenCalledTimes(3);
      expect(warn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);
      expect(warn).toHaveBeenCalledWith(
        { redacted: 1 },
        'restricted outbox rows sent without redaction were redacted',
      );

      await vi.advanceTimersByTimeAsync(1000);
      expect(sweep).toHaveBeenCalledTimes(2);
    } finally {
      await relay.beforeApplicationShutdown();
    }
  });
});
