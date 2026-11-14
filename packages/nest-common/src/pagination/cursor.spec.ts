import { describe, expect, it } from 'vitest';

import { ProblemException } from '../problem/problem.js';
import {
  buildPage,
  decodeCursor,
  encodeCursor,
  filterFingerprint,
  type CursorPosition,
  type Page,
} from './cursor.js';

/**
 * Constant position
 *
 * @description
 * Position of a row sorted by due date, then id.
 *
 * @type {CursorPosition}
 */
const position: CursorPosition = {
  sort: ['2026-11-17T00:00:00.000Z', 3],
  id: '0193a1f0-7b1c-7c3e-9d2a-5e8f3b1c2d4e',
};

/**
 * Function problemCode
 *
 * @description
 * Runs a function expected to throw a problem and returns its code.
 *
 * @param {() => unknown} run - Function under test.
 * @returns {string} The code of the thrown problem.
 */
function problemCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof ProblemException) {
      return `${String(error.problem.status)} ${error.problem.code}`;
    }
    throw error;
  }
  throw new Error('Expected a problem to be thrown.');
}

describe('cursor codec', () => {
  it('round-trips a position for the same filters, whatever their key order', () => {
    const cursor: string = encodeCursor(position, { sort: '-dueDate', status: ['open', 'review'] });

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(decodeCursor(cursor, { status: ['open', 'review'], sort: '-dueDate' })).toEqual(
      position,
    );
  });

  it('refuses a cursor issued for other filters or another sort', () => {
    const cursor: string = encodeCursor(position, { sort: '-dueDate', status: ['open'] });

    expect(problemCode(() => decodeCursor(cursor, { sort: 'dueDate', status: ['open'] }))).toBe(
      '400 pagination.invalid-cursor',
    );
    expect(problemCode(() => decodeCursor(cursor, { sort: '-dueDate' }))).toBe(
      '400 pagination.invalid-cursor',
    );
  });

  it('refuses a malformed, forged or oversized cursor', () => {
    const forged: string = Buffer.from(JSON.stringify({ s: [{}], i: 'x', f: 'y' })).toString(
      'base64url',
    );

    for (const cursor of ['not base64 json', '', forged, 'A'.repeat(4096)]) {
      expect(problemCode(() => decodeCursor(cursor, {}))).toBe('400 pagination.invalid-cursor');
    }
  });

  it('ignores undefined filters in the fingerprint', () => {
    expect(filterFingerprint({ status: 'open', assignee: undefined })).toBe(
      filterFingerprint({ status: 'open' }),
    );
    expect(filterFingerprint({ status: 'open' })).not.toBe(filterFingerprint({ status: 'done' }));
  });
});

describe('buildPage', () => {
  it('drops the extra row and returns the cursor of the last returned one', () => {
    const page: Page<number> = buildPage([1, 2, 3], 2, (last: number) => `after-${String(last)}`);

    expect(page).toEqual({ items: [1, 2], nextCursor: 'after-2' });
  });

  it('returns a null cursor on the last page and on an empty one', () => {
    expect(buildPage([1, 2], 2, () => 'unused')).toEqual({ items: [1, 2], nextCursor: null });
    expect(buildPage([], 2, () => 'unused')).toEqual({ items: [], nextCursor: null });
  });
});
