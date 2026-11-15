import { randomBytes } from 'node:crypto';

/**
 * Function uuidv7
 *
 * @description
 * Generates a UUID version 7 (RFC 9562): 48 bits of Unix time in milliseconds, then 74 random
 * bits. Ids generated later sort after ids generated in an earlier millisecond.
 *
 * Used for the id of an event published without an outbox, where there is no database to ask.
 * An event that goes through the outbox takes its id from PostgreSQL instead.
 *
 * @param {number} timestampMs - Unix time in milliseconds; defaults to now.
 * @param {Uint8Array} random - Ten random bytes; defaults to bytes of the system generator.
 * @returns {string} The UUID, in lowercase with hyphens.
 * @throws {RangeError} When the time does not fit 48 bits or fewer than ten random bytes are given.
 */
export function uuidv7(
  timestampMs: number = Date.now(),
  random: Uint8Array = randomBytes(10),
): string {
  if (!Number.isInteger(timestampMs) || timestampMs < 0 || timestampMs > 0xffff_ffff_ffff) {
    throw new RangeError('The timestamp of a UUID version 7 is an integer of at most 48 bits.');
  }
  if (random.length < 10) {
    throw new RangeError('A UUID version 7 needs ten random bytes.');
  }
  const bytes: Uint8Array = new Uint8Array(16);
  let remaining: number = timestampMs;
  for (let index: number = 5; index >= 0; index -= 1) {
    bytes[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  bytes.set(random.subarray(0, 10), 6);
  // Version 7 in the high bits of byte 6, variant 10 in the high bits of byte 8.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex: string = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
