import type { z } from 'zod';

/**
 * Type ConfigEnvironment
 *
 * @description
 * Environment map a configuration is read from, usually `process.env`.
 *
 * @type {Readonly<Record<string, string | undefined>>}
 */
export type ConfigEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Class ConfigError
 *
 * @description
 * Raised at start-up when the environment does not satisfy the configuration schema.
 *
 * The message lists every invalid variable by name with the reason, and never a value: a
 * misconfigured secret must not reach the logs through its own validation error.
 */
export class ConfigError extends Error {
  // #region Properties
  /**
   * Property issues
   *
   * @description
   * One entry per invalid variable, as `<NAME>: <reason>`.
   *
   * @type {readonly string[]}
   * @readonly
   */
  public readonly issues: readonly string[];
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Builds the error message from the list of invalid variables.
   *
   * @param {readonly string[]} issues - One `<NAME>: <reason>` entry per invalid variable.
   * @constructor
   */
  public constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
  // #endregion
}

/**
 * Function loadConfig
 *
 * @description
 * Validates an environment map against a zod schema and returns the typed, frozen configuration.
 *
 * A variable set to an empty string counts as unset, so a compose file can pass `NAME=` for an
 * optional setting and still get the schema default. Call it once at start-up: a failure must stop
 * the process before it listens.
 *
 * @param {z.ZodType<TConfig>} schema - Schema of the variables the application reads.
 * @param {ConfigEnvironment} env - Environment to read; defaults to `process.env`.
 * @returns {Readonly<TConfig>} The validated configuration.
 * @throws {ConfigError} When a variable is missing or invalid.
 */
export function loadConfig<TConfig>(
  schema: z.ZodType<TConfig>,
  env: ConfigEnvironment = process.env,
): Readonly<TConfig> {
  const present: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') {
      present[name] = value;
    }
  }
  const result: z.ZodSafeParseResult<TConfig> = schema.safeParse(present);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map(
        (issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
      ),
    );
  }
  return Object.freeze(result.data);
}
