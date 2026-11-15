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
      result.error.issues.map((issue: z.core.$ZodIssue) => describeIssue(issue, present)),
    );
  }
  return Object.freeze(result.data);
}

/**
 * Function describeIssue
 *
 * @description
 * Words one validation issue as `<NAME>: <reason>`. A variable that is not set (absent, or empty,
 * which counts as unset) and has no default reads `required, not set`, rather than the type
 * mismatch zod reports for `undefined`; a variable that is set keeps the message of zod, which
 * names the expectation and never the received value.
 *
 * @param {z.core.$ZodIssue} issue - Issue reported by the schema.
 * @param {Readonly<Record<string, string>>} present - Variables that are set, by name.
 * @returns {string} The entry of `ConfigError.issues`.
 */
function describeIssue(issue: z.core.$ZodIssue, present: Readonly<Record<string, string>>): string {
  const name: PropertyKey | undefined = issue.path.length === 1 ? issue.path[0] : undefined;
  if (typeof name === 'string' && !Object.hasOwn(present, name)) {
    return `${name}: required, not set`;
  }
  return `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`;
}
