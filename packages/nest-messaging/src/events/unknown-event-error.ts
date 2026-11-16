/**
 * Class UnknownEventError
 *
 * @description
 * Reports an event name with no validator in the supplied event schemas.
 */
export class UnknownEventError extends Error {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Identifies the event whose validator is missing.
   *
   * @param {string} eventName - Name that is missing from the supplied event schemas.
   * @constructor
   */
  public constructor(eventName: string) {
    super(`The event ${eventName} has no validator in the given event schemas.`);
    this.name = 'UnknownEventError';
  }
  // #endregion
}
