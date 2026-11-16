import { escapeIdentifier, type Client, type QueryResult } from 'pg';

import { inProvisioningTransaction } from './provisioning-transaction.js';

/**
 * Constant SHARED_JOB_TABLE
 *
 * @description
 * Table pg-boss stores the jobs of every queue that is not partitioned in. This package creates no
 * other kind of queue.
 *
 * @type {string}
 */
const SHARED_JOB_TABLE: string = 'job_common';

/**
 * Constant QUEUE_LOCK_TIMEOUT_MS
 *
 * @description
 * Time the provisioning waits for the writes in flight on the queue table before a migration, in
 * milliseconds.
 *
 * @type {number}
 */
const QUEUE_LOCK_TIMEOUT_MS: number = 30_000;

/**
 * Constant INDEX_BUILD_CLAIM
 *
 * @description
 * Column of the `version` table that pg-boss stamps to claim a pass of its index builds. The
 * runtime never stamps it: only an instance that migrates runs index builds.
 *
 * @type {string}
 */
const INDEX_BUILD_CLAIM: string = 'bam_on';

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
 * Function isInstalled
 *
 * @description
 * Tells whether pg-boss is installed in the schema: its `version` table exists. pg-boss installs
 * in one transaction, so the table is visible only once the installation committed.
 *
 * @param {Client} client - Connection of the migrator role.
 * @param {string} schema - Schema that holds the pg-boss tables.
 * @returns {Promise<boolean>} Whether the `version` table exists.
 */
export async function isInstalled(client: Client, schema: string): Promise<boolean> {
  const result: QueryResult<{ installed: boolean }> = await client.query<{ installed: boolean }>(
    'SELECT pg_catalog.to_regclass($1) IS NOT NULL AS installed',
    [`"${schema}".version`],
  );
  return result.rows[0]?.installed === true;
}

/**
 * Function readStoredVersion
 *
 * @description
 * Reads the pg-boss schema version stored in the database, before pg-boss is started.
 *
 * @param {Client} client - Connection of the migrator role.
 * @param {string} schema - Schema that holds the pg-boss tables.
 * @returns {Promise<number | null>} The stored version, or `null` when pg-boss is not installed.
 */
export async function readStoredVersion(client: Client, schema: string): Promise<number | null> {
  if (!(await isInstalled(client, schema))) {
    return null;
  }
  const stored: QueryResult<{ version: number }> = await client.query<{ version: number }>(
    `SELECT version FROM "${schema}".version`,
  );
  return stored.rows[0]?.version ?? null;
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
 * when the application role is the migrator role itself.
 * @returns {Promise<boolean>} `true` when the schema was prepared for the installation, `false` when
 * pg-boss turned out to be installed already.
 * @throws {Error} When the application role can still use the schema afterwards: it is a superuser,
 * owns the schema, or belongs to a role that keeps its privileges.
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
 * Function assertIndexBuildClaim
 *
 * @description
 * Refuses a stored schema older than the background index builds of pg-boss, which arrived with
 * schema version 27 (pg-boss 12.6). The provisioning holds those builds back through their claim
 * column; a schema without it would run them unchecked during its migration.
 *
 * @param {Client} client - Connection of the migrator role.
 * @param {string} schema - Schema that holds the pg-boss tables.
 * @param {number | null} storedVersion - Stored schema version, for the error message.
 * @returns {Promise<void>} Resolves when the claim column exists.
 * @throws {Error} When it does not; nothing was changed.
 */
export async function assertIndexBuildClaim(
  client: Client,
  schema: string,
  storedVersion: number | null,
): Promise<void> {
  const column: QueryResult = await client.query(
    `SELECT 1 FROM pg_catalog.pg_attribute
     WHERE attrelid = pg_catalog.to_regclass($1) AND attname = $2 AND NOT attisdropped`,
    [`"${schema}".version`, INDEX_BUILD_CLAIM],
  );
  if (column.rows.length === 0) {
    throw new Error(
      `Schema "${schema}" is at pg-boss version ${String(storedVersion)}, older than the background index builds of pg-boss 12.6 (schema version 27) that this package holds back during a migration: nothing was changed. Migrate it with an intermediate pg-boss release first.`,
    );
  }
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
 * stay held.
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

/**
 * Function grantStatements
 *
 * @description
 * Lists the statements that give the application role what the runtime needs and nothing more.
 *
 * The runtime reads and writes the pg-boss tables (jobs, queues, schedules, the instance registry)
 * and calls its functions; it never creates, alters or drops an object. So the role gets usage of
 * the schema, data access to its tables and execution of its functions, but not CREATE on the
 * schema, TRUNCATE, REFERENCES or TRIGGER. Two tables are then narrowed, because the migrator role
 * acts on what they hold:
 *
 * - `bam` lists the statements pg-boss runs, verbatim, as the role that migrates. The runtime never
 *   reads or writes it, so the application role keeps no right on it. With one, a compromised
 *   service could have the next provisioning run a statement of its choice as the migrator role.
 * - `version` holds the installed schema version, which decides the migrations to run, and the
 *   interval claims of the background passes. The runtime only reads it and stamps its own claims,
 *   so the role keeps SELECT and gets UPDATE on those claim columns alone: not on the version, nor
 *   on the index-build claim, which only an instance that migrates stamps.
 *
 * No default privilege is set: a table of a later pg-boss version is granted by the provisioning
 * run that creates it, after it was looked at here. Both names were validated as plain lowercase
 * identifiers and the column names are quoted.
 *
 * @param {string} schema - Schema that holds the pg-boss tables.
 * @param {string} appRole - Role the runtime connects as.
 * @param {readonly string[]} claimColumns - Claim columns of `version` the runtime stamps.
 * @returns {readonly string[]} Statements, in execution order.
 */
function grantStatements(
  schema: string,
  appRole: string,
  claimColumns: readonly string[],
): readonly string[] {
  const target: string = `SCHEMA "${schema}" TO "${appRole}"`;
  const columns: string = claimColumns
    .map((column: string): string => escapeIdentifier(column))
    .join(', ');
  return [
    `GRANT USAGE ON ${target}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN ${target}`,
    `REVOKE ALL PRIVILEGES ON TABLE "${schema}".bam FROM "${appRole}"`,
    `REVOKE INSERT, UPDATE, DELETE ON TABLE "${schema}".version FROM "${appRole}"`,
    ...(columns === ''
      ? []
      : [`GRANT UPDATE (${columns}) ON TABLE "${schema}".version TO "${appRole}"`]),
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN ${target}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN ${target}`,
  ];
}

/**
 * Function grantRuntimeAccess
 *
 * @description
 * Applies the grants in one transaction, so the application role never sees half of them: on a
 * first install it gets the usage of the schema in the same commit as the narrowing of `bam` and
 * `version`.
 *
 * @param {Client} client - Connection of the migrator role.
 * @param {string} schema - Schema that holds the pg-boss tables.
 * @param {string} appRole - Role the runtime connects as.
 * @returns {Promise<void>} Resolves once the grants are committed.
 */
export async function grantRuntimeAccess(
  client: Client,
  schema: string,
  appRole: string,
): Promise<void> {
  await inProvisioningTransaction(client, schema, async (): Promise<void> => {
    const columns: QueryResult<{ column_name: string }> = await client.query<{
      column_name: string;
    }>(
      `SELECT column_name::text AS column_name
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'version' AND column_name <> ALL ($2::text[])
       ORDER BY ordinal_position`,
      [schema, ['version', INDEX_BUILD_CLAIM]],
    );
    const claimColumns: string[] = columns.rows.map(
      (row: { column_name: string }): string => row.column_name,
    );
    for (const statement of grantStatements(schema, appRole, claimColumns)) {
      await client.query(statement);
    }
  });
}

/**
 * Function guardQueueRows
 *
 * @description
 * Makes sure no row of the queue table can steer what the migrator role is about to run.
 *
 * A pg-boss migration loops over the rows of `queue` flagged as partitioned and executes DDL built
 * from their `table_name`. The runtime needs INSERT and UPDATE on `queue`, so a compromised
 * service could plant such a row. This package never creates a partitioned queue: any row that is
 * partitioned, or that names another table than the shared one, is refused, on every run.
 *
 * When a migration is pending the check must also hold until the migration ran. The application
 * role first loses its write access to `queue`, which the grants give back at the end of the run;
 * then a lock on the table waits for the writes already in flight, and the rows are checked under
 * it. Meanwhile a running service keeps enqueuing and working jobs, which do not write to `queue`;
 * only its supervision passes and a restart fail until the run ends.
 *
 * @param {Client} client - Connection of the migrator role.
 * @param {string} schema - Schema that holds the pg-boss tables.
 * @param {string} appRole - Role the runtime connects as.
 * @param {boolean} migrationPending - Whether pg-boss is about to migrate the schema.
 * @returns {Promise<void>} Resolves when the queue table holds only rows this package creates.
 * @throws {Error} When a queue row is partitioned or names another job table.
 */
export async function guardQueueRows(
  client: Client,
  schema: string,
  appRole: string,
  migrationPending: boolean,
): Promise<void> {
  if (migrationPending) {
    await inProvisioningTransaction(client, schema, async (): Promise<void> => {
      await client.query(
        `REVOKE INSERT, UPDATE, DELETE ON TABLE "${schema}".queue FROM "${appRole}"`,
      );
    });
  }
  let foreign: string[] = [];
  await inProvisioningTransaction(client, schema, async (): Promise<void> => {
    if (migrationPending) {
      await client.query(`SET LOCAL lock_timeout = '${String(QUEUE_LOCK_TIMEOUT_MS)}ms'`);
      await client.query(`LOCK TABLE "${schema}".queue IN SHARE ROW EXCLUSIVE MODE`);
    }
    const rows: QueryResult<{ name: string }> = await client.query<{ name: string }>(
      `SELECT name FROM "${schema}".queue
       WHERE partition IS DISTINCT FROM false OR table_name IS DISTINCT FROM $1
       ORDER BY name LIMIT 10`,
      [SHARED_JOB_TABLE],
    );
    foreign = rows.rows.map((row: { name: string }): string => JSON.stringify(row.name));
  });
  if (foreign.length > 0) {
    throw new Error(
      `The queue table of schema "${schema}" holds rows this package does not create (partitioned, or on another job table): ${foreign.join(', ')}. Nothing was installed or migrated. Inspect these rows: a migration would run DDL built from them.`,
    );
  }
}
