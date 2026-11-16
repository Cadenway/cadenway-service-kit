import type { Client, QueryResult } from 'pg';

/**
 * Constant INDEX_BUILD_CLAIM
 *
 * @description
 * Column of the `version` table that pg-boss stamps to claim a pass of its index builds. The
 * runtime never stamps it: only an instance that migrates runs index builds.
 *
 * @type {string}
 */
export const INDEX_BUILD_CLAIM: string = 'bam_on';

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
