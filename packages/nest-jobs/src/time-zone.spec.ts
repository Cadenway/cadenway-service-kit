import { describe, expect, it } from 'vitest';

import { assertTimeZone } from './time-zone.js';

describe('assertTimeZone', () => {
  it.each([['Europe/Paris'], ['America/New_York'], ['Asia/Kolkata'], ['UTC']])(
    'accepts the IANA name %s',
    (timeZone: string) => {
      expect(() => {
        assertTimeZone(timeZone);
      }).not.toThrow();
    },
  );

  it.each([[undefined], [null], [''], ['   '], [120]])(
    'rejects the missing time zone %j',
    (timeZone: unknown) => {
      expect(() => {
        assertTimeZone(timeZone);
      }).toThrow(/timeZone is required/);
    },
  );

  it.each([['Mars/Olympus'], ['Europe/Pariss'], ['local']])(
    'rejects the unknown time zone %s',
    (timeZone: string) => {
      expect(() => {
        assertTimeZone(timeZone);
      }).toThrow(/not a known IANA time zone name/);
    },
  );

  it.each([['+02:00'], ['-0500']])('rejects the fixed offset %s', (timeZone: string) => {
    expect(() => {
      assertTimeZone(timeZone);
    }).toThrow(/fixed offset/);
  });
});
