import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/**
 * Type DatabaseSchema
 *
 * @description
 * Drizzle schema of a service, with its tables and relations by export name.
 *
 * @type {Record<string, unknown>}
 */
export type DatabaseSchema = Record<string, unknown>;

/**
 * Type TransactionDatabase
 *
 * @description
 * Query builders bound to one transaction. The runner owns transaction control.
 *
 * @type {Omit<NodePgDatabase<TSchema>, 'transaction'>}
 */
export type TransactionDatabase<TSchema extends DatabaseSchema = Record<string, never>> = Omit<
  NodePgDatabase<TSchema>,
  'transaction'
>;

/**
 * Type TransactionKind
 *
 * @description
 * Access scope of the runner that opened a transaction.
 *
 * @type {'tenant' | 'system'}
 */
export type TransactionKind = 'tenant' | 'system';

/**
 * Interface TransactionClient
 *
 * @description
 * Raw SQL access to the connection of a transaction, for libraries such as the job queue.
 */
export interface TransactionClient {
  // #region Methods
  /**
   * Method query
   *
   * @description
   * Runs a parameterized statement inside the transaction.
   *
   * @param {string} text - Parameterized SQL statement to run in the active transaction.
   * @param {unknown[] | undefined} values - Values bound to the statement parameters.
   * @returns {Promise<{ rows: unknown[]; }>} Rows from the statement on the current transaction connection.
   */
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  // #endregion
}

/**
 * Interface TransactionScope
 *
 * @description
 * Connection-bound dependencies for the callback of a live transaction.
 */
export interface TransactionScope<TSchema extends DatabaseSchema = Record<string, never>> {
  // #region Properties
  /**
   * Property db
   *
   * @description
   * Drizzle query builders bound to this transaction.
   *
   * @type {TransactionDatabase<TSchema>}
   * @readonly
   */
  readonly db: TransactionDatabase<TSchema>;

  /**
   * Property client
   *
   * @description
   * Raw SQL access to the same connection.
   *
   * @type {TransactionClient}
   * @readonly
   */
  readonly client: TransactionClient;

  /**
   * Property kind
   *
   * @description
   * Runner that opened the transaction.
   *
   * @type {TransactionKind}
   * @readonly
   */
  readonly kind: TransactionKind;

  /**
   * Property organizationId
   *
   * @description
   * Organization of a tenant transaction, or `null` for a system transaction.
   *
   * @type {string | null}
   * @readonly
   */
  readonly organizationId: string | null;
  // #endregion
}

/**
 * Interface TransactionOptions
 *
 * @description
 * Isolation and access requirements for a new or joined transaction.
 */
export interface TransactionOptions {
  // #region Properties
  /**
   * Property isolationLevel
   *
   * @description
   * Defaults to the PostgreSQL default isolation level.
   *
   * @type {'read committed' | 'repeatable read' | 'serializable' | undefined}
   * @readonly
   */
  readonly isolationLevel?: 'read committed' | 'repeatable read' | 'serializable';

  /**
   * Property readOnly
   *
   * @description
   * Requires a read-only transaction when set.
   *
   * @type {boolean | undefined}
   * @readonly
   */
  readonly readOnly?: boolean;

  /**
   * Property maxAttempts
   *
   * @description
   * Maximum total attempts for an owning transaction; 1 disables retries. Nested calls use the outer policy.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly maxAttempts?: number;
  // #endregion
}
