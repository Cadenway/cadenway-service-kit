/**
 * Interface JobScheduleOptions
 *
 * @description
 * Options of one cron schedule.
 */
export interface JobScheduleOptions {
  // #region Properties
  /**
   * Property timeZone
   *
   * @description
   * IANA time zone the cron expression is evaluated in, such as `Europe/Paris` or `UTC`.
   * Mandatory: a schedule never follows the local time of the server.
   *
   * @type {string}
   * @readonly
   */
  readonly timeZone: string;

  /**
   * Property payload
   *
   * @description
   * JSON-serializable payload of every job the schedule creates. Defaults to `null`.
   *
   * @type {unknown}
   * @readonly
   */
  readonly payload?: unknown;

  /**
   * Property key
   *
   * @description
   * Distinguishes several schedules on one queue: letters, digits, underscores, hyphens, periods
   * and forward slashes. Registering the same queue and key again replaces the schedule. Defaults
   * to the empty key.
   *
   * @type {string}
   * @readonly
   */
  readonly key?: string;
  // #endregion
}

/**
 * Interface JobUnscheduleOptions
 *
 * @description
 * Options that designate the schedule to remove.
 */
export interface JobUnscheduleOptions {
  // #region Properties
  /**
   * Property key
   *
   * @description
   * Key the schedule was registered with. Defaults to the empty key.
   *
   * @type {string}
   * @readonly
   */
  readonly key?: string;
  // #endregion
}
