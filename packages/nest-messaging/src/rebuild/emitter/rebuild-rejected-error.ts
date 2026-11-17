import type { RebuildRejection } from '../codec/rebuild-reply-codec.js';

/**
 * Class RebuildRejectedError
 *
 * @description
 * Reports that a rebuild consumer replied without applying the item. The item can be resent.
 */
export class RebuildRejectedError extends Error {
  // #region Properties
  /**
   * Property reason
   *
   * @description
   * Reason reported by the consumer.
   *
   * @type {RebuildRejection}
   * @readonly
   */
  public readonly reason: RebuildRejection;
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Identifies the rebuild subject and the reason for rejection.
   *
   * @param {string} subject - Rebuild subject that received the item.
   * @param {RebuildRejection} reason - Failure category the receiver reported.
   * @constructor
   */
  public constructor(subject: string, reason: RebuildRejection) {
    super(`The consumer of ${subject} refused a rebuild item: ${reason}.`);
    this.name = 'RebuildRejectedError';
    this.reason = reason;
  }
  // #endregion
}
