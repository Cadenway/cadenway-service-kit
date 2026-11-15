import { describe, expect, it } from 'vitest';

import { decodeRebuildReply, encodeRebuildReply } from './rebuild-emitter.js';

describe('rebuild reply', () => {
  it('round-trips an acknowledgement', () => {
    expect(decodeRebuildReply(encodeRebuildReply(null))).toBeNull();
  });

  it.each(['invalid-item', 'handler-failed'] as const)(
    'round-trips the rejection %s',
    (reason: 'invalid-item' | 'handler-failed') => {
      expect(decodeRebuildReply(encodeRebuildReply(reason))).toBe(reason);
    },
  );

  it.each(['', 'not json', '{}', '{"ok":false}', '{"ok":false,"reason":"other"}', 'null'])(
    'refuses the reply %s, which the kit never sends',
    (reply: string) => {
      expect(() => decodeRebuildReply(reply)).toThrow(/Unexpected reply/u);
    },
  );
});
