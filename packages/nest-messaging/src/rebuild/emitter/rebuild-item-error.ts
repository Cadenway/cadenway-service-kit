/**
 * Class RebuildItemError
 *
 * @description
 * Reports local schema validation failure before the emitter sends the item.
 */
export class RebuildItemError extends Error {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Lists invalid field paths without including the values.
   *
   * @param {string} subject - Intended rebuild subject.
   * @param {readonly string[]} fields - Dotted paths of the fields that failed validation.
   * @constructor
   */
  public constructor(subject: string, fields: readonly string[]) {
    super(
      `A rebuild item for ${subject} does not match its schema (${fields.join(', ') || 'item'}).`,
    );
    this.name = 'RebuildItemError';
  }
  // #endregion
}
