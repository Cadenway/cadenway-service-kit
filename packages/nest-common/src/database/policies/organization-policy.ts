import { sql, type SQL } from 'drizzle-orm';
import { pgPolicy, type PgPolicy } from 'drizzle-orm/pg-core';

/**
 * Constant ORGANIZATION_SETTING
 *
 * @description
 * PostgreSQL parameter the tenant runner sets for the length of a transaction. Row-level security
 * policies compare it to `organization_id`.
 *
 * @type {string}
 */
export const ORGANIZATION_SETTING: string = 'app.organization_id';

/**
 * Constant SYSTEM_ACCESS_SETTING
 *
 * @description
 * PostgreSQL parameter the system runner sets to `on` for the length of a transaction. Policies
 * let such a transaction cross organizations.
 *
 * @type {string}
 */
export const SYSTEM_ACCESS_SETTING: string = 'app.system_access';

/**
 * Constant organizationIsolation
 *
 * @description
 * Predicate of the row-level security policy of a table with an `organization_id uuid` column: a
 * row is visible and writable when it belongs to the organization of the transaction, or when
 * the transaction was opened by the system runner. With neither parameter set, as on a
 * connection used outside the runners, no row matches.
 *
 * @type {SQL}
 */
export const organizationIsolation: SQL = sql.raw(
  `organization_id = nullif(current_setting('${ORGANIZATION_SETTING}', true), '')::uuid` +
    ` or current_setting('${SYSTEM_ACCESS_SETTING}', true) = 'on'`,
);

/**
 * Function organizationPolicy
 *
 * @description
 * Returns the row-level security policy every table with an `organization_id` declares:
 * `pgTable('tasks', { ... }, () => [organizationPolicy()])`. Drizzle enables row-level security
 * on a table that declares a policy; forcing it (`ALTER TABLE ... FORCE ROW LEVEL SECURITY`)
 * is one more statement in the migration.
 *
 * @param {string} name - Name of the policy; defaults to `organization_isolation`.
 * @returns {PgPolicy} A permissive policy for every command, applied to reads and to writes.
 */
export function organizationPolicy(name: string = 'organization_isolation'): PgPolicy {
  return pgPolicy(name, {
    as: 'permissive',
    for: 'all',
    using: organizationIsolation,
    withCheck: organizationIsolation,
  });
}
