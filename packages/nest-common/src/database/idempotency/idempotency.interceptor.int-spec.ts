import {
  Body,
  Controller,
  Post,
  Res,
  UseInterceptors,
  type INestApplication,
  type Provider,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runWithOrganizationContext } from '../../auth/context/organization-context.js';
import { InternalAccess } from '../../auth/internal-token/internal-token.guard.js';
import { InternalTokenSigner } from '../../auth/internal-token/internal-token-signer.js';
import type { Ed25519PrivateJwk } from '../../auth/internal-token/internal-token.js';
import { InternalTokenModule } from '../../auth/internal-token/internal-token.module.js';
import { EtagInterceptor } from '../../http/concurrency/etag.js';
import { ProblemFilter } from '../../problem/problem.filter.js';
import { ProblemException } from '../../problem/problem.js';
import { generateSigningJwk, publicJwkOf } from '../../testing/internal-token-keys.js';
import { kitMigration, startTestDatabase, type TestDatabase } from '../../testing/postgres.js';
import { purgeExpiredIdempotencyKeyBatch } from '../index.js';
import { SystemTransactionRunner } from '../transactions/system-transaction-runner.js';
import { TenantTransactionRunner } from '../transactions/tenant-transaction-runner.js';
import type { TransactionScope } from '../transactions/transaction-contracts.js';
import { DatabaseModule } from '../wiring/database.module.js';
import { Idempotent, purgeExpiredIdempotencyKeys } from './idempotency.interceptor.js';
import idempotencyKeys from './idempotency.schema.js';

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
   * Method createForActor
   *
   * @description
   * Creates a task with the idempotency key scoped to the verified actor.
   *
   * @param {{ title: string }} body - Title of the task.
   * @param {{ setHeader(name: string, value: string): unknown }} response - Response, to set `Location`.
   * @returns {Promise<{ id: string; title: string; version: number }>} The created task.
   */
  @Post('actor-tasks')
  @InternalAccess({ actors: ['user', 'system'], organization: 'optional' })
  @Idempotent({ scope: 'actor' })
  public createForActor(
    @Body() body: { title: string },
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): unknown },
  ): Promise<{ id: string; title: string; version: number }> {
    return this.create(body, response);
  }

  /**
   * Method createSpace
   *
   * @description
   * Creates a space whose body has no top-level `version`, so the handler sets `ETag` itself,
   * along with a cookie the replay must not carry.
   *
   * @param {{ name: string }} body - Name of the space.
   * @param {{ setHeader(name: string, value: string): unknown }} response - Response, to set the headers.
   * @returns {Promise<{ space: { id: string; name: string; version: number } }>} The created space.
   */
  @Post('spaces')
  @Idempotent()
  public async createSpace(
    @Body() body: { name: string },
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): unknown },
  ): Promise<{ space: { id: string; name: string; version: number } }> {
    probe.runs += 1;
    const id: string = await this.insertTask(body.name);
    response.setHeader('Location', `/internal/v1/spaces/${id}`);
    response.setHeader('ETag', '"3"');
    response.setHeader('Set-Cookie', 'preference=compact');
    return { space: { id, name: body.name, version: 3 } };
  }

  /**
   * Method createList
   *
   * @description
   * Creates a list whose `ETag` an `EtagInterceptor` of the route derives from the body, inside
   * the idempotency interceptor.
   *
   * @param {{ name: string }} body - Name of the list.
   * @returns {Promise<{ id: string; name: string; version: number }>} The created list.
   */
  @Post('lists')
  @Idempotent()
  @UseInterceptors(EtagInterceptor)
  public async createList(
    @Body() body: { name: string },
  ): Promise<{ id: string; name: string; version: number }> {
    probe.runs += 1;
    const id: string = await this.insertTask(body.name);
    return { id, name: body.name, version: 4 };
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

  /**
   * Method insertTask
   *
   * @description
   * Inserts a row in the transaction of the use case, which joins the one of the interceptor.
   *
   * @param {string} title - Title of the row.
   * @returns {Promise<string>} Its id.
   */
  private insertTask(title: string): Promise<string> {
    return this.tenant.run(async (scope: TransactionScope) => {
      const inserted: { rows: unknown[] } = await scope.client.query(
        'insert into tasks (organization_id, title) values ($1, $2) returning id',
        [scope.organizationId, title],
      );
      return (inserted.rows[0] as { id: string }).id;
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
   * @param {string} actorId - Verified user ID when the call has an organization.
   * @returns {Promise<Response>} The response.
   */
  async function send(
    path: string,
    body: object,
    key: string | undefined,
    organizationId: string | null = ATELIER_NORD,
    actorId: string = 'user-camille',
  ): Promise<Response> {
    const token: string = await gateway.sign(
      'task-service',
      organizationId === null
        ? { actor: { type: 'anonymous', id: null }, organizationId: null }
        : { actor: { type: 'user', id: actorId }, organizationId },
    );
    const call: request.Test = request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${token}`);
    return key === undefined ? call.send(body) : call.set('Idempotency-Key', key).send(body);
  }

  /**
   * Function storedHeaders
   *
   * @description
   * Reads the headers stored with the response of a key.
   *
   * @param {string} key - Idempotency key.
   * @returns {Promise<unknown>} The stored `response_headers`.
   */
  async function storedHeaders(key: string): Promise<unknown> {
    const result: { rows: unknown[] } = await database.admin.query(
      'select response_headers from idempotency_keys where key = $1',
      [key],
    );
    return (result.rows[0] as { response_headers: unknown }).response_headers;
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
    // The `EtagInterceptor` of the root module wraps the `Idempotency-Key` interceptor of
    // `DatabaseModule`, as in `createApplication`.
    const providers: Provider[] = [
      { provide: Probe, useValue: probe },
      { provide: APP_INTERCEPTOR, useClass: EtagInterceptor },
    ];
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
      providers,
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

  it('replays the ETag the handler set, and neither its cookie nor any other header', async () => {
    const first: Response = await send('/internal/v1/spaces', { name: 'Produit' }, 'key-0010');
    const replay: Response = await send('/internal/v1/spaces', { name: 'Produit' }, 'key-0010');

    expect(first.headers.etag).toBe('"3"');
    expect(first.headers['set-cookie']).toEqual(['preference=compact']);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers.etag).toBe('"3"');
    expect(replay.headers.location).toBe(first.headers.location);
    expect(replay.headers['set-cookie']).toBeUndefined();
    expect(await storedHeaders('key-0010')).toEqual({
      location: first.headers.location,
      etag: '"3"',
    });
    expect(probe.runs).toBe(1);
  });

  it('replays the ETag an EtagInterceptor inside the idempotency interceptor derived', async () => {
    const first: Response = await send('/internal/v1/lists', { name: 'Sprint 12' }, 'key-0011');
    const replay: Response = await send('/internal/v1/lists', { name: 'Sprint 12' }, 'key-0011');

    expect(first.headers.etag).toBe('"4"');
    expect(replay.headers.etag).toBe('"4"');
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(await storedHeaders('key-0011')).toMatchObject({ etag: '"4"' });
    expect(probe.runs).toBe(1);
  });

  it('derives the ETag of a replay again when the EtagInterceptor wraps the idempotency one', async () => {
    const first: Response = await send('/internal/v1/tasks', { title: 'CAD-482' }, 'key-0012');
    const replay: Response = await send('/internal/v1/tasks', { title: 'CAD-482' }, 'key-0012');

    expect(first.headers.etag).toBe('"0"');
    expect(replay.headers.etag).toBe('"0"');
    expect(await storedHeaders('key-0012')).toEqual({ location: first.headers.location });
    expect(probe.runs).toBe(1);
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
    expect(concurrent.body).toMatchObject({
      status: 409,
      code: 'idempotency.request-in-progress',
      detail: 'A request with this Idempotency-Key is still running.',
    });
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

  it('does not replay a response to another member who learnt the key', async () => {
    await send('/internal/v1/tasks', { title: 'CAD-482' }, 'key-0007');
    const other: string = await gateway.sign('task-service', {
      actor: { type: 'user', id: 'user-other-member' },
      organizationId: ATELIER_NORD,
    });

    const replay: Response = await request(app.getHttpServer())
      .post('/internal/v1/tasks')
      .set('Authorization', `Bearer ${other}`)
      .set('Idempotency-Key', 'key-0007')
      .send({ title: 'CAD-482' });

    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({ code: 'idempotency.key-reused' });
    expect(probe.runs).toBe(1);
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

  it('gives verified actors independent receipts, including in separate organizations', async () => {
    const path: string = '/internal/v1/actor-tasks';
    const key: string = 'shared-actor-key';
    const body: { title: string } = { title: 'CAD-482' };
    const first: Response = await send(path, body, key);
    const otherMember: Response = await send(path, body, key, ATELIER_NORD, 'user-other-member');
    const otherOrganization: Response = await send(path, body, key, OTHER_ORGANIZATION);
    const firstReplay: Response = await send(path, body, key);
    const otherReplay: Response = await send(path, body, key, ATELIER_NORD, 'user-other-member');
    const reused: Response = await send(path, { title: 'CAD-483' }, key);

    expect([first.status, otherMember.status, otherOrganization.status]).toEqual([201, 201, 201]);
    expect(otherMember.headers['idempotent-replayed']).toBeUndefined();
    expect(otherOrganization.headers['idempotent-replayed']).toBeUndefined();
    expect(otherMember.body).not.toEqual(first.body);
    expect(otherOrganization.body).not.toEqual(first.body);
    expect(firstReplay.headers['idempotent-replayed']).toBe('true');
    expect(firstReplay.body).toEqual(first.body);
    expect(otherReplay.headers['idempotent-replayed']).toBe('true');
    expect(otherReplay.body).toEqual(otherMember.body);
    expect(reused.status).toBe(422);
    expect(reused.body).toMatchObject({ code: 'idempotency.key-reused' });
    expect(probe.runs).toBe(3);
    expect(await count('idempotency_keys')).toBe(3);
  });

  it('refuses an actor-scoped key when the signed system actor has no ID', async () => {
    const token: string = await gateway.sign('task-service', {
      actor: { type: 'system', id: null },
      organizationId: ATELIER_NORD,
    });
    const response: Response = await request(app.getHttpServer())
      .post('/internal/v1/actor-tasks')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'system-without-id')
      .send({ title: 'CAD-482' });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'auth.actor-not-allowed' });
    expect(probe.runs).toBe(0);
    expect(await count('idempotency_keys')).toBe(0);
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

  it('purges expired keys in oldest-first batches and preserves a live receipt', async () => {
    await send('/internal/v1/tasks', { title: 'CAD-482' }, 'oldest-key');
    await send('/internal/v1/tasks', { title: 'CAD-483' }, 'newer-key', OTHER_ORGANIZATION);
    await send('/internal/v1/tasks', { title: 'CAD-484' }, 'live-key');
    await database.admin.query(`
      update idempotency_keys
      set expires_at = now() - case key
        when 'oldest-key' then interval '2 seconds'
        else interval '1 second'
      end
      where key in ('oldest-key', 'newer-key')
    `);

    const system: SystemTransactionRunner = app.get(SystemTransactionRunner);
    await expect(system.run((scope) => purgeExpiredIdempotencyKeyBatch(scope, 1))).resolves.toBe(1);
    const remaining: { rows: unknown[] } = await database.admin.query(
      'select key from idempotency_keys order by key',
    );
    expect(remaining.rows).toEqual([{ key: 'live-key' }, { key: 'newer-key' }]);
    await expect(system.run((scope) => purgeExpiredIdempotencyKeyBatch(scope, 1))).resolves.toBe(1);
    await expect(system.run((scope) => purgeExpiredIdempotencyKeyBatch(scope, 1))).resolves.toBe(0);
    expect(await count('idempotency_keys')).toBe(1);
    const replay: Response = await send('/internal/v1/tasks', { title: 'CAD-484' }, 'live-key');
    expect(replay.headers['idempotent-replayed']).toBe('true');
  });

  it('skips a locked receipt during a concurrent refresh and keeps the refreshed receipt', async () => {
    await send('/internal/v1/tasks', { title: 'CAD-482' }, 'locked-key');
    await send('/internal/v1/tasks', { title: 'CAD-483' }, 'other-key');
    await database.admin.query(`
      update idempotency_keys
      set expires_at = now() - case key
        when 'locked-key' then interval '2 seconds'
        else interval '1 second'
      end
    `);

    const system: SystemTransactionRunner = app.get(SystemTransactionRunner);
    let signalLocked: () => void = (): void => undefined;
    const locked: Promise<void> = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    let releaseRefresh: () => void = (): void => undefined;
    const released: Promise<void> = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refresh: Promise<void> = system.run(async (scope) => {
      await scope.client.query(
        "update idempotency_keys set expires_at = now() + interval '1 day' where key = 'locked-key'",
      );
      signalLocked();
      await released;
    });

    try {
      await Promise.race([locked, refresh]);
      await expect(
        system.run(async (scope) => {
          await scope.client.query("set local statement_timeout = '2s'");
          return purgeExpiredIdempotencyKeyBatch(scope, 2);
        }),
      ).resolves.toBe(1);
    } finally {
      releaseRefresh();
      await refresh;
    }

    await expect(system.run((scope) => purgeExpiredIdempotencyKeyBatch(scope, 2))).resolves.toBe(0);
    const replay: Response = await send('/internal/v1/tasks', { title: 'CAD-482' }, 'locked-key');
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(await count('idempotency_keys')).toBe(1);
  });

  it('rejects a tenant scope and invalid batch limits', async () => {
    const tenant: TenantTransactionRunner = app.get(TenantTransactionRunner);
    await expect(
      runWithOrganizationContext(
        {
          organizationId: ATELIER_NORD,
          actor: { type: 'user', id: 'user-camille' },
          role: 'member',
          scopes: [],
        },
        () => tenant.run((scope) => purgeExpiredIdempotencyKeyBatch(scope, 1)),
      ),
    ).rejects.toThrow('requires a system transaction');

    const system: SystemTransactionRunner = app.get(SystemTransactionRunner);
    await system.run(async (scope) => {
      for (const limit of [0, 1.5, 1_001]) {
        await expect(purgeExpiredIdempotencyKeyBatch(scope, limit)).rejects.toThrow(RangeError);
      }
    });
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
    const tooLong: Response = await send('/internal/v1/tasks', { title: 'x' }, 'a'.repeat(256));
    const withSpace: Response = await send('/internal/v1/tasks', { title: 'x' }, 'key 0008');

    expect(await count('tasks')).toBe(2);
    expect(await count('idempotency_keys')).toBe(0);
    expect(missing.body).toMatchObject({ status: 400, code: 'idempotency.key-required' });
    for (const malformed of [tooLong, withSpace]) {
      expect(malformed.status).toBe(400);
      expect(malformed.body).toMatchObject({
        code: 'request.invalid',
        details: {
          issues: [
            {
              in: 'header',
              path: 'Idempotency-Key',
              code: 'invalid_format',
              message: 'Expected 1 to 255 printable ASCII characters.',
            },
          ],
        },
      });
    }
    expect(JSON.stringify(withSpace.body)).not.toContain('key 0008');
  });
});
