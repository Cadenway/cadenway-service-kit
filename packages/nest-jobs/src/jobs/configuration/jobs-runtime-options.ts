import {
  resolveJobsModuleOptions,
  type JobsModuleOptions,
  type ResolvedJobsModuleOptions,
} from './jobs-options.js';

/** A capability available to a process in the durable jobs runtime. */
export type JobsCapability = 'producer' | 'worker' | 'scheduler';

/** Options of a jobs process with explicitly selected capabilities. */
export interface JobsRuntimeOptions extends JobsModuleOptions {
  // #region Properties
  /** Capabilities of the process. At least one unique capability is required. */
  readonly capabilities: readonly JobsCapability[];

  /** Maximum persistent pg-boss connections shared by worker and scheduler capabilities. */
  readonly poolSize: number;
  // #endregion
}

/** Validated options of a jobs process. */
export interface ResolvedJobsRuntimeOptions extends ResolvedJobsModuleOptions {
  // #region Properties
  /** Selected capabilities, normalized to a lookup set. */
  readonly capabilities: ReadonlySet<JobsCapability>;

  /** Maximum persistent pg-boss connections. */
  readonly poolSize: number;
  // #endregion
}

/** Resolves shared jobs settings and validates the capabilities and connection budget. */
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
