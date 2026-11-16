import { AsyncLocalStorage } from 'node:async_hooks';

import type {
  DatabaseSchema,
  TransactionOptions,
  TransactionScope,
} from './transaction-contracts.js';

/** Transaction and its effective options in the current asynchronous call chain. */
interface ActiveTransaction {
  // #region Properties
  /** Scope shared by callbacks that join this transaction. */
  readonly scope: TransactionScope<DatabaseSchema>;

  /** Effective options of the owning transaction. */
  readonly options: TransactionOptions;

  /** Whether the owner still accepts work on the scope. */
  readonly isOpen: () => boolean;
  // #endregion
}

const activeTransaction: AsyncLocalStorage<ActiveTransaction> =
  new AsyncLocalStorage<ActiveTransaction>();

const ISOLATION_RANK: Readonly<
  Record<'default' | NonNullable<TransactionOptions['isolationLevel']>, number>
> = { default: 0, 'read committed': 0, 'repeatable read': 1, serializable: 2 };

/** Associates the transaction with its callback. The executor controls the scope's lifetime. */
export function runInTransactionContext<TSchema extends DatabaseSchema, TResult>(
  scope: TransactionScope<TSchema>,
  options: TransactionOptions,
  isOpen: () => boolean,
  work: (scope: TransactionScope<TSchema>) => Promise<TResult>,
): Promise<TResult> {
  return activeTransaction.run({ scope, options, isOpen }, () => work(scope));
}

/** Returns the live transaction scope, if the current asynchronous work has one. */
export function getActiveTransaction(): TransactionScope<DatabaseSchema> | undefined {
  const current: ActiveTransaction | undefined = activeTransaction.getStore();
  return current?.isOpen() === true ? current.scope : undefined;
}

/** Rejects work that must run outside any live transaction in the current call chain. */
export function assertNoActiveTransaction(): void {
  if (getActiveTransaction() !== undefined) {
    throw new Error('This operation must run outside an active transaction.');
  }
}

/** Finds the ambient transaction and checks that it provides the caller's requirements. */
export function joinActiveTransaction<TSchema extends DatabaseSchema>(
  requested: TransactionOptions,
  assertAccess: (scope: TransactionScope<DatabaseSchema>) => void,
): TransactionScope<TSchema> | undefined {
  const current: ActiveTransaction | undefined = activeTransaction.getStore();
  if (current?.isOpen() !== true) {
    return undefined;
  }

  assertAccess(current.scope);
  const isolation: 'default' | NonNullable<TransactionOptions['isolationLevel']> =
    requested.isolationLevel ?? 'default';
  if (ISOLATION_RANK[isolation] > ISOLATION_RANK[current.options.isolationLevel ?? 'default']) {
    throw new Error(
      `The running transaction cannot provide the ${isolation} isolation level: open the outer transaction with it.`,
    );
  }
  if (requested.readOnly === true && current.options.readOnly !== true) {
    throw new Error(
      'The running transaction cannot provide read-only access: open the outer transaction as read-only.',
    );
  }

  return current.scope as TransactionScope<TSchema>;
}
