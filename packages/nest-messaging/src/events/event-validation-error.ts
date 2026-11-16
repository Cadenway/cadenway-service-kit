/**
 * Interface EventValidationIssue
 *
 * @description
 * Identifies a contract mismatch by field and issue code.
 */
export interface EventValidationIssue {
  // #region Properties
  /**
   * Property path
   *
   * @description
   * Dotted path of the field, such as `actor.type`. Empty for the entire payload.
   *
   * @type {string}
   * @readonly
   */
  readonly path: string;

  /**
   * Property code
   *
   * @description
   * Zod issue code, such as `invalid_type`.
   *
   * @type {string}
   * @readonly
   */
  readonly code: string;
  // #endregion
}

/**
 * Class EventValidationError
 *
 * @description
 * Reports a payload that failed its event schema, identifying fields without their values.
 */
export class EventValidationError extends Error {
  // #region Properties
  /**
   * Property eventName
   *
   * @description
   * Name of the event whose contract was not met.
   *
   * @type {string}
   * @readonly
   */
  public readonly eventName: string;

  /**
   * Property issues
   *
   * @description
   * Fields that do not match, without their values.
   *
   * @type {readonly EventValidationIssue[]}
   * @readonly
   */
  public readonly issues: readonly EventValidationIssue[];
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Identifies the rejected event and which fields failed validation.
   *
   * @param {string} eventName - Name of the event whose payload failed validation.
   * @param {readonly EventValidationIssue[]} issues - Issue metadata without the rejected payload values.
   * @constructor
   */
  public constructor(eventName: string, issues: readonly EventValidationIssue[]) {
    const fields: string = issues
      .map((issue: EventValidationIssue) => `${issue.path || '(payload)'}: ${issue.code}`)
      .join(', ');
    super(`The payload of the event ${eventName} does not match its contract (${fields}).`);
    this.name = 'EventValidationError';
    this.eventName = eventName;
    this.issues = issues;
  }
  // #endregion
}
