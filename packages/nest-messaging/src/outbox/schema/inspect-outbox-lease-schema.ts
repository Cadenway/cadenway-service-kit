import type { TransactionClient } from '@cadenway/nest-common/database';

/**
 * Type IndexState
 *
 * @description
 * Whether the named expiry index is absent, matches and is invalid, matches and is ready, or differs from the required definition.
 *
 * @type {'missing' | 'divergent' | 'invalid' | 'valid'}
 */
type IndexState = 'missing' | 'divergent' | 'invalid' | 'valid';

/**
 * Interface LeaseSchemaState
 *
 * @description
 * Catalog state used to admit the relay and safely repair an interrupted index build.
 */
interface LeaseSchemaState {
  // #region Properties
  /**
   * Property index_state
   *
   * @description
   * Only the expected index can be repaired when invalid.
   *
   * @type {IndexState}
   * @readonly
   */
  readonly index_state: IndexState;

  /**
   * Property checks_valid
   *
   * @description
   * Both required check constraints are installed and validated.
   *
   * @type {boolean}
   * @readonly
   */
  readonly checks_valid: boolean;
  // #endregion
}

/**
 * Function inspectOutboxLeaseSchema
 *
 * @description
 * Reads the lease constraints and expiry index for the given outbox relation.
 *
 * @param {TransactionClient} client - Connection used to read the PostgreSQL catalog.
 * @param {string} relation - Outbox table name resolved with the caller’s search path unless schema-qualified.
 * @returns {Promise<LeaseSchemaState | undefined>} Index and constraint state, or undefined if the relation is absent.
 */
export async function inspectOutboxLeaseSchema(
  client: TransactionClient,
  relation: string,
): Promise<LeaseSchemaState | undefined> {
  const { rows }: { rows: unknown[] } = await client.query(
    `select case
       when index_name.oid is null then 'missing'
       when (
         expiry.indrelid = outbox.oid
         and access_method.amname = 'btree'
         and not expiry.indisunique
         and expiry.indnkeyatts = 2 and expiry.indnatts = 2
         and expiry.indoption[0] = 0 and expiry.indoption[1] = 0
         and pg_get_indexdef(expiry.indexrelid, 1, false) = 'lease_expires_at'
         and pg_get_indexdef(expiry.indexrelid, 2, false) = 'id'
         and pg_get_expr(expiry.indpred, expiry.indrelid) = '(status = ''leased''::text)'
       ) is not true then 'divergent'
       when expiry.indisvalid and expiry.indisready then 'valid'
       else 'invalid'
     end as index_state,
     (select count(*) = 2 from pg_catalog.pg_constraint as checks
        where checks.conrelid = outbox.oid and checks.contype = 'c' and checks.convalidated
          and checks.conname in ('outbox_events_status_check', 'outbox_events_lease_check'))
       as checks_valid
     from pg_catalog.pg_class as outbox
     left join pg_catalog.pg_class as index_name
       on index_name.relnamespace = outbox.relnamespace
       and index_name.relname = 'outbox_events_lease_expiry_index'
     left join pg_catalog.pg_index as expiry on expiry.indexrelid = index_name.oid
     left join pg_catalog.pg_am as access_method on access_method.oid = index_name.relam
     where outbox.oid = to_regclass($1)`,
    [relation],
  );
  return rows[0] as LeaseSchemaState | undefined;
}
