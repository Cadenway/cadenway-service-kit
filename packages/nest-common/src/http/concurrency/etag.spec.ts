import { describe, expect, it } from 'vitest';

import { ProblemException } from '../../problem/problem.js';
import { assertVersionMatch, formatEtag, parseIfMatch } from './etag.js';

describe('If-Match parsing', () => {
  it('preserves absent, wildcard and canonical numeric conditions', () => {
    expect(parseIfMatch(undefined)).toBeUndefined();
    expect(parseIfMatch(' \t')).toBeUndefined();
    expect(parseIfMatch('\t* ')).toBe('*');
    expect(parseIfMatch('"0", "7"')).toEqual([0, 7]);
  });

  it('matches every safe integer the kit can emit', () => {
    const version = Number.MAX_SAFE_INTEGER;

    expect(parseIfMatch(formatEtag(version))).toEqual([version]);
    expect(() => {
      assertVersionMatch(parseIfMatch(formatEtag(version)), version);
    }).not.toThrow();
  });

  it('accepts commas inside opaque tags and ignores empty list members', () => {
    expect(parseIfMatch(' , "left,right", W/"weak,opaque", ,\t"7", ')).toEqual([7]);
    expect(parseIfMatch('"opaque\\", "\u00e9", "", "7"')).toEqual([7]);
  });

  it('returns a precondition failure when no strong tag matches the version', () => {
    expect.assertions(3);
    const condition = parseIfMatch('W/"7", "07", "+7", "7e0", "opaque,7", "9007199254740992"');

    expect(condition).toEqual([]);
    try {
      assertVersionMatch(condition, 7);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ProblemException);
      expect(error).toMatchObject({ problem: { status: 412, code: 'request.version-mismatch' } });
    }
  });

  it.each([
    '7',
    '*, "7"',
    '"7" "8"',
    'w/"7"',
    '"unterminated',
    '"bad space", "7"',
    '"bad\ttab", "7"',
    '"bad\u0000byte", "7"',
    '"bad\u0100byte", "7"',
    '"7"\r\n',
  ])('reports a malformed condition without exposing its value (%j)', (header) => {
    expect.assertions(2);
    try {
      parseIfMatch(header);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ProblemException);
      expect(error).toMatchObject({
        problem: {
          status: 400,
          code: 'request.invalid',
          details: {
            issues: [
              {
                in: 'header',
                path: 'If-Match',
                code: 'invalid_format',
                message: 'Expected "*" or a list of quoted entity tags.',
              },
            ],
          },
        },
      });
    }
  });
});
