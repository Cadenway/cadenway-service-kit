import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { uuidv7 } from './uuid-v7.js';

describe('uuidv7', () => {
  it('generates a UUID that the contracts accept as an event id', () => {
    const id: string = uuidv7();

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(z.uuid().safeParse(id).success).toBe(true);
    expect(z.uuidv7().safeParse(id).success).toBe(true);
  });

  it('writes the time in the first 48 bits and the random bytes after the version', () => {
    const random: Uint8Array = Uint8Array.from([
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ]);

    expect(uuidv7(0x0193_a1f0_0000, random)).toBe('0193a1f0-0000-7fff-bfff-ffffffffffff');
    expect(uuidv7(0, new Uint8Array(10))).toBe('00000000-0000-7000-8000-000000000000');
  });

  it('sorts an id generated in a later millisecond after an earlier one', () => {
    const earlier: string = uuidv7(1_700_000_000_000);
    const later: string = uuidv7(1_700_000_000_001);

    expect(earlier < later).toBe(true);
  });

  it('does not repeat an id inside one millisecond', () => {
    const ids: Set<string> = new Set<string>(
      Array.from({ length: 1000 }, () => uuidv7(1_700_000_000_000)),
    );

    expect(ids.size).toBe(1000);
  });

  it('refuses a time that does not fit 48 bits and too few random bytes', () => {
    expect(() => uuidv7(2 ** 48)).toThrow(RangeError);
    expect(() => uuidv7(-1)).toThrow(RangeError);
    expect(() => uuidv7(0, new Uint8Array(9))).toThrow(RangeError);
  });
});
