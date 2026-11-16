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

/** Values persisted for replay in the same transaction as the request. */
type ResponseRecord = Pick<
  typeof idempotencyKeys.$inferSelect,
  'requestFingerprint' | 'responseStatus' | 'responseHeaders' | 'responseBody'
>;

/** A stored response and its expiration in the current PostgreSQL transaction. */
export type StoredResponse = Omit<ResponseRecord, 'responseStatus'> & { readonly expired: boolean };

/** Attempts a lock for the organization's key until this transaction ends. */
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

/** Reads the response in the transaction that owns the key's advisory lock. */
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

/** Stores the fresh response or overwrites the expired one while holding the key's lock. */
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
