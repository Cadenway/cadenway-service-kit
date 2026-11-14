import { Controller, Get, HttpException, type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { HealthModule } from '../health/health.module.js';
import { createLoggerParams, LoggingModule } from './logging.module.js';
import {
  maskEmails,
  REDACTED,
  redactedKeySet,
  sanitizeLogValue,
  sanitizeSerializedError,
} from './redaction.js';
import { resolveRequestId } from './request-id.js';

/**
 * Type LogLine
 *
 * @description
 * One parsed JSON log line.
 *
 * @type {Record<string, unknown>}
 */
type LogLine = Record<string, unknown>;

/**
 * Constant lines
 *
 * @description
 * Lines written by the application under test, in order.
 *
 * @type {LogLine[]}
 */
const lines: LogLine[] = [];

/**
 * Constant raw
 *
 * @description
 * The same lines as written, to search for text that must never appear.
 *
 * @type {string[]}
 */
const raw: string[] = [];

/**
 * Class SampleController
 *
 * @description
 * Routes used to observe what a request leaves in the logs.
 */
@Controller('samples')
class SampleController {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Receives the request-scoped logger.
   *
   * @param {PinoLogger} logger - Logger bound to the current request.
   * @constructor
   */
  public constructor(private readonly logger: PinoLogger) {}
  // #endregion

  // #region Methods
  /**
   * Method read
   *
   * @description
   * Logs sensitive values on purpose and answers 200.
   *
   * @returns {{ ok: boolean }} A fixed body.
   */
  @Get(':sampleId')
  public read(): { ok: boolean } {
    this.logger.info(
      {
        password: 'hunter2',
        user: { email: 'camille.martin@ateliernord.example', name: 'Camille' },
        request: { headers: { authorization: 'Bearer abc', 'set-cookie': 'session=1' } },
        extraSecret: 'only-masked-on-request',
      },
      'Invitation sent to camille.martin@ateliernord.example',
    );
    return { ok: true };
  }

  /**
   * Method fail
   *
   * @description
   * Fails with a server error whose message carries an e-mail address.
   *
   * @returns {never} Never returns.
   */
  @Get(':sampleId/failure')
  public fail(): never {
    throw new HttpException('No mailbox for camille.martin@ateliernord.example', 503);
  }
  // #endregion
}

describe('LoggingModule', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        LoggingModule.forRoot({
          service: 'sample-service',
          version: '1.2.3',
          redactKeys: ['extraSecret'],
          destination: {
            write: (line: string): void => {
              raw.push(line);
              lines.push(JSON.parse(line) as LogLine);
            },
          },
        }),
        HealthModule,
      ],
      controllers: [SampleController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  beforeEach(() => {
    lines.length = 0;
    raw.length = 0;
  });

  afterAll(async () => {
    await app.close();
  });

  it('writes one completion line with the documented fields', async () => {
    const response: Response = await request(app.getHttpServer())
      .get('/samples/42?token=secret-in-query')
      .set('X-Request-Id', 'gateway-req-0001')
      .expect(200);

    expect(response.headers['x-request-id']).toBe('gateway-req-0001');
    const completion: LogLine | undefined = lines.find((line) => line.msg === 'request completed');
    expect(completion).toMatchObject({
      level: 'info',
      service: 'sample-service',
      version: '1.2.3',
      requestId: 'gateway-req-0001',
      method: 'GET',
      route: '/samples/:sampleId',
      status: 200,
    });
    expect(typeof completion?.durationMs).toBe('number');
    expect(typeof completion?.time).toBe('string');
    expect(completion).not.toHaveProperty('req');
    expect(completion).not.toHaveProperty('res');
  });

  it('never writes a query string, a header or an address', async () => {
    await request(app.getHttpServer())
      .get('/samples/42?token=secret-in-query')
      .set('Authorization', 'Bearer header-secret')
      .set('Cookie', 'session=cookie-secret')
      .expect(200);

    const output: string = raw.join('');
    expect(output).not.toContain('secret-in-query');
    expect(output).not.toContain('header-secret');
    expect(output).not.toContain('cookie-secret');
    expect(output).not.toContain('127.0.0.1');
    expect(output).not.toContain('remoteAddress');
  });

  it('masks tokens, passwords, cookies, the authorization header and e-mail addresses', async () => {
    await request(app.getHttpServer()).get('/samples/42').expect(200);

    const line: LogLine | undefined = lines.find((entry) => 'password' in entry);
    expect(line).toMatchObject({
      password: REDACTED,
      user: { email: REDACTED, name: 'Camille' },
      request: { headers: { authorization: REDACTED, 'set-cookie': REDACTED } },
      extraSecret: REDACTED,
      msg: `Invitation sent to ${REDACTED}`,
    });
    expect(raw.join('')).not.toContain('ateliernord.example');
    expect(line?.requestId).toEqual(expect.any(String));
  });

  it('logs a server error at error level without the e-mail address of its message', async () => {
    await request(app.getHttpServer()).get('/samples/42/failure').expect(503);

    const failure: LogLine | undefined = lines.find((line) => line.msg === 'request failed');
    expect(failure).toMatchObject({
      level: 'error',
      route: '/samples/:sampleId/failure',
      status: 503,
    });
    expect(raw.join('')).not.toContain('ateliernord.example');
  });

  it('generates a request id when the caller sends none or a malformed one', async () => {
    const absent: Response = await request(app.getHttpServer()).get('/samples/42').expect(200);
    const malformed: Response = await request(app.getHttpServer())
      .get('/samples/42')
      .set('X-Request-Id', 'bad id\twith spaces')
      .expect(200);

    expect(absent.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/u);
    expect(malformed.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('logs an unmatched path with a null route and does not log probes', async () => {
    await request(app.getHttpServer()).get('/nowhere/secret-path-value').expect(404);
    await request(app.getHttpServer()).get('/health/live').expect(200);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'warn', route: null, status: 404 });
    expect(raw.join('')).not.toContain('secret-path-value');
  });
});

describe('createLoggerParams', () => {
  it('refuses pretty logs in production', () => {
    expect(() => createLoggerParams({ service: 's', version: '1', pretty: true })).toThrow(
      /refused when NODE_ENV=production/u,
    );
  });
});

describe('redaction helpers', () => {
  it('masks a redacted key at any depth, whatever its case and separators', () => {
    expect(
      sanitizeLogValue(
        {
          access_token: 'a',
          Authorization: 'b',
          'Set-Cookie': 'c',
          DATABASE_URL: 'postgres://svc:secret@db/task',
          data: { users: [{ email: 'camille@ateliernord.example', id: 'user-1' }] },
          note: 'write to camille@ateliernord.example',
          count: 3,
        },
        redactedKeySet(['note-internal']),
      ),
    ).toEqual({
      access_token: REDACTED,
      Authorization: REDACTED,
      'Set-Cookie': REDACTED,
      DATABASE_URL: REDACTED,
      data: { users: [{ email: REDACTED, id: 'user-1' }] },
      note: `write to ${REDACTED}`,
      count: 3,
    });
  });

  it('masks whole whatever is nested deeper than six levels', () => {
    expect(
      sanitizeLogValue({ a: { b: { c: { d: { e: { f: { g: 'deep' } } } } } } }, redactedKeySet()),
    ).toEqual({ a: { b: { c: { d: { e: { f: REDACTED } } } } } });
  });

  it('drops the SQL values of a failed query from a serialized error', () => {
    expect(
      sanitizeSerializedError(
        {
          type: 'DrizzleQueryError',
          message:
            'Failed query: insert into "users" ("email", "password_hash") values ($1, $2)\nparams: camille@ateliernord.example,$argon2id$hash',
          stack:
            'Error: Failed query: insert into "users"\nparams: camille@ateliernord.example,$argon2id$hash\n    at file.ts:1:1',
          query: 'insert into "users" ("email", "password_hash") values ($1, $2)',
          params: ['camille@ateliernord.example', '$argon2id$hash'],
          detail: 'Key (email)=(camille@ateliernord.example) already exists.',
          where: 'SQL statement',
          code: '23505',
        },
        redactedKeySet(),
      ),
    ).toEqual({
      type: 'DrizzleQueryError',
      message: 'Failed query: insert into "users" ("email", "password_hash") values ($1, $2)',
      stack: 'Error: Failed query: insert into "users"\n    at file.ts:1:1',
      code: '23505',
    });
  });

  it('masks every e-mail address of a text', () => {
    expect(maskEmails('from a.b+c@x.example to d@y.z.example')).toBe(
      `from ${REDACTED} to ${REDACTED}`,
    );
  });
});

describe('resolveRequestId', () => {
  it('keeps a well-formed incoming id only when accepted', () => {
    expect(resolveRequestId('abc-12345')).toBe('abc-12345');
    expect(resolveRequestId('abc-12345', false)).not.toBe('abc-12345');
    expect(resolveRequestId(['abc-12345', 'def-67890'])).toMatch(/^[0-9a-f-]{36}$/u);
    expect(resolveRequestId('short')).toMatch(/^[0-9a-f-]{36}$/u);
  });
});
