/**
 * Function fieldOf
 *
 * @description
 * Reads one column of a row returned by the database handle of pg-boss, which types rows loosely.
 *
 * @param {unknown} row - Row of a query result.
 * @param {string} column - Column name.
 * @returns {unknown} The value of the column, or `undefined` when the row has none.
 */
export function fieldOf(row: unknown, column: string): unknown {
  return typeof row === 'object' && row !== null
    ? (row as Record<string, unknown>)[column]
    : undefined;
}
