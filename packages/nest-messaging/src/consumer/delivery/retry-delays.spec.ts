import { describe, expect, it } from 'vitest';

import { DEFAULT_RETRY_DELAYS_MS, maxDeliveriesOf, retryDelayMs } from './retry-delays.js';

describe('retry delays', () => {
  it('waits 1 s, 5 s, 30 s then 2 min after the first four failed deliveries', () => {
    expect([1, 2, 3, 4].map((deliveryCount: number) => retryDelayMs(deliveryCount))).toEqual([
      1000, 5000, 30_000, 120_000,
    ]);
  });

  it('gives no delay after the fifth delivery, which is the last one', () => {
    expect(retryDelayMs(5)).toBeUndefined();
    expect(retryDelayMs(6)).toBeUndefined();
  });

  it('treats a delivery count below one as the first delivery', () => {
    expect(retryDelayMs(0)).toBe(1000);
  });

  it('allows one delivery more than there are delays', () => {
    expect(maxDeliveriesOf()).toBe(5);
    expect(maxDeliveriesOf([10, 20])).toBe(3);
  });

  it('follows the delays it is given', () => {
    expect(retryDelayMs(2, [10, 20])).toBe(20);
    expect(retryDelayMs(3, [10, 20])).toBeUndefined();
    expect(DEFAULT_RETRY_DELAYS_MS).toHaveLength(4);
  });
});

describe('retry delays with a delivery limit', () => {
  it('repeats the last delay until the delivery limit', () => {
    expect(
      [1, 2, 3, 4, 5, 6].map((deliveryCount: number) => retryDelayMs(deliveryCount, [10, 20], 6)),
    ).toEqual([10, 20, 20, 20, 20, undefined]);
  });

  it('keeps the default schedule when the limit is one more than the delays', () => {
    expect(
      [1, 2, 3, 4, 5].map((deliveryCount: number) =>
        retryDelayMs(deliveryCount, DEFAULT_RETRY_DELAYS_MS, 5),
      ),
    ).toEqual([1000, 5000, 30_000, 120_000, undefined]);
  });
});
