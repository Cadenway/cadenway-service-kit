import pino from 'pino';

import { ConfigError } from '../../config/load-config.js';
import {
  redactedKeySet,
  sanitizeLogValue,
  sanitizeSerializedError,
} from '../../logging/redaction.js';
import { readPackageVersion } from '../application/package-version.js';

/**
 * Interface StartupErrorStream
 *
 * @description
 * Part of a writable stream `runApplication` writes the failure line to, such as
 * `process.stderr`.
 */
export interface StartupErrorStream {
  // #region Methods
  /**
   * Method write
   *
   * @description
   * Writes one chunk and calls back once it is flushed.
   *
   * @param {string} chunk - Text to write.
   * @param {(error?: Error | null) => void} callback - Called once the chunk is flushed or failed.
   * @returns {unknown} Ignored.
   */
  write(chunk: string, callback: (error?: Error | null) => void): unknown;
  // #endregion
}

/**
 * Interface RunApplicationOptions
 *
 * @description
 * Options of `runApplication`. Only `service` is required; `stderr` and `exit` are test seams.
 */
export interface RunApplicationOptions {
  // #region Properties
  /**
   * Property service
   *
   * @description
   * Name of the service or gateway, written in the `service` field of the failure line.
   *
   * @type {string}
   * @readonly
   */
  readonly service: string;

  /**
   * Property version
   *
   * @description
   * Released version of the application, written in the `version` field. Defaults to the version
   * of the `package.json` in the working directory.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly version?: string;

  /**
   * Property stderr
   *
   * @description
   * Stream that receives the failure line. Defaults to `process.stderr`; meant for tests.
   *
   * @type {StartupErrorStream | undefined}
   * @readonly
   */
  readonly stderr?: StartupErrorStream;

  /**
   * Property exit
   *
   * @description
   * Ends the process once the line is flushed. Defaults to `process.exit`; meant for tests.
   *
   * @type {((code: number) => void) | undefined}
   * @readonly
   */
  readonly exit?: (code: number) => void;
  // #endregion
}

/**
 * Function serializeStartupError
 *
 * @description
 * Serializes a start-up error as the `err` field of the logs, with the same sanitization: the
 * SQL members of a database error dropped, the redacted keys masked at any depth, e-mail
 * addresses masked. A `ConfigError` keeps its `issues`, which name variables and never values.
 *
 * @param {unknown} error - What `main` rejected with.
 * @returns {Record<string, unknown>} The sanitized `err` field.
 */
function serializeStartupError(error: unknown): Record<string, unknown> {
  const cause: Error = error instanceof Error ? error : new Error(String(error));
  const keys: ReadonlySet<string> = redactedKeySet();
  const serialized: Record<string, unknown> = sanitizeSerializedError(
    pino.stdSerializers.err(cause),
    keys,
  );
  if (cause instanceof ConfigError) {
    serialized.issues = sanitizeLogValue(cause.issues, keys);
  }
  return serialized;
}

/**
 * Function runApplication
 *
 * @description
 * Runs the start-up of a Cadenway backend and reports its failure as the logs would. Wrap the
 * whole `main.ts` in it:
 *
 * `await runApplication({ service: 'task-service' }, async () => { const config = loadConfig(schema); const app = await createApplication(AppModule, { ... }); await app.listen(config.PORT); });`
 *
 * When `main` rejects (an invalid configuration, a provider that fails while the application is
 * created, a port already in use), it writes one JSON line on the standard error, in the shape of
 * the logs (`level: 'fatal'`, ISO `time`, `service`, `version`, `msg: 'start-up failed'`, a
 * sanitized `err`), sets `process.exitCode` to 1 and ends the process once the line is flushed.
 * The error may come before any logger exists, which is why this function does not need one.
 *
 * @param {RunApplicationOptions} options - Identity of the application and the test seams.
 * @param {() => Promise<void>} main - Start-up of the application, which usually ends by listening.
 * @returns {Promise<void>} Resolves once `main` has resolved, or once the failure is reported and the exit requested.
 */
export async function runApplication(
  options: RunApplicationOptions,
  main: () => Promise<void>,
): Promise<void> {
  try {
    await main();
  } catch (error) {
    const line: string = `${JSON.stringify({
      level: 'fatal',
      time: new Date().toISOString(),
      service: options.service,
      version: options.version ?? readPackageVersion(),
      msg: 'start-up failed',
      err: serializeStartupError(error),
    })}\n`;
    const stream: StartupErrorStream = options.stderr ?? process.stderr;
    process.exitCode = 1;
    await new Promise<void>((resolve: () => void) => {
      stream.write(line, () => {
        resolve();
      });
    });
    (options.exit ?? ((code: number): void => process.exit(code)))(1);
  }
}
