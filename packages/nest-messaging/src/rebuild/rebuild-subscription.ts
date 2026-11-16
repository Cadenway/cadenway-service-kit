import type { z } from 'zod';

/**
 * Interface RebuildSubscription
 *
 * @description
 * Registration of the handler of one rebuilt entity.
 */
export interface RebuildSubscription<TItem> {
  // #region Properties
  /**
   * Property entity
   *
   * @description
   * Name of the entity, such as `task`: the last token of `rebuild.<rebuild name>.<entity>`.
   *
   * @type {string}
   * @readonly
   */
  readonly entity: string;

  /**
   * Property schema
   *
   * @description
   * Zod schema of an item. An item that does not match is refused.
   *
   * @type {z.ZodType<TItem>}
   * @readonly
   */
  readonly schema: z.ZodType<TItem>;

  /**
   * Property handle
   *
   * @description
   * Applies one item. It runs in a context without organization, whatever the context
   * `onRebuild` was called in: it opens the transaction it needs itself. It must be idempotent,
   * since a rebuild may be started again.
   *
   * @type {(item: TItem) => Promise<void>}
   * @readonly
   */
  readonly handle: (item: TItem) => Promise<void>;
  // #endregion
}
