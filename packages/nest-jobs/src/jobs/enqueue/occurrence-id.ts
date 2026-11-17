import { createHash } from 'node:crypto';

/**
 * Function assertOccurrenceKey
 *
 * @description
 * Refuses an occurrence key that cannot identify an occurrence.
 *
 * @param {unknown} occurrenceKey - Candidate key.
 * @throws {Error} When the key is not a non-empty string.
 */
export function assertOccurrenceKey(occurrenceKey: unknown): asserts occurrenceKey is string {
  if (typeof occurrenceKey !== 'string' || occurrenceKey === '') {
    throw new Error('occurrenceKey must be a non-empty string.');
  }
}

/**
 * Function deriveOccurrenceJobId
 *
 * @description
 * Derives the job id of an occurrence from its queue, its organization and its key.
 *
 * The id is the first 122 bits of the SHA-256 of the JSON array
 * `[queue, organizationId, occurrenceKey]`, laid out as a version 8 UUID. The same triple always
 * gives the same id, and the job table has a primary key on (queue, id): a second insert of the
 * same occurrence conflicts and inserts nothing for as long as the first row exists. The
 * organization is part of the hash so a key that is not globally unique, such as a date, cannot
 * let one organization suppress the job of another. The derivation is a stored format and does not
 * change: changing it would let an occurrence already enqueued be enqueued again.
 *
 * @param {string} queue - Queue the job is enqueued in.
 * @param {string | null} organizationId - Organization of the enqueuing transaction, or `null`.
 * @param {string} occurrenceKey - Key that identifies the occurrence within the queue and the
 *   organization.
 * @returns {string} A lowercase UUID, stable for the triple.
 * @throws {Error} When the key is not a non-empty string.
 */
export function deriveOccurrenceJobId(
  queue: string,
  organizationId: string | null,
  occurrenceKey: string,
): string {
  assertOccurrenceKey(occurrenceKey);
  const digest: Buffer = createHash('sha256')
    .update(JSON.stringify([queue, organizationId, occurrenceKey]), 'utf8')
    .digest();
  const bytes: Buffer = digest.subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x80, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex: string = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
