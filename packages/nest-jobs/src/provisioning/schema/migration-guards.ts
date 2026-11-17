import type { Client, QueryResult } from 'pg';

import { inProvisioningTransaction } from '../transactions/provisioning-transaction.js';
import { INDEX_BUILD_CLAIM, isInstalled } from './schema-inspection.js';

/**
 * Constant INDEX_BUILD_HOLD
 *
 * @description
 * How far ahead the provisioning stamps the index-build claim to hold the index builds back. pg-boss
 * only runs them once the claim is older than its interval, so a claim in the future holds them
 * until it is cleared, or for a day after a run that stopped before clearing it.
 *
 * @type {string}
 */
const INDEX_BUILD_HOLD: string = "interval '1 day'";

/**
 * Constant ANY_TABLE_PRIVILEGE
 *
 * @description
 * Every privilege a table can carry. Nobody but its owner may hold one on `bam`.
 *
 * @type {readonly string[]}
 */
const ANY_TABLE_PRIVILEGE: readonly string[] = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
];

/**
 * Constant TABLE_WRITE_PRIVILEGES
 *
 * @description
 * The privileges of a table, the column grants left aside, that change its rows or its shape.
 * Nobody but its owner may hold one on `version`.
 *
 * @type {readonly string[]}
 */
const TABLE_WRITE_PRIVILEGES: readonly string[] = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
];

/**
 * Interface InputGrant
 *
 * @description
 * One role that holds a privilege on a table whose content the migrator role acts on.
 */
interface InputGrant {
  // #region Properties
  /**
   * Property relation
   *
   * @description
   * Table the privilege is on: `bam` or `version`.
   *
   * @type {string}
   * @readonly
   */
  readonly relation: string;

  /**
   * Property name
   *
   * @description
   * Role holding the privilege, as an identifier quoted by the server, or `PUBLIC`.
   *
   * @type {string}
   * @readonly
   */
  readonly name: string;

  /**
   * Property reachable
   *
   * @description
   * Whether the role can use the schema, so the privilege can actually be exercised.
   *
   * @type {boolean}
   * @readonly
   */
  readonly reachable: boolean;
  // #endregion
}

/**
 * Function closeSchemaForInstall
 *
 * @description
 * Prepares a schema pg-boss is not installed in yet, so the installation happens with no role but
 * the migrator able to reach it.
 *
 * A platform may give the application role default privileges on everything the migrator role
 * creates: with them, a schema pg-boss created would be usable by the application role at once,
 * and so would `bam`, the table whose rows pg-boss executes as the migrator role, while the
 * installation runs. So the provisioning creates the schema itself, when it does not exist, and in
 * the same transaction revokes every privilege on it from every role but its owner and the migrator
 * role. pg-boss then installs in a schema the application role cannot use; the final grants give
 * it its access. The default privileges still apply to the tables pg-boss creates, but a table is
 * out of reach without the usage of its schema.
 *
 * It runs under the provisioning lock and does nothing when pg-boss was installed in the meantime,
 * by a run started together with this one.
 *
 * @param {Client} client - Connection of the migrator role.
 * @param {string} schema - Schema that holds the pg-boss tables.
 * @param {string} appRole - Role the runtime connects as.
 * @param {boolean} managed - Whether the access of the application role is managed, which it is not
 *   when the application role is the migrator role itself.
 * @returns {Promise<boolean>} `true` when the schema was prepared for the installation, `false` when
 *   pg-boss turned out to be installed already.
 * @throws {Error} When the application role can still use the schema afterwards: it is a superuser,
 *   owns the schema, or belongs to a role that keeps its privileges.
 */
export async function closeSchemaForInstall(
  client: Client,
  schema: string,
  appRole: string,
  managed: boolean,
): Promise<boolean> {
  let prepared: boolean = false;
  await inProvisioningTransaction(client, schema, async (): Promise<void> => {
    if (await isInstalled(client, schema)) {
      return;
    }
    const existing: QueryResult = await client.query(
      'SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1',
      [schema],
    );
    if (existing.rows.length === 0) {
      // Checked first rather than IF NOT EXISTS: PostgreSQL checks the CREATE right on the database
      // before it looks for the schema, and a migrator that only owns a schema created for it has
      // no such right.
      await client.query(`CREATE SCHEMA "${schema}"`);
    }
    prepared = true;
    if (!managed) {
      return;
    }
    const grantees: QueryResult<{ name: string }> = await client.query<{ name: string }>(
      `SELECT DISTINCT
         CASE WHEN a.grantee = 0 THEN 'PUBLIC'
              ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END AS name
       FROM pg_catalog.pg_namespace n
       CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) a
       WHERE n.nspname = $1
         AND a.grantee <> n.nspowner
         AND a.grantee NOT IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)`,
      [schema],
    );
    for (const grantee of grantees.rows) {
      await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA "${schema}" FROM ${grantee.name}`);
    }
    await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA "${schema}" FROM "${appRole}"`);
    const usage: QueryResult<{ usage: boolean }> = await client.query<{ usage: boolean }>(
      "SELECT pg_catalog.has_schema_privilege($1, $2, 'USAGE') AS usage",
      [appRole, schema],
    );
    if (usage.rows[0]?.usage === true) {
      throw new Error(
        `Role "${appRole}" can still use schema "${schema}" after every privilege on it was revoked: it is a superuser, owns the schema, or belongs to a role that keeps its privileges. Nothing was installed. Give the application role privileges of its own only.`,
      );
    }
  });
  return prepared;
}

/**
 * Function narrowMigratorInputs
 *
 * @description
 * Makes sure no role but the owner and the migrator role can write what the migrator role acts on:
 * the rows of `bam`, which pg-boss executes verbatim, and the stored version and index-build claim
 * of `version`. Column grants on `version`, which the runtime uses for its claims, are left alone.
 *
 * A role holding such a privilege without the usage of the schema could not have used it, so the
 * privilege is revoked and the run goes on: this is the state right after a first install, where
 * the platform default privileges reached the new tables of a closed schema. A role holding one
 * with the usage of the schema could have planted rows: the run stops, fails closed, revokes
 * nothing and leaves the index builds held, so an operator inspects `bam` first. Run it inside a
 * provisioning transaction.
 *
 * @param {Client} client - Connection of the migrator role, inside a transaction.
 * @param {string} schema - Schema that holds the pg-boss tables.
 * @returns {Promise<void>} Resolves once no role but the owner can write these tables.
 * @throws {Error} When a role that can use the schema holds such a privilege.
 */
async function narrowMigratorInputs(client: Client, schema: string): Promise<void> {
  const result: QueryResult<InputGrant> = await client.query<InputGrant>(
    `WITH targets (relation, privileges) AS (
       VALUES ('bam', $2::text[]), ('version', $3::text[])
     )
     SELECT DISTINCT t.relation,
       CASE WHEN a.grantee = 0 THEN 'PUBLIC'
            ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END AS name,
       CASE WHEN a.grantee = 0
            THEN EXISTS (
              SELECT 1 FROM pg_catalog.pg_namespace n
              CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) s
              WHERE n.nspname = $1 AND s.grantee = 0 AND s.privilege_type = 'USAGE')
            ELSE pg_catalog.has_schema_privilege(a.grantee, $1, 'USAGE') END AS reachable
     FROM targets t
     JOIN pg_catalog.pg_class c
       ON c.oid = pg_catalog.to_regclass(pg_catalog.quote_ident($1) || '.' || t.relation)
     CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
     WHERE a.grantee <> c.relowner
       AND a.grantee NOT IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
       AND a.privilege_type = ANY (t.privileges)
     ORDER BY 1, 2`,
    [schema, ANY_TABLE_PRIVILEGE, TABLE_WRITE_PRIVILEGES],
  );
  const reachable: InputGrant[] = result.rows.filter(
    (grant: InputGrant): boolean => grant.reachable,
  );
  if (reachable.length > 0) {
    const holders: string = reachable
      .map((grant: InputGrant): string => `${grant.name} on ${grant.relation}`)
      .join(', ');
    throw new Error(
      `Roles that can use schema "${schema}" hold privileges on the tables the migrator role acts on (${holders}): pg-boss executes the rows of bam and migrates from the version stored in version. Nothing was executed and nothing was revoked; the index builds stay held. Revoke these privileges, check that every pending row of "${schema}".bam is an index build of pg-boss, then run provisionJobs again.`,
    );
  }
  for (const grant of result.rows) {
    await client.query(
      grant.relation === 'bam'
        ? `REVOKE ALL PRIVILEGES ON TABLE "${schema}".bam FROM ${grant.name}`
        : `REVOKE ${TABLE_WRITE_PRIVILEGES.join(', ')} ON TABLE "${schema}".version FROM ${grant.name}`,
    );
  }
}

/**
 * Function holdIndexBuilds
 *
 * @description
 * Holds the index builds of pg-boss back before an installed schema is migrated, so none runs
 * before the tables they come from were checked again.
 *
 * pg-boss runs the rows of `bam` as soon as its instance that migrates has started, and a
 * migration can create tables, `bam` included, which the platform default privileges then open to
 * the application role while the runtime may be live. Checking after the start would race the
 * first pass of the builds. Instead, in one transaction under the provisioning lock, this takes the
 * index-build claim away from the application role, checks `bam` and `version` once, and stamps the
 * claim in the future: pg-boss cannot start a pass until `closeMigratorInputs` checked again and
 * cleared it.
 *
 * @param {Client} client - Connection of the migrator role.
 * @param {string} schema - Schema that holds the pg-boss tables.
 * @param {string} appRole - Role the runtime connects as.
 * @returns {Promise<void>} Resolves once the builds are held.
 * @throws {Error} When a role that can use the schema can write `bam` or `version`.
 */
export async function holdIndexBuilds(
  client: Client,
  schema: string,
  appRole: string,
): Promise<void> {
  await inProvisioningTransaction(client, schema, async (): Promise<void> => {
    await client.query(
      `REVOKE UPDATE (${INDEX_BUILD_CLAIM}) ON TABLE "${schema}".version FROM "${appRole}"`,
    );
    await narrowMigratorInputs(client, schema);
    await client.query(
      `UPDATE "${schema}".version SET ${INDEX_BUILD_CLAIM} = pg_catalog.now() + ${INDEX_BUILD_HOLD}`,
    );
  });
}

/**
 * Function closeMigratorInputs
 *
 * @description
 * Checks `bam` and `version` again once pg-boss has installed or migrated the schema, before any
 * index build runs, and releases the builds that `holdIndexBuilds` held back. The release happens in
 * the same transaction as the check, so a build can only start after a check that passed.
 *
 * @param {Client} client - Connection of the migrator role.
 * @param {string} schema - Schema that holds the pg-boss tables.
 * @param {boolean} release - Whether the builds were held and must be released.
 * @returns {Promise<void>} Resolves once the tables are closed and the builds released.
 * @throws {Error} When a role that can use the schema can write `bam` or `version`; the builds then
 *   stay held.
 */
export async function closeMigratorInputs(
  client: Client,
  schema: string,
  release: boolean,
): Promise<void> {
  await inProvisioningTransaction(client, schema, async (): Promise<void> => {
    await narrowMigratorInputs(client, schema);
    if (release) {
      await client.query(`UPDATE "${schema}".version SET ${INDEX_BUILD_CLAIM} = NULL`);
    }
  });
}
