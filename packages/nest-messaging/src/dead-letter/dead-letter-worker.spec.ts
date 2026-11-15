import { describe, expect, it } from 'vitest';

import { boundedReason } from './dead-letter-worker.js';

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
