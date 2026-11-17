import type { ConstructorOptions } from 'pg-boss';

import type { ResolvedJobsRuntimeOptions } from '../../jobs/configuration/jobs-runtime-options.js';

/**
 * Function toRuntimeBossOptions
 *
 * @description
 * Configures application-role pg-boss without DDL or persistent diagnostics.
 * Only scheduler processes supervise jobs and run cron.
 *
 * @param {ResolvedJobsRuntimeOptions} options - Resolved module options.
 * @returns {ConstructorOptions} Options for the pg-boss constructor.
 */
export function toRuntimeBossOptions(options: ResolvedJobsRuntimeOptions): ConstructorOptions {
  const scheduler: boolean = options.capabilities.has('scheduler');
  return {
    ...options.connection,
    schema: options.schema,
    max: options.poolSize,
    migrate: false,
    createSchema: false,
    supervise: scheduler,
    schedule: scheduler,
    reindex: false,
    persistQueueStats: false,
    persistWarnings: false,
  };
}
