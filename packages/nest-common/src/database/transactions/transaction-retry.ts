import { Logger } from '@nestjs/common';

/**
 * Constant logger
 *
 * @description
 * Reports retry decisions without including database errors or query contents.
 *
 * @type {Logger}
 */
const logger: Logger = new Logger('TransactionRetry');

/**
 * Function retryCode
 *
 * @description
 * Finds a retryable SQLSTATE in an error or its cause chain, including Drizzle wrappers.
 *
 * @param {unknown} error - Error raised by the transaction.
 * @returns {string | undefined} Retryable SQLSTATE, if present.
 */
function retryCode(error: unknown): string | undefined {
  const seen: Set<object> = new Set<object>();
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && (current.code === '40P01' || current.code === '40001')) {
      return current.code;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

/**
 * Function retryTransaction
 *
 * @description
 * Repeats a complete physical transaction after a deadlock or serialization failure.
 *
 * @param {() => Promise<TResult>} execute - Opens and executes one transaction.
 * @param {number} maxAttempts - Maximum number of attempts including the first.
 * @returns {Promise<TResult>} Result of the committed attempt.
 * @throws {Error} When the attempt limit is invalid or the final attempt fails.
 */
export async function retryTransaction<TResult>(
  execute: () => Promise<TResult>,
  maxAttempts: number,
): Promise<TResult> {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('Transaction maxAttempts must be a positive safe integer.');
  }
  for (let attempt: number = 1; ; attempt += 1) {
    try {
      return await execute();
    } catch (error) {
      const code: string | undefined = retryCode(error);
      if (code === undefined || attempt >= maxAttempts) {
        throw error;
      }
      logger.warn({ code, attempt }, 'transaction retry');
      const multiplier: number = Math.min(2 ** (attempt - 1), 100);
      await new Promise<void>((resolve) =>
        setTimeout(resolve, (10 + Math.random() * 40) * multiplier),
      );
    }
  }
}
