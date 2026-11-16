/**
 * Type RebuildRejection
 *
 * @description
 * Why a consumer refused a rebuild item: the item does not match the schema the consumer
 * validates with, its handler failed, too many items were waiting, or a reason this version of
 * the kit does not know (sent by a newer consumer).
 *
 * @type {'invalid-item' | 'handler-failed' | 'overloaded' | 'unknown'}
 */
export type RebuildRejection = 'invalid-item' | 'handler-failed' | 'overloaded' | 'unknown';

/**
 * Constant KNOWN_REJECTIONS
 *
 * @description
 * Rejection reasons this version of the kit sends.
 *
 * @type {ReadonlySet<string>}
 */
const KNOWN_REJECTIONS: ReadonlySet<string> = new Set<string>([
  'invalid-item',
  'handler-failed',
  'overloaded',
]);

/**
 * Function encodeRebuildReply
 *
 * @description
 * Encodes the answer of a consumer to one rebuild item: `{"ok":true}`, or
 * `{"ok":false,"reason":"<reason>"}`. A stable format, changed only in a major.
 *
 * @param {Exclude<RebuildRejection, 'unknown'> | null} rejection - Why the item was refused, or `null` when it was applied.
 * @returns {string} The reply payload, as JSON.
 */
export function encodeRebuildReply(rejection: Exclude<RebuildRejection, 'unknown'> | null): string {
  return JSON.stringify(rejection === null ? { ok: true } : { ok: false, reason: rejection });
}

/**
 * Function decodeRebuildReply
 *
 * @description
 * Decodes the answer of a consumer to one rebuild item. Only `{"ok":true}` means applied; any
 * other answer, an unknown reason or an unreadable reply included, is a rejection, so a newer
 * consumer never makes an older emitter throw on parsing.
 *
 * @param {string} reply - Reply payload.
 * @returns {RebuildRejection | null} Why the item was refused, `unknown` for a reason this kit does not know, or `null` when it was applied.
 */
export function decodeRebuildReply(reply: string): RebuildRejection | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(reply);
  } catch {
    return 'unknown';
  }
  if (typeof decoded !== 'object' || decoded === null || !('ok' in decoded)) {
    return 'unknown';
  }
  if (decoded.ok === true) {
    return null;
  }
  return 'reason' in decoded &&
    typeof decoded.reason === 'string' &&
    KNOWN_REJECTIONS.has(decoded.reason)
    ? (decoded.reason as RebuildRejection)
    : 'unknown';
}
