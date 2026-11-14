import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  runWithOrganizationContext,
  type OrganizationContext,
} from '../auth/organization-context.js';
import { startTestDatabase, type TestDatabase } from '../testing/postgres.js';
import { organizationIsolation } from './organization-policy.js';
import {
  getActiveTransaction,
  SystemTransactionRunner,
  TenantTransactionRunner,
  type TransactionScope,
} from './transaction-runner.js';

/**
 * Constant ATELIER_NORD
 *
 * @description
 * Id of the first organization of the fixtures.
 *
 * @type {string}
 */
const ATELIER_NORD: string = '0193a1f0-0000-7000-8000-00000000000a';

/**
 * Constant OTHER_ORGANIZATION
 *
 * @description
 * Id of a second organization, whose rows the first must never see.
 *
 * @type {string}
 */
const OTHER_ORGANIZATION: string = '0193a1f0-0000-7000-8000-00000000000b';

/**
 * Function as
 *
 * @description
 * Runs work in the organization context of a user of the given organization, as the
 * internal-token interceptor does for a request.
 *
 * @param {string} organizationId - Organization of the verified token.
 * @param {() => Promise<TResult>} work - Work to run.
 * @returns {Promise<TResult>} What the work returns.
 */
function as<TResult>(organizationId: string, work: () => Promise<TResult>): Promise<TResult> {
  const context: OrganizationContext = {
    organizationId,
    actor: { type: 'user', id: 'user-camille' },
    role: 'member',
    scopes: [],
  };
  return runWithOrganizationContext(context, work);
}

/**
 * Function titles
 *
 * @description
 * Reads the titles of the task rows a query returned, sorted.
 *
 * @param {{ rows: unknown[] }} result - Result of a query on `tasks`.
 * @returns {string[]} The sorted titles.
 */
function titles(result: { rows: unknown[] }): string[] {
  return (result.rows as { title: string }[]).map((row) => row.title).sort();
}

describe('transaction runners', () => {
  let database: TestDatabase;
  let pool: pg.Pool;
  let tenant: TenantTransactionRunner;
  let system: SystemTransactionRunner;

  beforeAll(async () => {
    database = await startTestDatabase();
    const predicate: string = new PgDialect().sqlToQuery(organizationIsolation).sql;
    await database.migrate(
      [
        `create table tasks (
           id uuid primary key default uuidv7(),
           organization_id uuid not null,
           title text not null
         )`,
        'alter table tasks enable row level security',
        `create policy organization_isolation on tasks for all using (${predicate}) with check (${predicate})`,
      ],
      ['tasks'],
    );
    pool = new pg.Pool({ connectionString: database.appUrl, max: 2 });
    tenant = new TenantTransactionRunner(pool);
    system = new SystemTransactionRunner(pool);
  });

  beforeEach(async () => {
    await database.admin.query('truncate tasks');
    await system.run(async (scope: TransactionScope) => {
      await scope.client.query(
        'insert into tasks (organization_id, title) values ($1, $2), ($1, $3), ($4, $5)',
        [ATELIER_NORD, 'CAD-482', 'CAD-483', OTHER_ORGANIZATION, 'OPS-1'],
      );
    });
  });

  afterAll(async () => {
    await pool.end();
    await database.stop();
  });

  it('runs as a role that neither owns the table nor bypasses row-level security', async () => {
    const role: { rows: unknown[] } = await pool.query(
      `select rolsuper, rolbypassrls, has_database_privilege(current_user, current_database(), 'CREATE') as can_create
         from pg_roles where rolname = current_user`,
    );
    const table: { rows: unknown[] } = await database.admin.query(
      "select relrowsecurity, relforcerowsecurity from pg_class where relname = 'tasks'",
    );

    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, can_create: false });
    expect(table.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('returns no row of another organization under the tenant runner', async () => {
    const seen: { all: string[]; other: unknown[]; touched: number } = await as(ATELIER_NORD, () =>
      tenant.run(async (scope: TransactionScope) => {
        const all: { rows: unknown[] } = await scope.client.query('select title from tasks');
        const other: { rows: unknown[] } = await scope.client.query(
          'select title from tasks where organization_id = $1',
          [OTHER_ORGANIZATION],
        );
        const updated: { rows: unknown[] } = await scope.client.query(
          "update tasks set title = 'stolen' where organization_id = $1 returning id",
          [OTHER_ORGANIZATION],
        );
        return { all: titles(all), other: other.rows, touched: updated.rows.length };
      }),
    );

    expect(seen).toEqual({ all: ['CAD-482', 'CAD-483'], other: [], touched: 0 });
    expect(scopeTitles(await database.admin.query('select title from tasks'))).toContain('OPS-1');
  });

  it('refuses to write a row for another organization', async () => {
    await expect(
      as(ATELIER_NORD, () =>
        tenant.run((scope: TransactionScope) =>
          scope.client.query('insert into tasks (organization_id, title) values ($1, $2)', [
            OTHER_ORGANIZATION,
            'planted',
          ]),
        ),
      ),
    ).rejects.toThrow(/row-level security/u);
  });

  it('lets the system runner cross organizations', async () => {
    const all: string[] = await system.run(async (scope: TransactionScope) =>
      titles(await scope.db.execute(sql`select title from tasks`)),
    );

    expect(all).toEqual(['CAD-482', 'CAD-483', 'OPS-1']);
  });

  it('shows nothing outside the runners, and nothing leaks from a finished transaction', async () => {
    const single: pg.Pool = new pg.Pool({ connectionString: database.appUrl, max: 1 });
    try {
      await as(ATELIER_NORD, () =>
        new TenantTransactionRunner(single).run((scope: TransactionScope) =>
          scope.client.query('select 1'),
        ),
      );
      await new SystemTransactionRunner(single).run((scope: TransactionScope) =>
        scope.client.query('select 1'),
      );
      const after: { rows: unknown[] } = await single.query(
        `select current_setting('app.organization_id', true) as organization,
                current_setting('app.system_access', true) as system,
                (select count(*)::int from tasks) as visible`,
      );

      expect(after.rows[0]).toEqual({ organization: '', system: '', visible: 0 });
    } finally {
      await single.end();
    }
  });

  it('rolls back everything when the work fails and returns the connection', async () => {
    const single: pg.Pool = new pg.Pool({ connectionString: database.appUrl, max: 1 });
    const runner: TenantTransactionRunner = new TenantTransactionRunner(single);
    try {
      await expect(
        as(ATELIER_NORD, () =>
          runner.run(async (scope: TransactionScope) => {
            await scope.client.query('insert into tasks (organization_id, title) values ($1, $2)', [
              ATELIER_NORD,
              'never-committed',
            ]);
            throw new Error('use case failed');
          }),
        ),
      ).rejects.toThrow('use case failed');
      const visible: string[] = await as(ATELIER_NORD, () =>
        runner.run(async (scope: TransactionScope) =>
          titles(await scope.client.query('select title from tasks')),
        ),
      );

      expect(visible).toEqual(['CAD-482', 'CAD-483']);
      expect(single.totalCount - single.idleCount).toBe(0);
    } finally {
      await single.end();
    }
  });

  it('joins the current transaction of the same organization and fails as one', async () => {
    const identities: unknown[] = await as(ATELIER_NORD, () =>
      tenant.run(async (outer: TransactionScope) => {
        const first: { rows: unknown[] } = await outer.client.query(
          'select pg_backend_pid() as pid, txid_current()::text as tx',
        );
        const second: { rows: unknown[] } = await tenant.run((inner: TransactionScope) => {
          expect(inner).toBe(outer);
          expect(getActiveTransaction()).toBe(outer);
          return inner.client.query('select pg_backend_pid() as pid, txid_current()::text as tx');
        });
        return [first.rows[0], second.rows[0]];
      }),
    );
    await expect(
      as(ATELIER_NORD, () =>
        tenant.run(async (outer: TransactionScope) => {
          await outer.client.query('insert into tasks (organization_id, title) values ($1, $2)', [
            ATELIER_NORD,
            'outer-write',
          ]);
          await tenant.run(() => Promise.reject(new Error('inner failed')));
        }),
      ),
    ).rejects.toThrow('inner failed');

    expect(identities[0]).toEqual(identities[1]);
    expect(scopeTitles(await database.admin.query('select title from tasks'))).not.toContain(
      'outer-write',
    );
    expect(getActiveTransaction()).toBeUndefined();
  });

  it('refuses to change access inside a transaction', async () => {
    await expect(
      as(ATELIER_NORD, () => tenant.run(() => system.run(() => Promise.resolve('widened')))),
    ).rejects.toThrow(/system transaction cannot start inside a tenant transaction/u);
    await expect(
      system.run(() => as(ATELIER_NORD, () => tenant.run(() => Promise.resolve('narrowed')))),
    ).rejects.toThrow(/tenant transaction cannot start inside a system transaction/u);
    await expect(
      as(ATELIER_NORD, () =>
        tenant.run(() => as(OTHER_ORGANIZATION, () => tenant.run(() => Promise.resolve('other')))),
      ),
    ).rejects.toThrow(/another organization/u);
  });

  it('refuses to start without an organization or with an id that is not a UUID', async () => {
    await expect(tenant.run(() => Promise.resolve('no context'))).rejects.toThrow(
      /No organization in the current context/u,
    );
    await expect(
      as('org-atelier-nord', () => tenant.run(() => Promise.resolve('bad id'))),
    ).rejects.toThrow(/not a UUID/u);
  });

  it('keeps concurrent organizations apart on a shared pool', async () => {
    const seen: string[][] = await Promise.all(
      [ATELIER_NORD, OTHER_ORGANIZATION, ATELIER_NORD, OTHER_ORGANIZATION].map(
        (organizationId: string) =>
          as(organizationId, () =>
            tenant.run(async (scope: TransactionScope) => {
              await scope.client.query('select pg_sleep(0.05)');
              return titles(await scope.client.query('select title from tasks'));
            }),
          ),
      ),
    );

    expect(seen).toEqual([['CAD-482', 'CAD-483'], ['OPS-1'], ['CAD-482', 'CAD-483'], ['OPS-1']]);
  });

  it('honours the read-only and isolation options', async () => {
    await expect(
      as(ATELIER_NORD, () =>
        tenant.run(
          (scope: TransactionScope) =>
            scope.client.query('insert into tasks (organization_id, title) values ($1, $2)', [
              ATELIER_NORD,
              'read-only',
            ]),
          { readOnly: true },
        ),
      ),
    ).rejects.toThrow(/read-only transaction/u);
    const level: { rows: unknown[] } = await system.run(
      (scope: TransactionScope) => scope.client.query('show transaction_isolation'),
      { isolationLevel: 'repeatable read' },
    );

    expect(level.rows[0]).toEqual({ transaction_isolation: 'repeatable read' });
  });
});

/**
 * Function scopeTitles
 *
 * @description
 * Reads the titles returned by an administrative query, unsorted.
 *
 * @param {{ rows: unknown[] }} result - Result of a query on `tasks`.
 * @returns {string[]} The titles.
 */
function scopeTitles(result: { rows: unknown[] }): string[] {
  return (result.rows as { title: string }[]).map((row) => row.title);
}
