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
export { databaseConfigShape, type DatabaseConfig } from './connection/database-config.js';
export { DATABASE_POOL, DEFAULT_POOL_SIZE } from './connection/database-pool.js';
export {
  DatabaseModule,
  type DatabaseModuleAsyncOptions,
  type DatabaseModuleOptions,
} from './wiring/database.module.js';
export {
  Idempotent,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_RETENTION_HOURS,
  IDEMPOTENT_REPLAYED_HEADER,
  IdempotencyInterceptor,
  purgeExpiredIdempotencyKeys,
  type IdempotentOptions,
} from './idempotency/idempotency.interceptor.js';
export { default as idempotencyKeys } from './idempotency/idempotency.schema.js';
export {
  ORGANIZATION_SETTING,
  organizationIsolation,
  organizationPolicy,
  SYSTEM_ACCESS_SETTING,
} from './policies/organization-policy.js';
export { SystemTransactionRunner } from './transactions/system-transaction-runner.js';
export { TenantTransactionRunner } from './transactions/tenant-transaction-runner.js';
export { assertNoActiveTransaction } from './transactions/transaction-context.js';
export type {
  DatabaseSchema,
  TransactionClient,
  TransactionDatabase,
  TransactionKind,
  TransactionOptions,
  TransactionScope,
} from './transactions/transaction-contracts.js';
export { TransactionAbortedError } from './transactions/transaction-executor.js';
