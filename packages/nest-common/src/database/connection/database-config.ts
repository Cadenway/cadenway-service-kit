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
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/u }),
};
