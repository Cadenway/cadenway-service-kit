import {
  resolveJobsModuleOptions,
  type JobsModuleOptions,
  type ResolvedJobsModuleOptions,
} from './jobs-options.js';
import { JOBS_POOL_SIZE } from '../database/jobs-connection.js';

/**
 * Type JobsCapability
 *
 * @description
 * A capability available to a process in the durable jobs runtime.
 *
 * @type {'producer' | 'worker' | 'scheduler'}
 */
export type JobsCapability = 'producer' | 'worker' | 'scheduler';

/**
 * Interface JobsRuntimeOptions
 *
 * @description
 * Options of a jobs process with explicitly selected capabilities.
 */
export interface JobsRuntimeOptions extends JobsModuleOptions {
  // #region Properties
  /**
   * Property capabilities
   *
   * @description
   * Capabilities of the process. At least one unique capability is required.
   *
   * @type {readonly JobsCapability[]}
   * @readonly
   */
  readonly capabilities: readonly JobsCapability[];

  /**
   * Property poolSize
   *
   * @description
   * Maximum persistent pg-boss connections shared by worker and scheduler capabilities.
   *
   * @type {number}
   * @readonly
   */
  readonly poolSize: number;
  // #endregion
}

/**
 * Interface ResolvedJobsRuntimeOptions
 *
 * @description
 * Validated options of a jobs process.
 */
export interface ResolvedJobsRuntimeOptions extends ResolvedJobsModuleOptions {
  // #region Properties
  /**
   * Property capabilities
   *
   * @description
   * Selected capabilities, normalized to a lookup set.
   *
   * @type {ReadonlySet<JobsCapability>}
   * @readonly
   */
  readonly capabilities: ReadonlySet<JobsCapability>;

  /**
   * Property poolSize
   *
   * @description
   * Maximum persistent pg-boss connections.
   *
   * @type {number}
   * @readonly
   */
  readonly poolSize: number;
  // #endregion
}

/**
 * Function resolveJobsRuntimeOptions
 *
 * @description
 * Resolves shared jobs settings and validates the capabilities and connection budget.
 *
 * @param {JobsRuntimeOptions} options - Options with an explicit selection of capabilities and pool size.
 * @returns {ResolvedJobsRuntimeOptions} Validated settings, normalized capabilities and the pool limit.
 */
export function resolveJobsRuntimeOptions(options: JobsRuntimeOptions): ResolvedJobsRuntimeOptions {
  const capabilities: readonly JobsCapability[] = options.capabilities;
  if (
    !Array.isArray(capabilities) ||
    capabilities.length === 0 ||
    capabilities.some(
      (capability: unknown): boolean =>
        capability !== 'producer' && capability !== 'worker' && capability !== 'scheduler',
    ) ||
    new Set(capabilities).size !== capabilities.length
  ) {
    throw new Error(
      'capabilities must contain one or more distinct producer, worker or scheduler values.',
    );
  }
  if (!Number.isSafeInteger(options.poolSize) || options.poolSize < 1) {
    throw new Error('poolSize must be an integer of at least 1.');
  }
  return {
    ...resolveJobsModuleOptions(options),
    capabilities: new Set(capabilities),
    poolSize: options.poolSize,
  };
}

/**
 * Function resolveLegacyJobsRuntimeOptions
 *
 * @description
 * Resolves the combined runtime selected by the compatibility module.
 *
 * @param {JobsModuleOptions} options - Legacy options whose runtime combines all three capabilities.
 * @returns {ResolvedJobsRuntimeOptions} Validated settings with all three capabilities and a pool of two.
 */
export function resolveLegacyJobsRuntimeOptions(
  options: JobsModuleOptions,
): ResolvedJobsRuntimeOptions {
  return resolveJobsRuntimeOptions({
    ...options,
    capabilities: ['producer', 'worker', 'scheduler'],
    poolSize: JOBS_POOL_SIZE,
  });
}
