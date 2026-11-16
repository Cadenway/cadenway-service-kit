import type { StoredMsg } from '@nats-io/jetstream';
import { headers } from '@nats-io/transport-node';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MESSAGING_TUNING } from '../configuration/messaging-tuning.js';
import { resolveMessagingOptions } from '../configuration/resolve-messaging-options.js';
import type { MessagingConnection } from '../connection/messaging-connection.js';
import { maxDeliveriesAdvisorySubject } from '../transport/subjects.js';
import { boundedReason, DeadLetterWorker } from './dead-letter-worker.js';

type OriginalMessage = Pick<StoredMsg, 'data' | 'header' | 'subject'>;

const ADVISORY_SUBJECT: string = maxDeliveriesAdvisorySubject('EVENTS');
const SHUTDOWN_TIMEOUT_MS: number = 100;

function createWorker(getMessage: () => Promise<OriginalMessage>) {
  const unsubscribe = vi.fn();
  const drain = vi.fn((): Promise<void> => new Promise<void>(() => undefined));
  const publish = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const connection = {
    nats: {
      subscribe: (subject: string) => ({
        drain,
        unsubscribe,
        *[Symbol.iterator]() {
          if (subject === ADVISORY_SUBJECT) {
            for (const seq of [1, 2]) {
              yield {
                subject,
                string: (): string =>
                  JSON.stringify({ stream: 'EVENTS', consumer: 'example', stream_seq: seq }),
              };
            }
          }
        },
      }),
    },
    jetstream: { publish },
    flush: (): Promise<void> => Promise.resolve(),
    manager: () => Promise.resolve({ streams: { getMessage } }),
  };
  const worker: DeadLetterWorker = new DeadLetterWorker(
    connection as unknown as MessagingConnection,
    resolveMessagingOptions({
      service: 'test-service',
      servers: 'nats://localhost:4222',
      deadLetterWorker: true,
      shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
    }),
    DEFAULT_MESSAGING_TUNING,
  );
  return { worker, unsubscribe, drain, publish };
}

function holdCopy() {
  let release: () => void = () => undefined;
  const result = new Promise<OriginalMessage>((resolve) => {
    release = (): void => {
      resolve({ subject: 'evt.example.v1', data: new Uint8Array(), header: headers() });
    };
  });
  return { read: vi.fn((): Promise<OriginalMessage> => result), release };
}

describe('boundedReason', () => {
  it('keeps the termination reasons the kit sends and no reason at all', () => {
    expect(boundedReason('invalid-payload')).toBe('invalid-payload');
    expect(boundedReason('invalid-json')).toBe('invalid-json');
    expect(boundedReason(undefined)).toBeUndefined();
  });

  it('cuts any other reason to 64 printable characters', () => {
    const reason: string | undefined = boundedReason(`code 123456\n${'x'.repeat(200)}\u0007`);

    expect(reason).toHaveLength(64);
    expect(reason).toMatch(/^[\x20-\x7e]+$/u);
    expect(reason?.startsWith('code 123456?')).toBe(true);
  });
});

describe('dead-letter worker shutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('unsubscribes without flushing and lets the active copy finish before its deadline', async () => {
    const { read, release } = holdCopy();
    const { worker, unsubscribe, drain, publish } = createWorker(read);
    await worker.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);

    const stopped: Promise<void> = worker.beforeApplicationShutdown();
    expect(unsubscribe).toHaveBeenCalledTimes(4);
    expect(drain).not.toHaveBeenCalled();
    release();
    await stopped;

    expect(publish).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a stalled copy and never publishes when its read finishes after shutdown', async () => {
    const { read, release } = holdCopy();
    const { worker, publish } = createWorker(read);
    await worker.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);

    const stopped: Promise<void> = worker.beforeApplicationShutdown();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS);
    await stopped;
    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(publish).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the pending retry without starting another copy', async () => {
    const read = vi.fn<() => Promise<OriginalMessage>>().mockRejectedValue(new Error('offline'));
    const { worker, publish } = createWorker(read);
    await worker.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await worker.beforeApplicationShutdown();
    await vi.runAllTimersAsync();

    expect(publish).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
