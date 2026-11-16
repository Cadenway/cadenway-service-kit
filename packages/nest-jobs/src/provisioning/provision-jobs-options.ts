import type { JobsConnectionOptions } from '../jobs/database/jobs-connection.js';
import type { JobQueueDeclaration } from '../jobs/queues/job-queue.js';

/**
 * Interface ProvisionJobsOptions
 *
 * @description
 * Options of one provisioning run. `connection`, `queues` and `appRole` are required.
 */
export interface ProvisionJobsOptions {
  // #region Properties
  /**
   * Property connection
   *
   * @description
   * Connection of the migrator role. The role must be allowed to create the schema, or own it when
   * it already exists, and to create objects in it.
   *
   * @type {JobsConnectionOptions}
   * @readonly
   */
  readonly connection: JobsConnectionOptions;

  /**
   * Property queues
   *
   * @description
   * The queues of the service, the same list given to `JobsModule`. Each is created, or updated to
   * match its declaration, with its dead-letter queue. A queue removed from the list is left in
   * place.
   *
   * @type {readonly JobQueueDeclaration[]}
   * @readonly
   */
  readonly queues: readonly JobQueueDeclaration[];

  /**
   * Property appRole
   *
   * @description
   * Existing role the runtime connects as: lowercase letters, digits and underscores. It is granted
   * usage of the schema and data access to its tables, never DDL rights.
   *
   * @type {string}
   * @readonly
   */
  readonly appRole: string;

  /**
   * Property schema
   *
   * @description
   * PostgreSQL schema that holds the pg-boss tables: lowercase letters, digits and underscores.
   * Defaults to `pgboss`.
   *
   * @type {string}
   * @readonly
   */
  readonly schema?: string;

  /**
   * Property migrationTimeoutMs
   *
   * @description
   * Time the index builds of a pg-boss schema migration get to finish, in milliseconds. Past it the
   * run fails and can be started again. Defaults to 600000 (10 minutes).
   *
   * @type {number}
   * @readonly
   */
  readonly migrationTimeoutMs?: number;
  // #endregion
}
