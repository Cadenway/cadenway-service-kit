import { describe, expect, it } from 'vitest';

import { RebuildQueue } from './rebuild-queue.js';

describe('RebuildQueue', () => {
  it('evicts the oldest waiting items at the item limit', () => {
    const queue: RebuildQueue = new RebuildQueue(2, 1_000);
    const discarded: string[] = [];
    const discard = (reply: string): void => {
      discarded.push(reply);
    };

    queue.enqueue(new Uint8Array(1), 'first', discard);
    queue.enqueue(new Uint8Array(1), 'second', discard);
    queue.enqueue(new Uint8Array(1), 'third', discard);

    expect(discarded).toEqual(['first']);
    expect(queue.dequeue()?.reply).toBe('second');
    expect(queue.dequeue()?.reply).toBe('third');
    expect(queue.dequeue()).toBeUndefined();
  });

  it('counts waiting data and reply subjects, and leaves admitted work when an item cannot fit', () => {
    const queue: RebuildQueue = new RebuildQueue(10, 10);
    const discarded: string[] = [];
    const discard = (reply: string): void => {
      discarded.push(reply);
    };

    queue.enqueue(new Uint8Array(6), 'one', discard);
    queue.enqueue(new Uint8Array(5), 'two', discard);
    queue.enqueue(new Uint8Array(8), 'too-large', discard);

    expect(discarded).toEqual(['one', 'too-large']);
    expect(queue.dequeue()?.reply).toBe('two');
    queue.enqueue(new Uint8Array(6), 'new', discard);
    expect(queue.dequeue()?.reply).toBe('new');
    expect(discarded).toEqual(['one', 'too-large']);
  });

  it('retains only a detached copy of the admitted message bytes', () => {
    const queue: RebuildQueue = new RebuildQueue(1, 10);
    const frame: Uint8Array = new Uint8Array(1024);
    frame[0] = 23;

    queue.enqueue(frame.subarray(0, 1), '', () => undefined);
    frame[0] = 42;

    const retained: Uint8Array | undefined = queue.dequeue()?.data;
    expect(retained?.[0]).toBe(23);
    expect(retained?.buffer.byteLength).toBe(1);
  });
});
