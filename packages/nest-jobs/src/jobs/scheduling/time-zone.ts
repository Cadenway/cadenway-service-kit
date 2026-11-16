/**
 * Constant UTC_OFFSET_PATTERN
 *
 * @description
 * Matches a fixed offset such as `+02:00`. `Intl` accepts one as a time zone, but an offset is not
 * an IANA name and does not follow daylight saving time, so it is refused.
 *
 * @type {RegExp}
 */
const UTC_OFFSET_PATTERN: RegExp = /^[+-]/u;

/**
 * Function assertTimeZone
 *
 * @description
 * Refuses anything that is not an IANA time zone name known to the runtime, such as `Europe/Paris`
 * or `UTC`. A schedule is evaluated in the zone given here, never in the local time of the server.
 *
 * @param {unknown} timeZone - Candidate time zone.
 * @throws {Error} When the value is missing, is a fixed offset or names no known time zone.
 */
export function assertTimeZone(timeZone: unknown): asserts timeZone is string {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') {
    throw new Error('timeZone is required: give an IANA time zone name such as "Europe/Paris".');
  }
  if (UTC_OFFSET_PATTERN.test(timeZone)) {
    throw new Error(`timeZone "${timeZone}" is a fixed offset: give an IANA time zone name.`);
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new Error(`timeZone "${timeZone}" is not a known IANA time zone name.`);
  }
}
