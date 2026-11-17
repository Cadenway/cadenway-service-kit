import type { StoredMsg } from '@nats-io/jetstream';
import { headers, type Msg, type SubscriptionOptions } from '@nats-io/transport-node';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MESSAGING_TUNING } from '../configuration/messaging-tuning.js';
import { resolveMessagingOptions } from '../configuration/resolve-messaging-options.js';
import type { MessagingConnection } from '../connection/messaging-connection.js';
import { deferred } from '../testing/wait.js';
import { maxDeliveriesAdvisorySubject, terminatedAdvisorySubject } from '../transport/subjects.js';
import { DeadLetterWorker, loggedTerminationReason } from './dead-letter-worker.js';

type OriginalMessage = Pick<StoredMsg, 'data' | 'header' | 'subject'>;
type ReadOriginal = (stream: string, request: { seq: number }) => Promise<OriginalMessage>;

const ADVISORY_SUBJECT: string = maxDeliveriesAdvisorySubject('EVENTS');
const SHUTDOWN_TIMEOUT_MS: number = 100;
const original: OriginalMessage = {
  subject: 'evt.example.v1',
  data: new Uint8Array(),
  header: headers(),
};

function advisory(sequence: number, reason?: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ stream: 'EVENTS', consumer: 'example', stream_seq: sequence, reason }),
  );
}

function createWorker(getMessage: ReadOriginal) {
  const unsubscribe = vi.fn();
  const drain = vi.fn((): Promise<void> => new Promise<void>(() => undefined));
  const publish = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const subscriptions = new Map<string, SubscriptionOptions>();
  const connection = {
    nats: {
      subscribe: (subject: string, options: SubscriptionOptions) => {
        subscriptions.set(subject, options);
        return { drain, unsubscribe };
      },
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
  const emit = (data: Uint8Array, subject: string = ADVISORY_SUBJECT): void => {
    void subscriptions.get(subject)?.callback?.(null, { data, subject } as Msg);
  };
  return { worker, unsubscribe, drain, publish, emit };
}

function holdCopy() {
  const copy = deferred<OriginalMessage>();
  return {
    read: vi.fn<ReadOriginal>().mockReturnValue(copy.promise),
    release: (): void => {
      copy.resolve(original);
    },
  };
}

describe('loggedTerminationReason', () => {
  it('keeps the termination reasons the kit sends and no reason at all', () => {
    expect(loggedTerminationReason('invalid-payload')).toBe('invalid-payload');
    expect(loggedTerminationReason('invalid-json')).toBe('invalid-json');
    expect(loggedTerminationReason(undefined)).toBeUndefined();
  });

  it('classifies an external reason without logging its text', () => {
    expect(loggedTerminationReason('synthetic external text')).toBe('external-termination');
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
    const { worker, unsubscribe, drain, publish, emit } = createWorker(read);
    await worker.onApplicationBootstrap();
    emit(advisory(1));
    await vi.advanceTimersByTimeAsync(0);
    for (let seq: number = 2; seq <= 1001; seq += 1) {
      emit(advisory(seq));
    }
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
    const { worker, publish, emit } = createWorker(read);
    await worker.onApplicationBootstrap();
    emit(advisory(1));
    emit(advisory(2));
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
    const failure = new RangeError('synthetic exception data', {
      cause: new Error('synthetic cause'),
    });
    failure.name = 'synthetic exception name';
    const read = vi.fn<ReadOriginal>().mockRejectedValue(failure);
    const { worker, publish, emit } = createWorker(read);
    const log = vi.spyOn(Logger.prototype, 'error');
    await worker.onApplicationBootstrap();
    emit(advisory(1));
    emit(advisory(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await worker.beforeApplicationShutdown();
    await vi.runAllTimersAsync();

    expect(publish).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      {
        stream: 'EVENTS',
        consumer: 'example',
        streamSequence: 1,
        reason: 'max-deliveries',
        attempt: 1,
        errorClass: 'RangeError',
      },
      'dead letter could not be copied',
    );
  });

  it('processes 1000 queued advisories in order and counts only refused arrivals', async () => {
    const { read, release } = holdCopy();
    const { worker, emit, publish } = createWorker(read);
    const warn = vi.spyOn(Logger.prototype, 'warn');
    await worker.onApplicationBootstrap();
    emit(advisory(1));
    await vi.advanceTimersByTimeAsync(0);
    for (let seq = 2; seq <= 1005; seq += 1) {
      emit(advisory(seq));
    }
    expect(read).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      { subject: ADVISORY_SUBJECT, dropped: 1 },
      'dead-letter advisory queue is full: dropped',
    );

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(read.mock.calls.map(([, request]) => request.seq)).toEqual(
      Array.from({ length: 1001 }, (_unused, index) => index + 1),
    );
    expect(publish).toHaveBeenCalledTimes(1001);
    await worker.beforeApplicationShutdown();
  });

  it('releases the queued byte budget when dequeuing an advisory', async () => {
    const { read, release } = holdCopy();
    const { worker, emit } = createWorker(read);
    const bytes = new Uint8Array(16 * 1024 * 1024).fill(32);
    bytes.set(advisory(2));
    await worker.onApplicationBootstrap();
    emit(advisory(1));
    await vi.advanceTimersByTimeAsync(0);
    emit(bytes);
    emit(advisory(3));
    expect(read).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    emit(advisory(4));
    await vi.advanceTimersByTimeAsync(0);
    expect(read.mock.calls.map(([, request]) => request.seq)).toEqual([1, 2, 4]);
    await worker.beforeApplicationShutdown();
  });

  it('derives the same message ID and logs a fixed label for an external termination', async () => {
    const { read, release } = holdCopy();
    const { worker, emit, publish } = createWorker(read);
    const log = vi.spyOn(Logger.prototype, 'error');
    await worker.onApplicationBootstrap();
    emit(advisory(42, 'synthetic external text'), terminatedAdvisorySubject('EVENTS'));
    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(publish).toHaveBeenCalledWith(
      'dlq.example.evt.example.v1',
      original.data,
      expect.objectContaining({ msgID: 'EVENTS.example.42' }),
    );
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        consumer: 'example',
        streamSequence: 42,
        terminationReason: 'external-termination',
      }),
      'dead letter copied',
    );
    await worker.beforeApplicationShutdown();
  });
});
