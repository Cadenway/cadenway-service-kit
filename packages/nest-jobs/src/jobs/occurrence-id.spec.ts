import { describe, expect, it } from 'vitest';

import { assertOccurrenceKey, deriveOccurrenceJobId } from './occurrence-id.js';

describe('deriveOccurrenceJobId', () => {
  it('keeps the stored derivation: SHA-256 of the JSON triple as a version 8 UUID', () => {
    expect(deriveOccurrenceJobId('reminders', 'org-1', 'reminder-42:3')).toBe(
      '87580123-fa10-8291-96f0-5fb798513aa5',
    );
    expect(deriveOccurrenceJobId('reminders', null, 'reminder-42:3')).toBe(
      '93ee0027-d696-8e05-800f-19affe9e0379',
    );
  });

  it('gives the same id for the same queue, organization and key', () => {
    expect(deriveOccurrenceJobId('reminders', 'org-1', 'reminder-42:3')).toBe(
      deriveOccurrenceJobId('reminders', 'org-1', 'reminder-42:3'),
    );
  });

  it('gives a lowercase UUID with the version and variant bits set', () => {
    expect(deriveOccurrenceJobId('digests', 'org-1', 'user-7:2026-11-14')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('separates occurrences by key and by queue', () => {
    const id: string = deriveOccurrenceJobId('reminders', 'org-1', 'reminder-42:3');

    expect(deriveOccurrenceJobId('reminders', 'org-1', 'reminder-42:4')).not.toBe(id);
    expect(deriveOccurrenceJobId('digests', 'org-1', 'reminder-42:3')).not.toBe(id);
  });

  it('separates the same key of two organizations, and of no organization', () => {
    const id: string = deriveOccurrenceJobId('digests', 'org-1', 'digest:2026-11-14');

    expect(deriveOccurrenceJobId('digests', 'org-2', 'digest:2026-11-14')).not.toBe(id);
    expect(deriveOccurrenceJobId('digests', null, 'digest:2026-11-14')).not.toBe(id);
    expect(deriveOccurrenceJobId('digests', 'null', 'digest:2026-11-14')).not.toBe(
      deriveOccurrenceJobId('digests', null, 'digest:2026-11-14'),
    );
  });

  it('does not confuse where one part ends and the next starts', () => {
    expect(deriveOccurrenceJobId('mail.send', 'org', 'x')).not.toBe(
      deriveOccurrenceJobId('mail', 'org', 'send.x'),
    );
    expect(deriveOccurrenceJobId('mail', 'org-1', 'x')).not.toBe(
      deriveOccurrenceJobId('mail', 'org', '-1x'),
    );
  });

  it('rejects an empty key', () => {
    expect(() => deriveOccurrenceJobId('reminders', 'org-1', '')).toThrow(/non-empty string/);
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
