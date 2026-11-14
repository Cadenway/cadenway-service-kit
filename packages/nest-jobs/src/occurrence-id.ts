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
 * Derives the job id of an occurrence from its queue and its key.
 *
 * The id is the first 122 bits of the SHA-256 of the JSON array `[queue, occurrenceKey]`, laid out
 * as a version 8 UUID. The same pair always gives the same id, and the job table has a primary key
 * on (queue, id): a second insert of the same occurrence conflicts and inserts nothing for as long
 * as the first row exists. The derivation is part of the stored format: changing it would let an
 * occurrence already enqueued be enqueued again.
 *
 * @param {string} queue - Queue the job is enqueued in.
 * @param {string} occurrenceKey - Key that identifies the occurrence within the queue.
 * @returns {string} A lowercase UUID, stable for the pair.
 * @throws {Error} When the key is not a non-empty string.
 */
export function deriveOccurrenceJobId(queue: string, occurrenceKey: string): string {
  assertOccurrenceKey(occurrenceKey);
  const digest: Buffer = createHash('sha256')
    .update(JSON.stringify([queue, occurrenceKey]), 'utf8')
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
