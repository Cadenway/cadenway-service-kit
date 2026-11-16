import type { Client, QueryResult } from 'pg';

import { inProvisioningTransaction } from '../transactions/provisioning-transaction.js';

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
