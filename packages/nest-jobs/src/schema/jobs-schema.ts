/**
 * Constant DEFAULT_JOBS_SCHEMA
 *
 * @description
 * PostgreSQL schema that holds the pg-boss tables when none is configured.
 *
 * @type {string}
 */
export const DEFAULT_JOBS_SCHEMA: string = 'pgboss';

/**
 * Constant RESERVED_SCHEMA_PATTERN
 *
 * @description
 * Schemas that cannot hold the pg-boss tables. `public` holds business tables in many databases,
 * and the table grants of the provisioning would widen the application role on them; the others
 * belong to PostgreSQL.
 *
 * @type {RegExp}
 */
const RESERVED_SCHEMA_PATTERN: RegExp = /^(?:public|information_schema|pg_.*)$/u;

/**
 * Constant IDENTIFIER_PATTERN
 *
 * @description
 * A PostgreSQL identifier that reads the same quoted and unquoted: lowercase letters, digits and
 * underscores, not starting with a digit. Schema and role names are restricted to it because they
 * are written into DDL and GRANT statements, where no bind parameter exists.
 *
 * @type {RegExp}
 */
const IDENTIFIER_PATTERN: RegExp = /^[a-z_][a-z0-9_]*$/u;

/**
 * Constant MAX_SCHEMA_NAME_BYTES
 *
 * @description
 * Longest schema name pg-boss accepts, in bytes.
 *
 * @type {number}
 */
const MAX_SCHEMA_NAME_BYTES: number = 50;

/**
 * Constant MAX_IDENTIFIER_BYTES
 *
 * @description
 * Longest identifier PostgreSQL stores without truncating it, in bytes.
 *
 * @type {number}
 */
const MAX_IDENTIFIER_BYTES: number = 63;

/**
 * Function assertSchemaName
 *
 * @description
 * Refuses a schema name that would not read the same quoted and unquoted, that pg-boss rejects, or
 * that is not a schema of its own: `public`, `information_schema` and the `pg_` schemas.
 *
 * @param {unknown} schema - Candidate schema name.
 * @throws {Error} When the name is not a lowercase identifier of at most 50 bytes, or is reserved.
 */
export function assertSchemaName(schema: unknown): asserts schema is string {
  if (
    typeof schema !== 'string' ||
    !IDENTIFIER_PATTERN.test(schema) ||
    Buffer.byteLength(schema, 'utf8') > MAX_SCHEMA_NAME_BYTES
  ) {
    throw new Error(
      'schema must be at most 50 lowercase letters, digits or underscores and cannot start with a digit.',
    );
  }
  if (RESERVED_SCHEMA_PATTERN.test(schema)) {
    throw new Error(
      `schema must be a schema of its own: "${schema}" is reserved, and the grants on its tables would reach tables that are not pg-boss tables.`,
    );
  }
}

/**
 * Function assertRoleName
 *
 * @description
 * Refuses a role name that would not read the same quoted and unquoted. The name is written into
 * GRANT statements, where no bind parameter exists.
 *
 * @param {unknown} role - Candidate role name.
 * @throws {Error} When the name is not a lowercase identifier of at most 63 bytes.
 */
export function assertRoleName(role: unknown): asserts role is string {
  if (
    typeof role !== 'string' ||
    !IDENTIFIER_PATTERN.test(role) ||
    Buffer.byteLength(role, 'utf8') > MAX_IDENTIFIER_BYTES
  ) {
    throw new Error(
      'appRole must be at most 63 lowercase letters, digits or underscores and cannot start with a digit.',
    );
  }
}
