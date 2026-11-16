import type { ConstructorOptions } from 'pg-boss';

import { JOBS_POOL_SIZE } from '../../jobs/database/jobs-connection.js';
import { type ResolvedJobsModuleOptions } from '../../jobs/configuration/jobs-options.js';
import type { ResolvedJobsRuntimeOptions } from '../../jobs/configuration/jobs-runtime-options.js';

/**
 * Function toRuntimeBossOptions
 *
 * @description
 * Builds the pg-boss options of the runtime, the application role.
 *
 * The runtime never runs DDL: `migrate` and `createSchema` are off, so start-up only checks the
 * installed schema version, and `reindex` is off because rebuilding an index needs its ownership.
 * Queue statistics and warnings are not persisted, which keeps maintenance to plain DML. The fixed
 * values are written after the connection so a connection object cannot override them.
 *
 * Kept apart from the option types the entry point exports, so no pg-boss type appears in the
 * published declarations.
 *
 * @param {ResolvedJobsModuleOptions} options - Resolved module options.
 * @returns {ConstructorOptions} Options for the pg-boss constructor.
 */
export function toRuntimeBossOptions(
  options: ResolvedJobsModuleOptions | ResolvedJobsRuntimeOptions,
): ConstructorOptions {
  const explicit: ResolvedJobsRuntimeOptions | null = 'capabilities' in options ? options : null;
  const scheduler: boolean = explicit?.capabilities.has('scheduler') ?? true;
  return {
    ...options.connection,
    schema: options.schema,
    max: explicit?.poolSize ?? JOBS_POOL_SIZE,
    migrate: false,
    createSchema: false,
    supervise: scheduler,
    schedule: scheduler,
    reindex: false,
    persistQueueStats: false,
    persistWarnings: false,
  };
}
