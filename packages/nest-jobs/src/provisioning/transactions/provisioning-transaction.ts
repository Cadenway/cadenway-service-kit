import { Logger } from '@nestjs/common';

import { describeError } from '../../jobs/diagnostics/describe-error.js';

/**
 * Constant logger
 *
 * @description
 * Logger of the provisioning run. Works outside a NestJS application, as in a migration script.
 *
 * @type {Logger}
 */
const logger: Logger = new Logger('JobsProvisioning');

/**
 * Interface ProvisioningClient
 *
 * @description
 * The part of a database connection the provisioning transactions use. A `pg` client satisfies it.
 */
export interface ProvisioningClient {
  // #region Methods
  /**
   * Method query
   *
   * @description
   * Runs one statement on the connection.
   *
   * @param {string} text - SQL text.
   * @param {unknown[]} [values] - Values bound to the placeholders.
   * @returns {Promise<unknown>} The result of the statement, unused here.
   */
  query(text: string, values?: unknown[]): Promise<unknown>;
  // #endregion
}

/**
 * Function rollbackQuietly
 *
 * @description
 * Rolls a transaction back after a failure. A rollback that fails too, on a lost connection for
 * example, is logged instead of thrown, so it never replaces the error that caused it.
 *
 * @param {ProvisioningClient} client - Connection of the migrator role, inside a transaction.
 * @returns {Promise<void>} Resolves once the rollback was attempted.
 */
async function rollbackQuietly(client: ProvisioningClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch (error) {
    logger.error(`The provisioning transaction did not roll back: ${describeError(error)}`);
  }
}

/**
 * Function inProvisioningTransaction
 *
 * @description
 * Runs statements in one transaction that holds the provisioning lock of the schema, a
 * transaction-level advisory lock: two migration containers started together run these sections
 * one after the other instead of failing on each other's catalog updates. The lock is released by
 * the commit or the rollback.
 *
 * @param {ProvisioningClient} client - Connection of the migrator role.
 * @param {string} schema - Schema that holds the pg-boss tables.
 * @param {() => Promise<void>} work - Statements to run inside the transaction.
 * @returns {Promise<void>} Resolves once the transaction is committed.
 * @throws {unknown} What the lock, the work or the commit threw, after a rollback was attempted.
 */
export async function inProvisioningTransaction(
  client: ProvisioningClient,
  schema: string,
  work: () => Promise<void>,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(
      'SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))',
      [`cadenway.nest-jobs.provision.${schema}`],
    );
    await work();
    await client.query('COMMIT');
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
}
