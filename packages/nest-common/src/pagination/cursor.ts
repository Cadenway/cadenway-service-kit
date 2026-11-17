import { createHash } from 'node:crypto';

import { z } from 'zod';

import { ProblemException } from '../problem/problem.js';

/**
 * Constant DEFAULT_PAGE_LIMIT
 *
 * @description
 * Page size used when the caller sends no `limit`.
 *
 * @type {number}
 */
export const DEFAULT_PAGE_LIMIT: number = 50;

/**
 * Constant MAX_PAGE_LIMIT
 *
 * @description
 * Largest page size a caller may ask for.
 *
 * @type {number}
 */
export const MAX_PAGE_LIMIT: number = 100;

/**
 * Constant MAX_CURSOR_LENGTH
 *
 * @description
 * Longest cursor accepted, in characters. A cursor holds a few sort values and an id; anything
 * longer was not produced by this codec.
 *
 * @type {number}
 */
const MAX_CURSOR_LENGTH: number = 2048;

/**
 * Type CursorValue
 *
 * @description
 * Value of one sort column in a cursor. Encode an instant as an ISO 8601 string.
 *
 * @type {string | number | boolean | null}
 */
export type CursorValue = string | number | boolean | null;

/**
 * Interface CursorPosition
 *
 * @description
 * Position of the last row of a page: where the next page starts.
 */
export interface CursorPosition {
  // #region Properties
  /**
   * Property sort
   *
   * @description
   * Values of the sort columns for the last row, in sort order.
   *
   * @type {readonly CursorValue[]}
   * @readonly
   */
  readonly sort: readonly CursorValue[];

  /**
   * Property id
   *
   * @description
   * Id of the last row, the tie-breaker that makes the order total.
   *
   * @type {string}
   * @readonly
   */
  readonly id: string;
  // #endregion
}

/**
 * Interface PageQuery
 *
 * @description
 * Pagination parameters of a list route, as validated by `pageQueryShape`.
 */
export interface PageQuery {
  // #region Properties
  /**
   * Property cursor
   *
   * @description
   * Opaque cursor returned as `nextCursor` by the previous page; absent for the first page.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly cursor?: string | undefined;

  /**
   * Property limit
   *
   * @description
   * Page size, from 1 to 100. Defaults to 50.
   *
   * @type {number}
   * @readonly
   */
  readonly limit: number;
  // #endregion
}

/**
 * Interface Page
 *
 * @description
 * One page of a list, in the shape the contracts use.
 */
export interface Page<TItem> {
  // #region Properties
  /**
   * Property items
   *
   * @description
   * Rows of the page, at most `limit`.
   *
   * @type {TItem[]}
   * @readonly
   */
  readonly items: TItem[];

  /**
   * Property nextCursor
   *
   * @description
   * Cursor of the next page, or `null` on the last page.
   *
   * @type {string | null}
   * @readonly
   */
  readonly nextCursor: string | null;
  // #endregion
}

/**
 * Constant pageQueryShape
 *
 * @description
 * Zod shape of the `cursor` and `limit` query parameters. Spread it into the query schema of a
 * list route written by hand; a schema generated from the contracts already declares them.
 *
 * @type {{ readonly cursor: z.ZodType<string | undefined>; readonly limit: z.ZodType<number>; }}
 */
export const pageQueryShape: {
  readonly cursor: z.ZodType<string | undefined>;
  readonly limit: z.ZodType<number>;
} = {
  cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
};

/**
 * Constant positionSchema
 *
 * @description
 * Shape of a decoded cursor: sort values, id and filter fingerprint, under short keys.
 *
 * @type {z.ZodType<{ s: CursorValue[]; i: string; f: string; }>}
 */
const positionSchema: z.ZodType<{ s: CursorValue[]; i: string; f: string }> = z.strictObject({
  s: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(8),
  i: z.string().min(1),
  f: z.string().min(1),
});

/**
 * Function canonicalize
 *
 * @description
 * Rewrites a value so that two equal filter sets serialize identically: object keys sorted,
 * `undefined` members dropped.
 *
 * @param {unknown} value - Filter value.
 * @returns {unknown} The same value with a stable member order.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === 'object' && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const member: unknown = (value as Record<string, unknown>)[key];
      if (member !== undefined) {
        sorted[key] = canonicalize(member);
      }
    }
    return sorted;
  }
  return value;
}

/**
 * Function filterFingerprint
 *
 * @description
 * Computes a short fingerprint of what defines a list: its filters and its sort. A cursor only
 * continues the list it came from.
 *
 * @param {unknown} filters - Filters and sort of the list, as a JSON-serializable value.
 * @returns {string} The fingerprint, 16 base64url characters.
 */
export function filterFingerprint(filters: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(filters ?? null)))
    .digest('base64url')
    .slice(0, 16);
}

/**
 * Function encodeCursor
 *
 * @description
 * Encodes the position of the last row of a page into an opaque cursor that carries the sort
 * values, the id and a fingerprint of the filters.
 *
 * The cursor is opaque, not secret and not signed: it only positions a query that still filters
 * on the organization of the verified token.
 *
 * @param {CursorPosition} position - Sort values and id of the last row.
 * @param {unknown} filters - Filters and sort of the list, as a JSON-serializable value.
 * @returns {string} The cursor, in base64url.
 */
export function encodeCursor(position: CursorPosition, filters: unknown): string {
  return Buffer.from(
    JSON.stringify({ s: position.sort, i: position.id, f: filterFingerprint(filters) }),
    'utf8',
  ).toString('base64url');
}

/**
 * Function invalidCursor
 *
 * @description
 * Builds the problem answered to a cursor that cannot be used: `400 request.invalid`, the code
 * the contracts declare for a request that does not match its schema, with one
 * `details.issues` entry on the `cursor` query parameter. A malformed cursor and a cursor issued
 * for another list get the same answer, which never quotes the cursor.
 *
 * @returns {ProblemException} A 400 `request.invalid` problem.
 */
function invalidCursor(): ProblemException {
  return new ProblemException({
    status: 400,
    code: 'request.invalid',
    detail: 'The request does not match its contract.',
    details: {
      issues: [
        {
          in: 'query',
          path: 'cursor',
          code: 'invalid_cursor',
          message: 'Expected the nextCursor of a previous page of this list.',
        },
      ],
    },
  });
}

/**
 * Function decodeCursor
 *
 * @description
 * Decodes a cursor produced by `encodeCursor` and checks it belongs to the same list.
 *
 * @param {string} cursor - Cursor sent by the caller.
 * @param {unknown} filters - Filters and sort of the current request.
 * @returns {CursorPosition} The position the page starts after.
 * @throws {ProblemException} 400 `request.invalid`, with one issue `{ in: 'query', path: 'cursor', code: 'invalid_cursor' }`, when the cursor is malformed or was issued for other filters.
 */
export function decodeCursor(cursor: string, filters: unknown): CursorPosition {
  if (cursor.length > MAX_CURSOR_LENGTH) {
    throw invalidCursor();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const parsed: z.ZodSafeParseResult<{ s: CursorValue[]; i: string; f: string }> =
    positionSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.f !== filterFingerprint(filters)) {
    throw invalidCursor();
  }
  return { sort: parsed.data.s, id: parsed.data.i };
}

/**
 * Function buildPage
 *
 * @description
 * Builds a page from rows fetched with `limit + 1`: the extra row only tells that a next page
 * exists and is not returned.
 *
 * @param {readonly TItem[]} rows - Rows read from the database, at most `limit + 1`.
 * @param {number} limit - Page size asked by the caller.
 * @param {(last: TItem) => string} cursorOf - Encodes the cursor of the last returned row.
 * @returns {Page<TItem>} The page, with `nextCursor` set to `null` on the last one.
 */
export function buildPage<TItem>(
  rows: readonly TItem[],
  limit: number,
  cursorOf: (last: TItem) => string,
): Page<TItem> {
  const items: TItem[] = rows.slice(0, limit);
  const last: TItem | undefined = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last !== undefined ? cursorOf(last) : null,
  };
}
