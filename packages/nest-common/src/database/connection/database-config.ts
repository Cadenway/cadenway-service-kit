import { z } from 'zod';

import type { ConfigShape } from '../../config/base-config.js';

/**
 * Interface DatabaseConfig
 *
 * @description
 * Database settings of a service. `databaseConfigShape` fills the retry limit when parsing.
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
   * Maximum total attempts for an owning transaction. Schema-validated configuration fills
   * the default of 3. Manually supplied configuration may leave the option unset.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly DATABASE_TRANSACTION_MAX_ATTEMPTS?: number;
  // #endregion
}

/**
 * Constant databaseConfigShape
 *
 * @description
 * Zod shape of the PostgreSQL URL and the defaulted total transaction attempt limit. Spread it
 * into the application schema.
 *
 * @type {ConfigShape<DatabaseConfig>}
 */
export const databaseConfigShape: ConfigShape<DatabaseConfig> = {
  DATABASE_TRANSACTION_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/u }),
};
