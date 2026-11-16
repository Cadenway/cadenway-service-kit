import { getEventListeners } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { waitForRetry } from './wait-for-retry.js';

describe('waitForRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes the listener after each elapsed delay', async () => {
    const { signal } = new AbortController();
    for (let attempt: number = 0; attempt < 3; attempt += 1) {
      const waiting: Promise<void> = waitForRetry(1000, signal);
      expect(getEventListeners(signal, 'abort')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      await waiting;
      expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    }
  });

  it('resolves immediately on shutdown and clears the pending timer', async () => {
    const stop: AbortController = new AbortController();
    const waiting: Promise<void> = waitForRetry(1000, stop.signal);

    stop.abort();
    await waiting;
    await waitForRetry(1000, stop.signal);

    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
  });
});
