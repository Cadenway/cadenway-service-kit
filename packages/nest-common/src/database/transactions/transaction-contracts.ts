import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** Drizzle schema of a service, with its tables and relations by export name. */
export type DatabaseSchema = Record<string, unknown>;

/** Query builders bound to one transaction. The runner owns transaction control. */
export type TransactionDatabase<TSchema extends DatabaseSchema = Record<string, never>> = Omit<
  NodePgDatabase<TSchema>,
  'transaction'
>;

/** Access scope of the runner that opened a transaction. */
export type TransactionKind = 'tenant' | 'system';

/** Raw SQL access to the connection of a transaction, for libraries such as the job queue. */
export interface TransactionClient {
  // #region Methods
  /** Runs a parameterized statement inside the transaction. */
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  // #endregion
}

/** Connection-bound dependencies for the callback of a live transaction. */
export interface TransactionScope<TSchema extends DatabaseSchema = Record<string, never>> {
  // #region Properties
  /** Drizzle query builders bound to this transaction. */
  readonly db: TransactionDatabase<TSchema>;

  /** Raw SQL access to the same connection. */
  readonly client: TransactionClient;

  /** Runner that opened the transaction. */
  readonly kind: TransactionKind;

  /** Organization of a tenant transaction, or `null` for a system transaction. */
  readonly organizationId: string | null;
  // #endregion
}

/** Isolation and access requirements for a new or joined transaction. */
export interface TransactionOptions {
  // #region Properties
  /** Defaults to the PostgreSQL default isolation level. */
  readonly isolationLevel?: 'read committed' | 'repeatable read' | 'serializable';

  /** Requires a read-only transaction when set. */
  readonly readOnly?: boolean;
  // #endregion
}
