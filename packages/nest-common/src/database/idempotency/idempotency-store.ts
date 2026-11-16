import { and, eq, isNull, sql } from 'drizzle-orm';

import type { DatabaseSchema, TransactionScope } from '../transactions/transaction-contracts.js';
import idempotencyKeys from './idempotency.schema.js';

/**
 * Constant IDEMPOTENCY_RETENTION_HOURS
 *
 * @description
 * How long a stored response is replayed, in hours.
 *
 * @type {number}
 */
export const IDEMPOTENCY_RETENTION_HOURS: number = 24;

/**
 * Type ResponseRecord
 *
 * @description
 * Values persisted for replay in the same transaction as the request.
 *
 * @type {Pick<typeof idempotencyKeys.$inferSelect, 'requestFingerprint' | 'responseStatus' | 'responseHeaders' | 'responseBody'>}
 */
type ResponseRecord = Pick<
  typeof idempotencyKeys.$inferSelect,
  'requestFingerprint' | 'responseStatus' | 'responseHeaders' | 'responseBody'
>;

/**
 * Type StoredResponse
 *
 * @description
 * A stored response and its expiration in the current PostgreSQL transaction.
 *
 * @type {Omit<ResponseRecord, 'responseStatus'> & { readonly expired: boolean; }}
 */
export type StoredResponse = Omit<ResponseRecord, 'responseStatus'> & { readonly expired: boolean };

/**
 * Function lockIdempotencyKey
 *
 * @description
 * Attempts a lock for the organization's key until this transaction ends.
 *
 * @param {TransactionScope<DatabaseSchema>} scope - Live scope bound to the current PostgreSQL transaction.
 * @param {string | null} organizationId - Organization whose data is scoped, or null for system work.
 * @param {string} key - Idempotency key supplied for this request.
 * @returns {Promise<boolean>} True if this transaction acquired the lock without waiting.
 */
export async function lockIdempotencyKey(
  scope: TransactionScope<DatabaseSchema>,
  organizationId: string | null,
  key: string,
): Promise<boolean> {
  const { rows }: { rows: unknown[] } = await scope.client.query(
    'select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as acquired',
    [`cadenway.idempotency:${organizationId ?? ''}:${key}`],
  );
  return (rows[0] as { acquired?: unknown } | undefined)?.acquired === true;
}

/**
 * Function readStoredResponse
 *
 * @description
 * Reads the response in the transaction that owns the key's advisory lock.
 *
 * @param {TransactionScope<DatabaseSchema>} scope - Live scope bound to the current PostgreSQL transaction.
 * @param {string | null} organizationId - Organization whose data is scoped, or null for system work.
 * @param {string} key - Idempotency key supplied for this request.
 * @returns {Promise<StoredResponse | undefined>} The stored response with its expiration flag, or undefined when no response exists.
 */
export async function readStoredResponse(
  scope: TransactionScope<DatabaseSchema>,
  organizationId: string | null,
  key: string,
): Promise<StoredResponse | undefined> {
  const [record]: StoredResponse[] = await scope.db
    .select({
      requestFingerprint: idempotencyKeys.requestFingerprint,
      responseHeaders: idempotencyKeys.responseHeaders,
      responseBody: idempotencyKeys.responseBody,
      expired: sql<boolean>`${idempotencyKeys.expiresAt} <= now()`,
    })
    .from(idempotencyKeys)
    .where(
      and(
        organizationId === null
          ? isNull(idempotencyKeys.organizationId)
          : eq(idempotencyKeys.organizationId, organizationId),
        eq(idempotencyKeys.key, key),
      ),
    );
  return record;
}

/**
 * Function storeResponse
 *
 * @description
 * Stores the fresh response or overwrites the expired one while holding the key's lock.
 *
 * @param {TransactionScope<DatabaseSchema>} scope - Live scope bound to the current PostgreSQL transaction.
 * @param {string | null} organizationId - Organization whose data is scoped, or null for system work.
 * @param {string} key - Idempotency key supplied for this request.
 * @param {ResponseRecord} response - Fresh response and request fingerprint to persist for replay.
 * @returns {Promise<void>} Resolves after the response has been written to the current transaction.
 */
export async function storeResponse(
  scope: TransactionScope<DatabaseSchema>,
  organizationId: string | null,
  key: string,
  response: ResponseRecord,
): Promise<void> {
  const record: ResponseRecord & { expiresAt: ReturnType<typeof sql<Date>> } = {
    ...response,
    expiresAt: sql<Date>`now() + make_interval(hours => ${IDEMPOTENCY_RETENTION_HOURS})`,
  };
  await scope.db
    .insert(idempotencyKeys)
    .values({ organizationId, key, ...record })
    .onConflictDoUpdate({
      target: [idempotencyKeys.organizationId, idempotencyKeys.key],
      set: { ...record, createdAt: sql`now()` },
    });
}
