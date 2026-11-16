import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { inProvisioningTransaction, type ProvisioningClient } from './provisioning-transaction.js';

/**
 * Function clientThat
 *
 * @description
 * Builds a connection stand-in that records the statements it receives and fails those listed.
 *
 * @param {string[]} statements - Receives the text of every statement, in order.
 * @param {Record<string, Error>} [failures] - Errors to reject with, by statement text.
 * @returns {ProvisioningClient} The stand-in.
 */
function clientThat(
  statements: string[],
  failures: Record<string, Error> = {},
): ProvisioningClient {
  return {
    query(text: string): Promise<unknown> {
      statements.push(text);
      const failure: Error | undefined = failures[text];
      return failure === undefined ? Promise.resolve({ rows: [] }) : Promise.reject(failure);
    },
  };
}

describe('inProvisioningTransaction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('takes the advisory lock of the schema inside the transaction, before the work', async () => {
    const statements: string[] = [];
    const values: unknown[][] = [];
    const client: ProvisioningClient = {
      query(text: string, parameters?: unknown[]): Promise<unknown> {
        statements.push(text);
        values.push(parameters ?? []);
        return Promise.resolve({ rows: [] });
      },
    };

    await inProvisioningTransaction(client, 'pgboss', async (): Promise<void> => {
      await client.query('GRANT USAGE ON SCHEMA "pgboss" TO "svc_app"');
    });

    expect(statements).toEqual([
      'BEGIN',
      'SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))',
      'GRANT USAGE ON SCHEMA "pgboss" TO "svc_app"',
      'COMMIT',
    ]);
    expect(values[1]).toEqual(['cadenway.nest-jobs.provision.pgboss']);
  });

  it('rolls back and rethrows the error of the work', async () => {
    const statements: string[] = [];
    const failure: Error = new Error('permission denied for table queue');

    await expect(
      inProvisioningTransaction(clientThat(statements), 'pgboss', (): Promise<void> =>
        Promise.reject(failure),
      ),
    ).rejects.toBe(failure);

    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
  });

  it('keeps the original error when the rollback fails too, and logs the rollback failure', async () => {
    const logged: MockInstance = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((): void => undefined);
    const statements: string[] = [];
    const failure: Error = new Error('permission denied for table queue');
    const client: ProvisioningClient = clientThat(statements, {
      ROLLBACK: new Error('Connection terminated unexpectedly'),
    });

    await expect(
      inProvisioningTransaction(client, 'pgboss', (): Promise<void> => Promise.reject(failure)),
    ).rejects.toBe(failure);

    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(logged.mock.calls.map((call: unknown[]): string => String(call[0]))).toEqual([
      'The provisioning transaction did not roll back: Error: Connection terminated unexpectedly',
    ]);
  });

  it('rolls back when the commit fails', async () => {
    const statements: string[] = [];
    const failure: Error = new Error('could not serialize access');

    await expect(
      inProvisioningTransaction(
        clientThat(statements, { COMMIT: failure }),
        'pgboss',
        (): Promise<void> => Promise.resolve(),
      ),
    ).rejects.toBe(failure);

    expect(statements.slice(-2)).toEqual(['COMMIT', 'ROLLBACK']);
  });
});
