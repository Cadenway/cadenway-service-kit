import { describe, expect, it } from 'vitest';

import { decodeRebuildReply, encodeRebuildReply } from './rebuild-emitter.js';

describe('rebuild reply', () => {
  it('writes the stable reply format', () => {
    expect(encodeRebuildReply(null)).toBe('{"ok":true}');
    expect(encodeRebuildReply('invalid-item')).toBe('{"ok":false,"reason":"invalid-item"}');
  });

  it('round-trips an acknowledgement', () => {
    expect(decodeRebuildReply(encodeRebuildReply(null))).toBeNull();
  });

  it.each(['invalid-item', 'handler-failed', 'overloaded'] as const)(
    'round-trips the rejection %s',
    (reason: 'invalid-item' | 'handler-failed' | 'overloaded') => {
      expect(decodeRebuildReply(encodeRebuildReply(reason))).toBe(reason);
    },
  );

  it.each([
    '{"ok":false,"reason":"quota-exceeded"}',
    '{"ok":false,"reason":42}',
    '{"ok":false}',
    '{"ok":"yes"}',
    '{}',
    'null',
    'not json',
    '',
  ])(
    'reads the reply %s, which this version does not know, as a generic rejection',
    (reply: string) => {
      expect(decodeRebuildReply(reply)).toBe('unknown');
    },
  );
});
