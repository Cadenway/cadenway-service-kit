import { escapeIdentifier, type Client, type QueryResult } from 'pg';

import { inProvisioningTransaction } from '../transactions/provisioning-transaction.js';
import { INDEX_BUILD_CLAIM } from './schema-inspection.js';

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
