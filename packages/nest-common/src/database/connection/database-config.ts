import { z } from 'zod';

import type { ConfigShape } from '../../config/base-config.js';

/**
 * Interface DatabaseConfig
 *
 * @description
 * Variable of a service with a database, as validated by `databaseConfigShape`.
 */
export interface DatabaseConfig {
  // #region Properties
  /**
   * Property DATABASE_URL
   *
   * @description
   * Connection string of the service's own database, for the application role. A secret.
   *
   * @type {string}
   * @readonly
   */
  readonly DATABASE_URL: string;

  /**
   * Property DATABASE_TRANSACTION_MAX_ATTEMPTS
   *
   * @description
   * Maximum total attempts for an owning transaction, defaulting to 3.
   *
   * @type {number}
   * @readonly
   */
  readonly DATABASE_TRANSACTION_MAX_ATTEMPTS: number;
  // #endregion
}

/**
 * Constant databaseConfigShape
 *
 * @description
 * Zod shape of `DATABASE_URL`, a `postgres://` or `postgresql://` URL. Spread it into the
 * application schema.
 *
 * @type {ConfigShape<DatabaseConfig>}
 */
export const databaseConfigShape: ConfigShape<DatabaseConfig> = {
  DATABASE_TRANSACTION_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/u }),
};
