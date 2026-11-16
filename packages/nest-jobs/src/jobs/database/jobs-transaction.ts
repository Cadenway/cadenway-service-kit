/**
 * Interface JobsQueryResult
 *
 * @description
 * The part of a query result this package reads: the returned rows.
 */
export interface JobsQueryResult {
  // #region Properties
  /**
   * Property rows
   *
   * @description
   * Rows returned by the statement.
   *
   * @type {unknown[]}
   */
  rows: unknown[];
  // #endregion
}

/**
 * Interface JobsTransactionClient
 *
 * @description
 * A database client bound to an open transaction. A `pg` client satisfies it; the interface is
 * structural so this package depends on no particular driver wrapper.
 */
export interface JobsTransactionClient {
  // #region Methods
  /**
   * Method query
   *
   * @description
   * Runs one parameterized statement on the connection that holds the transaction.
   *
   * @param {string} text - SQL text with `$1`-style placeholders.
   * @param {unknown[]} [values] - Values bound to the placeholders.
   * @returns {Promise<JobsQueryResult>} The rows returned by the statement.
   */
  query(text: string, values?: unknown[]): Promise<JobsQueryResult>;
  // #endregion
}

/**
 * Interface JobsTransaction
 *
 * @description
 * The transaction scope of a use case, as `@cadenway/nest-common` hands it to use cases: a client
 * inside an open transaction and the organization the use case runs for. Declared structurally so
 * this package does not depend on `@cadenway/nest-common`.
 */
export interface JobsTransaction {
  // #region Properties
  /**
   * Property client
   *
   * @description
   * Client inside the open transaction. The job row is inserted through it, so the job commits or
   * rolls back with the data of the use case.
   *
   * @type {JobsTransactionClient}
   * @readonly
   */
  readonly client: JobsTransactionClient;

  /**
   * Property organizationId
   *
   * @description
   * Organization the use case runs for, or `null` outside any organization. Stored with the job
   * and given back to the handler.
   *
   * @type {string | null}
   * @readonly
   */
  readonly organizationId: string | null;
  // #endregion
}
