/**
 * Class EventStreamUnavailableError
 *
 * @description
 * Reports a publish to a subject without a stream, including when JetStream is disabled.
 */
export class EventStreamUnavailableError extends Error {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Identifies the subject and expected stream while retaining the client failure as the cause.
   *
   * @param {string} subject - Subject whose publication JetStream could not route.
   * @param {string} stream - Expected destination stream.
   * @param {unknown} cause - Underlying NATS error retained for diagnostic handling.
   * @constructor
   */
  public constructor(subject: string, stream: string, cause: unknown) {
    super(
      `No JetStream stream stores the subject ${subject}: the stream ${stream} is missing or JetStream is disabled. ` +
        'The streams are created by the platform, or by MessagingModule with manageStreams.',
      { cause },
    );
    this.name = 'EventStreamUnavailableError';
  }
  // #endregion
}
