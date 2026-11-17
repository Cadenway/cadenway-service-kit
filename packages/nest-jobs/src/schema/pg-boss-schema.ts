import { createRequire } from 'node:module';

/**
 * Function expectedSchemaVersion
 *
 * @description
 * Reads the schema version the installed pg-boss works with, from the `pgboss.schema` field of its
 * package manifest, which is where pg-boss itself reads it. pg-boss exposes no function for it.
 *
 * The runtime only starts on exactly this version, and the provisioning refuses a stored schema
 * that is newer: pg-boss would otherwise start on it without a word.
 *
 * @returns {number} Schema version of the pg-boss release this package depends on.
 * @throws {Error} When the manifest carries no such number, which means the pg-boss dependency was
 *   changed without this package.
 */
export function expectedSchemaVersion(): number {
  const manifest: unknown = createRequire(import.meta.url)('pg-boss/package.json');
  const version: unknown =
    typeof manifest === 'object' && manifest !== null && 'pgboss' in manifest
      ? manifest.pgboss
      : undefined;
  const schema: unknown =
    typeof version === 'object' && version !== null && 'schema' in version
      ? version.schema
      : undefined;
  if (typeof schema !== 'number' || !Number.isInteger(schema)) {
    throw new Error('The installed pg-boss does not state its schema version.');
  }
  return schema;
}
