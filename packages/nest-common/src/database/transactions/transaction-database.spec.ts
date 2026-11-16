import { sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { expect, it, vi } from 'vitest';

import { CLOSED_SCOPE_MESSAGE, createTransactionDatabase } from './transaction-database.js';

it('uses independent transaction lifetimes for two adapters on one connection', async () => {
  const query = vi.fn(() => Promise.resolve({ rows: [] }));
  const connection: PoolClient = { query } as unknown as PoolClient;
  let firstOpen: boolean = true;
  const first = createTransactionDatabase(connection, undefined, () => firstOpen);
  await first.execute(sql`select 1`);
  firstOpen = false;

  const second = createTransactionDatabase(connection, undefined, () => true);
  await expect(first.execute(sql`select 1`)).rejects.toMatchObject({
    cause: { message: CLOSED_SCOPE_MESSAGE },
  });
  await second.execute(sql`select 1`);
  expect(query).toHaveBeenCalledTimes(2);
});
