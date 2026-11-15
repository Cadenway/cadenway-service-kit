import type { ConstructorOptions } from 'pg-boss';

import { JOBS_POOL_SIZE, type ResolvedJobsModuleOptions } from './jobs-options.js';

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
export function toRuntimeBossOptions(options: ResolvedJobsModuleOptions): ConstructorOptions {
  return {
    ...options.connection,
    schema: options.schema,
    max: JOBS_POOL_SIZE,
    migrate: false,
    createSchema: false,
    supervise: true,
    schedule: true,
    reindex: false,
    persistQueueStats: false,
    persistWarnings: false,
  };
}
