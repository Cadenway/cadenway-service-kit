/**
 * Entry point `@cadenway/nest-common/database`: the PostgreSQL pool, the tenant and system
 * transaction runners, the row-level security policy and the `Idempotency-Key` interceptor with
 * its table.
 *
 * Kept apart from the main entry point because `drizzle-orm` and `pg` are optional peers: a
 * gateway without a database never imports this file.
 *
 * @packageDocumentation
 */
export {
  DATABASE_POOL,
  databaseConfigShape,
  DatabaseModule,
  DEFAULT_POOL_SIZE,
  type DatabaseConfig,
  type DatabaseModuleOptions,
} from './database.module.js';
export {
  Idempotent,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_RETENTION_HOURS,
  IDEMPOTENT_REPLAYED_HEADER,
  IdempotencyInterceptor,
  purgeExpiredIdempotencyKeys,
  type IdempotentOptions,
} from './idempotency.interceptor.js';
export { default as idempotencyKeys } from './idempotency.schema.js';
export {
  ORGANIZATION_SETTING,
  organizationIsolation,
  organizationPolicy,
  SYSTEM_ACCESS_SETTING,
} from './organization-policy.js';
export {
  SystemTransactionRunner,
  TenantTransactionRunner,
  TransactionAbortedError,
  type DatabaseSchema,
  type TransactionClient,
  type TransactionDatabase,
  type TransactionKind,
  type TransactionOptions,
  type TransactionScope,
} from './transaction-runner.js';
