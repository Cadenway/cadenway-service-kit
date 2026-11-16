import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { organizationPolicy } from '../policies/organization-policy.js';

/**
 * Table `idempotency_keys`, published as `idempotencyKeys` by the `/database` entry point.
 *
 * One row per `Idempotency-Key` whose request succeeded: the fingerprint of that request and the
 * response to replay until `expires_at`. `organization_id` is null for a request without an
 * organization; the unique constraint treats nulls as equal, so such keys share one namespace.
 * The table carries the organization policy like any tenant table.
 *
 * It is a default export so that its column types stay inferred: the repository requires an
 * explicit type on every variable, and spelling the column map by hand would duplicate this
 * definition and drift from it.
 *
 * A change to this table ships a migration note for every service.
 */
export default pgTable(
  'idempotency_keys',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    organizationId: uuid('organization_id'),
    key: text('key').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseHeaders: jsonb('response_headers').$type<Record<string, string>>().notNull(),
    responseBody: jsonb('response_body').$type<unknown>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('idempotency_keys_organization_key_unique')
      .on(table.organizationId, table.key)
      .nullsNotDistinct(),
    index('idempotency_keys_expires_at_index').on(table.expiresAt),
    organizationPolicy('idempotency_keys_organization_isolation'),
  ],
);
