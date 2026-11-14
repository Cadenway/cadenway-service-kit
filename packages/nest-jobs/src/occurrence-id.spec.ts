import { describe, expect, it } from 'vitest';

import { assertOccurrenceKey, deriveOccurrenceJobId } from './occurrence-id.js';

describe('deriveOccurrenceJobId', () => {
  it('keeps the stored derivation: SHA-256 of the JSON pair as a version 8 UUID', () => {
    expect(deriveOccurrenceJobId('reminders', 'reminder-42:3')).toBe(
      '013908b2-1297-897a-8df0-9f5b66b5aa2b',
    );
  });

  it('gives the same id for the same queue and key', () => {
    expect(deriveOccurrenceJobId('reminders', 'reminder-42:3')).toBe(
      deriveOccurrenceJobId('reminders', 'reminder-42:3'),
    );
  });

  it('gives a lowercase UUID with the version and variant bits set', () => {
    expect(deriveOccurrenceJobId('digests', 'user-7:2026-11-14')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('separates occurrences by key and by queue', () => {
    const id: string = deriveOccurrenceJobId('reminders', 'reminder-42:3');

    expect(deriveOccurrenceJobId('reminders', 'reminder-42:4')).not.toBe(id);
    expect(deriveOccurrenceJobId('digests', 'reminder-42:3')).not.toBe(id);
  });

  it('does not confuse where the queue ends and the key starts', () => {
    expect(deriveOccurrenceJobId('mail.send', 'x')).not.toBe(
      deriveOccurrenceJobId('mail', 'send.x'),
    );
  });

  it('rejects an empty key', () => {
    expect(() => deriveOccurrenceJobId('reminders', '')).toThrow(/non-empty string/);
  });
});

describe('assertOccurrenceKey', () => {
  it.each([[''], [42], [null], [undefined], [{ id: 1 }]])('rejects %j', (key: unknown) => {
    expect(() => {
      assertOccurrenceKey(key);
    }).toThrow(/non-empty string/);
  });

  it('accepts any non-empty string', () => {
    expect(() => {
      assertOccurrenceKey('reminder 42 / occurrence 3');
    }).not.toThrow();
  });
});
