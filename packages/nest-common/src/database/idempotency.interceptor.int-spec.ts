import {
  Body,
  Controller,
  Post,
  Res,
  type INestApplication,
  type ValueProvider,
} from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { InternalAccess } from '../auth/internal-token.guard.js';
import { InternalTokenSigner, type Ed25519PrivateJwk } from '../auth/internal-token.js';
import { InternalTokenModule } from '../auth/internal-token.module.js';
import { ProblemFilter } from '../problem/problem.filter.js';
import { ProblemException } from '../problem/problem.js';
import { generateSigningJwk, publicJwkOf } from '../testing/internal-token-keys.js';
import { kitMigration, startTestDatabase, type TestDatabase } from '../testing/postgres.js';
import { DatabaseModule } from './database.module.js';
import { Idempotent, purgeExpiredIdempotencyKeys } from './idempotency.interceptor.js';
import idempotencyKeys from './idempotency.schema.js';
import {
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
 * Id of a second organization.
 *
 * @type {string}
 */
const OTHER_ORGANIZATION: string = '0193a1f0-0000-7000-8000-00000000000b';

/**
 * Class Probe
 *
 * @description
 * Counts handler runs and lets a spec hold a handler open.
 */
class Probe {
  // #region Properties
  /**
   * Property runs
   *
   * @description
   * Number of times a handler body ran.
   *
   * @type {number}
   */
  public runs: number = 0;

  /**
   * Property gate
   *
   * @description
   * Promise the slow handler awaits before finishing.
   *
   * @type {Promise<void>}
   */
  public gate: Promise<void> = Promise.resolve();

  /**
   * Property entered
   *
   * @description
   * Called when the slow handler has started.
   *
   * @type {() => void}
   */
  public entered: () => void = (): void => undefined;
  // #endregion
}

/**
 * Constant probe
 *
 * @description
 * Probe shared by the controller and the specs.
 *
 * @type {Probe}
 */
const probe: Probe = new Probe();

/**
 * Class TaskController
 *
 * @description
 * Idempotent routes of a fictional task service.
 */
@Controller('internal/v1')
class TaskController {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Receives the two runners, as a use case would through its unit of work.
   *
   * @param {TenantTransactionRunner} tenant - Runner of the use cases of one organization.
   * @param {SystemTransactionRunner} system - Runner of the work without an organization.
   * @constructor
   */
  public constructor(
    private readonly tenant: TenantTransactionRunner,
    private readonly system: SystemTransactionRunner,
  ) {}
  // #endregion

  // #region Methods
  /**
   * Method create
   *
   * @description
   * Creates a task in the transaction of the use case and names it in `Location`.
   *
   * @param {{ title: string }} body - Title of the task.
   * @param {{ setHeader(name: string, value: string): unknown }} response - Response, to set `Location`.
   * @returns {Promise<{ id: string; title: string; version: number }>} The created task.
   */
  @Post('tasks')
  @Idempotent()
  public async create(
    @Body() body: { title: string },
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): unknown },
  ): Promise<{ id: string; title: string; version: number }> {
    probe.runs += 1;
    const id: string = await this.tenant.run(async (scope: TransactionScope) => {
      const inserted: { rows: unknown[] } = await scope.client.query(
        'insert into tasks (organization_id, title) values ($1, $2) returning id',
        [scope.organizationId, body.title],
      );
      return (inserted.rows[0] as { id: string }).id;
    });
    response.setHeader('Location', `/internal/v1/tasks/${id}`);
    if (body.title === 'fails-after-write') {
      throw new ProblemException({ status: 422, code: 'task.rejected' });
    }
    return { id, title: body.title, version: 0 };
  }

  /**
   * Method slow
   *
   * @description
   * Stays open until the spec releases the gate.
   *
   * @returns {Promise<{ done: boolean }>} A fixed body.
   */
  @Post('slow-tasks')
  @Idempotent({ required: true })
  public async slow(): Promise<{ done: boolean }> {
    probe.runs += 1;
    probe.entered();
    await probe.gate;
    return { done: true };
  }

  /**
   * Method signUp
   *
   * @description
   * Route without an organization, served in a system transaction.
   *
   * @param {{ name: string }} body - Name to register.
   * @returns {Promise<{ id: string }>} The created sign-up.
   */
  @Post('sign-ups')
  @Idempotent()
  @InternalAccess({ actors: ['anonymous'], organization: 'optional' })
  public async signUp(@Body() body: { name: string }): Promise<{ id: string }> {
    probe.runs += 1;
    return this.system.run(async (scope: TransactionScope) => {
      const inserted: { rows: unknown[] } = await scope.client.query(
        'insert into sign_ups (name) values ($1) returning id',
        [body.name],
      );
      return { id: (inserted.rows[0] as { id: string }).id };
    });
  }
  // #endregion
}

describe('IdempotencyInterceptor', () => {
  let database: TestDatabase;
  let app: INestApplication<App>;
  let gateway: InternalTokenSigner;

  /**
   * Function send
   *
   * @description
   * Posts a body as a member of an organization, or anonymously.
   *
   * @param {string} path - Route to call.
   * @param {object} body - JSON body.
   * @param {string | undefined} key - `Idempotency-Key` to send, if any.
   * @param {string | null} organizationId - Organization of the token; `null` for an anonymous call.
   * @returns {Promise<Response>} The response.
   */
  async function send(
    path: string,
    body: object,
    key: string | undefined,
    organizationId: string | null = ATELIER_NORD,
  ): Promise<Response> {
    const token: string = await gateway.sign(
      'task-service',
      organizationId === null
        ? { actor: { type: 'anonymous', id: null }, organizationId: null }
        : { actor: { type: 'user', id: 'user-camille' }, organizationId },
    );
    const call: request.Test = request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${token}`);
    return key === undefined ? call.send(body) : call.set('Idempotency-Key', key).send(body);
  }

  /**
   * Function count
   *
   * @description
   * Counts the rows of a table, whatever the policies say.
   *
   * @param {string} table - Table to count.
   * @returns {Promise<number>} Its number of rows.
   */
  async function count(table: string): Promise<number> {
    const result: { rows: unknown[] } = await database.admin.query(
      `select count(*)::int as n from ${table}`,
    );
    return (result.rows[0] as { n: number }).n;
  }

  beforeAll(async () => {
    database = await startTestDatabase();
    await database.migrate(
      [
        ...(await kitMigration({ idempotencyKeys })),
        `create table tasks (
           id uuid primary key default uuidv7(),
           organization_id uuid not null,
           title text not null
         )`,
        'create table sign_ups (id uuid primary key default uuidv7(), name text not null)',
      ],
      ['idempotency_keys'],
    );
    const gatewayJwk: Ed25519PrivateJwk = await generateSigningJwk('gateway-2026-11');
    gateway = await InternalTokenSigner.create({ issuer: 'api-gateway', privateJwk: gatewayJwk });
    const probeProvider: ValueProvider<Probe> = { provide: Probe, useValue: probe };
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        InternalTokenModule.forRoot({
          verifier: {
            audience: 'task-service',
            trustedIssuers: { 'api-gateway': [publicJwkOf(gatewayJwk)] },
          },
        }),
        DatabaseModule.forRoot({ connectionString: database.appUrl, idempotency: true }),
      ],
      controllers: [TaskController],
      providers: [probeProvider],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new ProblemFilter());
    await app.init();
  });

  beforeEach(async () => {
    await database.admin.query('truncate tasks, sign_ups, idempotency_keys');
    probe.runs = 0;
    probe.gate = Promise.resolve();
    probe.entered = (): void => undefined;
  });

  afterAll(async () => {
    await app.close();
    await database.stop();
  });

  it('creates the table drizzle-kit generates, with row-level security enabled and forced', async () => {
    const table: { rows: unknown[] } = await database.admin.query(
      `select relrowsecurity, relforcerowsecurity,
              (select count(*)::int from pg_policies where tablename = 'idempotency_keys') as policies
         from pg_class where relname = 'idempotency_keys'`,
    );

    expect(table.rows[0]).toEqual({
      relrowsecurity: true,
      relforcerowsecurity: true,
      policies: 1,
    });
  });

  it('replays the stored response of a replayed key without running the handler again', async () => {
    const first: Response = await send('/internal/v1/tasks', { title: 'CAD-482' }, 'key-0001');
    const replay: Response = await send('/internal/v1/tasks', { title: 'CAD-482' }, 'key-0001');

    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers.location).toBe(first.headers.location);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(probe.runs).toBe(1);
    expect(await count('tasks')).toBe(1);
    expect(await count('idempotency_keys')).toBe(1);
  });

  it('answers 422 to the same key with another body', async () => {
    await send('/internal/v1/tasks', { title: 'CAD-482' }, 'key-0002');
    const reused: Response = await send('/internal/v1/tasks', { title: 'CAD-999' }, 'key-0002');

    expect(reused.status).toBe(422);
    expect(reused.body).toMatchObject({ status: 422, code: 'idempotency.key-reused' });
    expect(probe.runs).toBe(1);
    expect(await count('tasks')).toBe(1);
  });

  it('answers 409 while the first request is still running, then replays it', async () => {
    let release: () => void = (): void => undefined;
    probe.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered: Promise<void> = new Promise<void>((resolve) => {
      probe.entered = resolve;
    });
    const running: Promise<Response> = send('/internal/v1/slow-tasks', {}, 'key-0003');
    await entered;

    const concurrent: Response = await send('/internal/v1/slow-tasks', {}, 'key-0003');
    release();
    const finished: Response = await running;
    const replay: Response = await send('/internal/v1/slow-tasks', {}, 'key-0003');

    expect(concurrent.status).toBe(409);
    expect(concurrent.body).toMatchObject({ status: 409, code: 'idempotency.in-progress' });
    expect(finished.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(probe.runs).toBe(1);
  });

  it('stores nothing and rolls the use case back when the handler fails', async () => {
    const failed: Response = await send(
      '/internal/v1/tasks',
      { title: 'fails-after-write' },
      'key-0004',
    );
    const retried: Response = await send(
      '/internal/v1/tasks',
      { title: 'fails-after-write' },
      'key-0004',
    );

    expect(failed.status).toBe(422);
    expect(retried.body).toMatchObject({ code: 'task.rejected' });
    expect(probe.runs).toBe(2);
    expect(await count('tasks')).toBe(0);
    expect(await count('idempotency_keys')).toBe(0);
  });

  it('keeps the keys of two organizations apart', async () => {
    const first: Response = await send('/internal/v1/tasks', { title: 'CAD-482' }, 'key-0005');
    const other: Response = await send(
      '/internal/v1/tasks',
      { title: 'CAD-482' },
      'key-0005',
      OTHER_ORGANIZATION,
    );

    expect(other.status).toBe(201);
    expect(other.headers['idempotent-replayed']).toBeUndefined();
    expect((other.body as { id: string }).id).not.toBe((first.body as { id: string }).id);
    expect(probe.runs).toBe(2);
  });

  it('runs again once the stored response has expired, and purges expired keys', async () => {
    await send('/internal/v1/tasks', { title: 'CAD-482' }, 'key-0006');
    const stored: { rows: unknown[] } = await database.admin.query(
      "select extract(epoch from expires_at - created_at)::int as seconds from idempotency_keys where key = 'key-0006'",
    );
    await database.admin.query(
      "update idempotency_keys set expires_at = now() - interval '1 second'",
    );
    const again: Response = await send('/internal/v1/tasks', { title: 'CAD-482' }, 'key-0006');
    await database.admin.query(
      "update idempotency_keys set expires_at = now() - interval '1 second'",
    );
    const purged: number = await app
      .get(SystemTransactionRunner)
      .run((scope) => purgeExpiredIdempotencyKeys(scope));

    expect(stored.rows[0]).toEqual({ seconds: 86_400 });
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBeUndefined();
    expect(probe.runs).toBe(2);
    expect(purged).toBe(1);
    expect(await count('idempotency_keys')).toBe(0);
  });

  it('serves a request without an organization in a system transaction', async () => {
    const first: Response = await send(
      '/internal/v1/sign-ups',
      { name: 'Camille' },
      '5b0c1f0e-6a44-4a0e-8a58-0e5d0d3b7c11',
      null,
    );
    const replay: Response = await send(
      '/internal/v1/sign-ups',
      { name: 'Camille' },
      '5b0c1f0e-6a44-4a0e-8a58-0e5d0d3b7c11',
      null,
    );

    expect(first.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(probe.runs).toBe(1);
    expect(await count('sign_ups')).toBe(1);
  });

  it('runs normally without a key, and answers 400 to a missing mandatory or malformed key', async () => {
    await send('/internal/v1/tasks', { title: 'CAD-482' }, undefined);
    await send('/internal/v1/tasks', { title: 'CAD-482' }, undefined);
    const missing: Response = await send('/internal/v1/slow-tasks', {}, undefined);
    const malformed: Response = await send('/internal/v1/tasks', { title: 'x' }, 'a'.repeat(256));

    expect(await count('tasks')).toBe(2);
    expect(await count('idempotency_keys')).toBe(0);
    expect(missing.body).toMatchObject({ status: 400, code: 'idempotency.key-required' });
    expect(malformed.body).toMatchObject({ status: 400, code: 'idempotency.key-invalid' });
  });
});
