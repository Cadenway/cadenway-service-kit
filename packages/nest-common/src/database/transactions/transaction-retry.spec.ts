import { EventEmitter } from 'node:events';

import { Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { runWithOrganizationContext } from '../../auth/context/organization-context.js';
import { redactedKeySet, sanitizeLogValue } from '../../logging/redaction.js';
import { SystemTransactionRunner } from './system-transaction-runner.js';
import { TenantTransactionRunner } from './tenant-transaction-runner.js';

/**
 * Function fakePool
 *
 * @description
 * Creates a pool that records each physical transaction without a PostgreSQL server.
 *
 * @returns {{ pool: Pool; connect: ReturnType<typeof vi.fn> }} Pool and checkout spy.
 */
function fakePool(): { pool: Pool; connect: ReturnType<typeof vi.fn> } {
  const connect = vi.fn(() =>
    Promise.resolve(
      Object.assign(new EventEmitter(), {
        query: (statement: string) => Promise.resolve({ command: statement, rows: [] }),
        release: vi.fn(),
      }),
    ),
  );
  return { pool: { connect } as unknown as Pool, connect };
}

describe('transaction retry', () => {
  it.each(['40P01', '40001'])(
    'retries %s in a new transaction, including wrapped errors',
    async (code) => {
      const { pool, connect } = fakePool();
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const work = vi
        .fn()
        .mockRejectedValueOnce(new Error('query', { cause: { code } }))
        .mockResolvedValue('ok');
      try {
        await expect(new SystemTransactionRunner(pool).run(work)).resolves.toBe('ok');
        expect(connect).toHaveBeenCalledTimes(2);
        expect(work).toHaveBeenCalledTimes(2);
        const fields = {
          msg: 'transaction retry',
          sqlState: code,
          attempt: 1,
        };
        expect(warn).toHaveBeenCalledExactlyOnceWith(fields);
        expect(sanitizeLogValue(warn.mock.calls[0]?.[0], redactedKeySet())).toEqual(fields);
      } finally {
        warn.mockRestore();
      }
    },
  );

  it('does not retry other errors and preserves the final error and cause', async () => {
    const { pool, connect } = fakePool();
    const error = new Error('failure', { cause: { code: '23505' } });
    await expect(new SystemTransactionRunner(pool).run(() => Promise.reject(error))).rejects.toBe(
      error,
    );
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('stops at the configured attempt limit and preserves the final error', async () => {
    const { pool, connect } = fakePool();
    const error = new Error('failure', { cause: { code: '40001' } });
    await expect(
      new SystemTransactionRunner(pool, undefined, 2).run(() => Promise.reject(error)),
    ).rejects.toBe(error);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('lets a call disable or override the default and validates its limit', async () => {
    const { pool, connect } = fakePool();
    const error = Object.assign(new Error('deadlock'), { code: '40P01' });
    const runner = new SystemTransactionRunner(pool, undefined, 1);
    await expect(runner.run(() => Promise.reject(error), { maxAttempts: 1 })).rejects.toBe(error);
    const work = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('ok');
    await expect(runner.run(work, { maxAttempts: 2 })).resolves.toBe('ok');
    await expect(runner.run(work, { maxAttempts: 0 })).rejects.toThrow('positive safe integer');
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it('retries the outer tenant work, never the nested call independently', async () => {
    const { pool, connect } = fakePool();
    const runner = new TenantTransactionRunner(pool);
    const inner = vi.fn().mockRejectedValueOnce({ code: '40P01' }).mockResolvedValue('ok');
    const outer = vi.fn(() => runner.run(inner, { maxAttempts: 1 }));
    const result = await runWithOrganizationContext(
      {
        organizationId: '0193a1f0-0000-7000-8000-00000000000a',
        actor: { type: 'user', id: 'user' },
        role: 'member',
        scopes: [],
      },
      () => runner.run(outer),
    );
    expect(result).toBe('ok');
    expect(outer).toHaveBeenCalledTimes(2);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
