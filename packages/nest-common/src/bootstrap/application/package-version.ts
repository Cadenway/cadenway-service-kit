import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Function readPackageVersion
 *
 * @description
 * Reads the version of the application from its `package.json`, which the image keeps next to
 * `dist/`. Used as the default `version` of the logs and of telemetry.
 *
 * @param {string} directory - Directory holding `package.json`; defaults to the working directory.
 * @returns {string} The version, or `0.0.0` when the file is missing or has none.
 */
export function readPackageVersion(directory: string = process.cwd()): string {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    const version: unknown = (manifest as { version?: unknown } | null)?.version;
    return typeof version === 'string' && version !== '' ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
