import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import type { DatabaseSchema } from './transaction-contracts.js';

/**
 * Constant CLOSED_SCOPE_MESSAGE
 *
 * @description
 * Error returned by database operations once their transaction scope has closed.
 *
 * @type {string}
 */
export const CLOSED_SCOPE_MESSAGE: string =
  'This transaction is over: its scope cannot be used any more. Do not keep a scope after its work returns.';

/**
 * Function createTransactionDatabase
 *
 * @description
 * Binds Drizzle to one transaction scope. A later borrower of the physical connection
 * has a different scope and therefore cannot reactivate this adapter.
 *
 * @param {PoolClient} connection - Checked-out PostgreSQL connection.
 * @param {TSchema | undefined} schema - Drizzle schema of the service.
 * @param {() => boolean} isOpen - Whether this scope still accepts queries.
 * @returns {NodePgDatabase<TSchema>} A database that rejects nested Drizzle transactions.
 */
export function createTransactionDatabase<TSchema extends DatabaseSchema>(
  connection: PoolClient,
  schema: TSchema | undefined,
  isOpen: () => boolean,
): NodePgDatabase<TSchema> {
  const guarded = {
    query: (...parameters: unknown[]): Promise<unknown> =>
      isOpen()
        ? (connection.query as (...forwarded: unknown[]) => Promise<unknown>)(...parameters)
        : Promise.reject(new Error(CLOSED_SCOPE_MESSAGE)),
  };
  // Drizzle only uses query() on its node-postgres client.
  const client: PoolClient = guarded as unknown as PoolClient;
  const db: NodePgDatabase<TSchema> =
    schema === undefined ? drizzle<TSchema, PoolClient>(client) : drizzle(client, { schema });
  Object.defineProperty(db, 'transaction', {
    value: (): Promise<never> =>
      Promise.reject(
        new Error('Nested Drizzle transactions are not available: use the transaction runner.'),
      ),
  });
  return db;
}
