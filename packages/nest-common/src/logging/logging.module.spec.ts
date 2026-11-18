import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Post,
  Req,
  Res,
  type INestApplication,
} from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import pino from 'pino';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { HealthModule } from '../health/health.module.js';
import { ProblemException } from '../problem/problem.js';
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
 * Constant SESSION_COOKIE_VALUE
 *
 * @description
 * Fixture value of the `__Host-cw_session` cookie, which must never reach a line.
 *
 * @type {string}
 */
const SESSION_COOKIE_VALUE: string = 'session-cookie-fixture';

/**
 * Constant TRUSTED_DEVICE_COOKIE_VALUE
 *
 * @description
 * Fixture value of the `__Host-cw_trusted_device` cookie, which must never reach a line.
 *
 * @type {string}
 */
const TRUSTED_DEVICE_COOKIE_VALUE: string = 'trusted-device-cookie-fixture';

/**
 * Interface TwoStepBody
 *
 * @description
 * A body of the two-step verification exchanges of contracts 0.8.0 (public `auth.yaml` and
 * internal `identity-service.yaml`), with fixture values.
 */
interface TwoStepBody {
  // #region Properties
  /**
   * Property name
   *
   * @description
   * Contract schema the body follows.
   *
   * @type {string}
   * @readonly
   */
  readonly name: string;

  /**
   * Property body
   *
   * @description
   * The body, as a handler receives or returns it.
   *
   * @type {Record<string, unknown>}
   * @readonly
   */
  readonly body: Record<string, unknown>;

  /**
   * Property logged
   *
   * @description
   * What a line carrying the body must show instead.
   *
   * @type {Record<string, unknown>}
   * @readonly
   */
  readonly logged: Record<string, unknown>;

  /**
   * Property secrets
   *
   * @description
   * Fixture values of the body that must never reach a line.
   *
   * @type {readonly string[]}
   * @readonly
   */
  readonly secrets: readonly string[];
  // #endregion
}

/**
 * Constant TWO_STEP_BODIES
 *
 * @description
 * Bodies carrying every secret of two-step verification, and the passwords and tokens around it.
 *
 * @type {readonly TwoStepBody[]}
 */
const TWO_STEP_BODIES: readonly TwoStepBody[] = [
  {
    name: 'AuthenticatorAppAnswer',
    body: { token: 'challenge-token-fixture', code: '261845', trustDevice: true },
    logged: { token: REDACTED, code: REDACTED, trustDevice: true },
    secrets: ['challenge-token-fixture', '261845'],
  },
  {
    name: 'BackupCodeAnswer',
    body: { token: 'challenge-token-fixture', code: '4F7K-2M9Q', trustDevice: false },
    logged: { token: REDACTED, code: REDACTED, trustDevice: false },
    secrets: ['challenge-token-fixture', '4F7K-2M9Q'],
  },
  {
    name: 'SecurityKeyAnswer',
    body: {
      token: 'challenge-token-fixture',
      credential: {
        id: 'credential-id-fixture',
        type: 'public-key',
        response: {
          clientDataJSON: 'client-data-fixture',
          authenticatorData: 'authenticator-data-fixture',
          signature: 'signature-fixture',
        },
      },
    },
    logged: { token: REDACTED, credential: REDACTED },
    secrets: ['challenge-token-fixture', 'credential-id-fixture', 'signature-fixture'],
  },
  {
    name: 'SecurityKeyAddition',
    body: {
      name: 'YubiKey 5C NFC',
      credential: {
        id: 'credential-id-fixture',
        response: { attestationObject: 'attestation-fixture' },
      },
    },
    logged: { name: 'YubiKey 5C NFC', credential: REDACTED },
    secrets: ['credential-id-fixture', 'attestation-fixture'],
  },
  {
    name: 'PasswordSignIn (internal)',
    body: {
      email: 'camille.martin@ateliernord.example',
      password: 'password-fixture',
      trustedDeviceToken: 'trusted-device-token-fixture',
    },
    logged: { email: REDACTED, password: REDACTED, trustedDeviceToken: REDACTED },
    secrets: ['ateliernord.example', 'password-fixture', 'trusted-device-token-fixture'],
  },
  {
    name: 'AuthenticatorAppSetup',
    body: {
      secret: 'TOTPSECRETFIXTURE',
      otpauthUri: 'otpauth://totp/Cadenway:fixture?secret=TOTPSECRETFIXTURE&issuer=Cadenway',
      expiresAt: '2026-11-09T08:00:00Z',
    },
    logged: { secret: REDACTED, otpauthUri: REDACTED, expiresAt: '2026-11-09T08:00:00Z' },
    secrets: ['TOTPSECRETFIXTURE'],
  },
  {
    name: 'AuthenticatorAppConfigured',
    body: {
      twoStepVerification: { enabled: true },
      backupCodes: { codes: ['BACK-UP01', 'BACK-UP02'], generatedAt: '2026-11-09T08:00:00Z' },
    },
    logged: { twoStepVerification: { enabled: true }, backupCodes: REDACTED },
    secrets: ['BACK-UP01', 'BACK-UP02'],
  },
  {
    name: 'BackupCodes',
    body: { codes: ['BACK-UP03', 'BACK-UP04'], generatedAt: '2026-11-09T08:00:00Z' },
    logged: { codes: REDACTED, generatedAt: '2026-11-09T08:00:00Z' },
    secrets: ['BACK-UP03', 'BACK-UP04'],
  },
  {
    name: 'SessionIssued with TrustedDevice (internal)',
    body: {
      token: 'session-token-fixture',
      trustedDevice: { token: 'device-token-fixture', expiresAt: '2026-12-09T08:00:00Z' },
    },
    logged: { token: REDACTED, trustedDevice: { token: REDACTED } },
    secrets: ['session-token-fixture', 'device-token-fixture'],
  },
  {
    name: 'PasswordResetConfirmation',
    body: { token: 'reset-token-fixture', newPassword: 'new-password-fixture' },
    logged: { token: REDACTED, newPassword: REDACTED },
    secrets: ['reset-token-fixture', 'new-password-fixture'],
  },
  {
    name: 'PasswordChange',
    body: { currentPassword: 'current-password-fixture', newPassword: 'new-password-fixture' },
    logged: { currentPassword: REDACTED, newPassword: REDACTED },
    secrets: ['current-password-fixture', 'new-password-fixture'],
  },
  {
    name: 'ReauthenticationRequest',
    body: { code: '731406' },
    logged: { code: REDACTED },
    secrets: ['731406'],
  },
];

/**
 * Function databaseError
 *
 * @description
 * Builds an error shaped as the PostgreSQL driver throws it for a unique violation: its `detail`
 * quotes the offending row, here an e-mail address.
 *
 * @returns {Error} A database error fixture.
 */
function databaseError(): Error {
  return Object.assign(
    new Error('duplicate key value violates unique constraint "users_email_key"'),
    {
      severity: 'ERROR',
      code: '23505',
      detail: 'Key (email)=(camille.martin@ateliernord.example) already exists.',
      table: 'users',
    },
  );
}

/**
 * Function cookiesOf
 *
 * @description
 * Parses a `Cookie` header into a map from cookie name to value, as a cookie parser would.
 *
 * @param {string | undefined} header - Value of the `Cookie` header.
 * @returns {Record<string, string>} The cookies by name.
 */
function cookiesOf(header: string | undefined): Record<string, string> {
  return Object.fromEntries(
    (header ?? '')
      .split(';')
      .filter((pair: string) => pair.includes('='))
      .map((pair: string) => {
        const separator: number = pair.indexOf('=');
        return [pair.slice(0, separator).trim(), pair.slice(separator + 1).trim()];
      }),
  );
}

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

  /** Emits a wrapped SQL error through the normal logger serializer. */
  @Get(':sampleId/sql-error')
  public logSqlError(): { ok: boolean } {
    const cause = Object.assign(new Error('Diagnostic fixture\nContinuation fixture'), {
      query: 'query fixture',
      params: ['param fixture'],
      severity: 'ERROR',
      code: '23505',
    });
    this.logger.error({ err: new Error('Work failed', { cause }) }, 'database failure');
    return { ok: true };
  }

  /**
   * Method answer
   *
   * @description
   * Logs the body, the headers and the cookies of the request, as a careless handler would, and
   * answers 200.
   *
   * @param {unknown} body - Parsed JSON body.
   * @param {Record<string, string | undefined>} headers - Headers of the request.
   * @returns {{ ok: boolean }} A fixed body.
   */
  @Post(':sampleId/two-step')
  @HttpCode(200)
  public answer(
    @Body() body: unknown,
    @Headers() headers: Record<string, string | undefined>,
  ): { ok: boolean } {
    this.logger.info({ body, headers, cookies: cookiesOf(headers.cookie) }, 'two-step request');
    return { ok: true };
  }

  /**
   * Method logTwoStepFailure
   *
   * @description
   * Logs an error with a machine code that holds a one-time code in one of its members.
   *
   * @returns {{ ok: boolean }} A fixed body.
   */
  @Get(':sampleId/two-step-error')
  public logTwoStepFailure(): { ok: boolean } {
    const error: Error = Object.assign(new Error('Identity service unreachable'), {
      code: 'ECONNREFUSED',
      answer: { code: '261845' },
    });
    this.logger.error({ err: error }, 'two-step failure');
    return { ok: true };
  }

  /**
   * Method logHeldErrors
   *
   * @description
   * Logs database errors under a key other than `err`, in a plain member, and as the cause of a
   * `ProblemException`, which NestJS also keeps in its plain `options` member.
   *
   * @returns {{ ok: boolean }} A fixed body.
   */
  @Get(':sampleId/held-errors')
  public logHeldErrors(): { ok: boolean } {
    this.logger.error(
      { error: databaseError(), failure: { cause: databaseError() } },
      'held errors',
    );
    this.logger.error(
      {
        err: new ProblemException({
          status: 503,
          code: 'upstream.failed',
          detail: 'A service this request depends on is not available.',
          cause: databaseError(),
        }),
      },
      'problem with a cause',
    );
    return { ok: true };
  }

  /**
   * Method logBindings
   *
   * @description
   * Binds sensitive values to the request logger with `assign()`, to a child with `child()` and
   * with `setBindings()`, and to a context of the root logger with `runInContext()`, then writes
   * one line through each.
   *
   * @returns {{ ok: boolean }} A fixed body.
   */
  @Get(':sampleId/bindings')
  public logBindings(): { ok: boolean } {
    this.logger.assign({
      token: 'assign-token-fixture',
      user: { email: 'camille.martin@ateliernord.example', id: 'user-1' },
    });
    this.logger.info('assigned line');
    const child: pino.Logger = this.logger.logger.child({
      Access_Token: 'child-token-fixture',
      failure: databaseError(),
    });
    child.info('child line');
    child.setBindings({ password: 'bound-password-fixture' });
    child.info('rebound line');
    this.logger.runInContext(
      () => {
        this.logger.info('context line');
      },
      { bindings: { secret: 'context-secret-fixture' } },
    );
    return { ok: true };
  }

  /**
   * Method logInterpolated
   *
   * @description
   * Interpolates sensitive objects and an error into the message with `%j`, `%o` and `%s`.
   *
   * @returns {{ ok: boolean }} A fixed body.
   */
  @Get(':sampleId/interpolated')
  public logInterpolated(): { ok: boolean } {
    this.logger.info(
      'answer %j from %o after %s',
      { code: '261845' },
      { email: 'camille.martin@ateliernord.example', token: 'interpolated-token-fixture' },
      new Error('No mailbox for camille.martin@ateliernord.example'),
    );
    return { ok: true };
  }

  /**
   * Method logErrorsWithoutMessage
   *
   * @description
   * Logs errors without a message, so the message of the line comes from the error: a failed
   * query whose message quotes its parameters, and an error whose message holds an address.
   *
   * @returns {{ ok: boolean }} A fixed body.
   */
  @Get(':sampleId/errors-without-message')
  public logErrorsWithoutMessage(): { ok: boolean } {
    this.logger.error(
      Object.assign(new Error('Failed query: select $1\nparams: query-param-fixture'), {
        query: 'select $1',
        params: ['query-param-fixture'],
      }),
    );
    this.logger.error({ err: new Error('No mailbox for camille.martin@ateliernord.example') });
    return { ok: true };
  }

  /**
   * Method logRequestObjects
   *
   * @description
   * Logs the request and the response objects themselves, as a careless handler would.
   *
   * @param {IncomingMessage} incoming - The request being handled.
   * @param {ServerResponse} outgoing - Its response.
   * @returns {{ ok: boolean }} A fixed body.
   */
  @Get(':sampleId/request-objects')
  public logRequestObjects(
    @Req() incoming: IncomingMessage,
    @Res({ passthrough: true }) outgoing: ServerResponse,
  ): { ok: boolean } {
    this.logger.info({ request: incoming, response: outgoing }, 'request objects');
    this.logger.info({ req: incoming, res: outgoing }, 'request objects under req');
    this.logger.info(incoming, 'request as the line');
    return { ok: true };
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

  it.each(TWO_STEP_BODIES)(
    'masks the secrets of a $name body, its cookie header and its cookies by name',
    async ({ body, logged, secrets }: TwoStepBody) => {
      await request(app.getHttpServer())
        .post('/samples/42/two-step')
        .set('X-Request-Id', 'gateway-req-0002')
        .set(
          'Cookie',
          `__Host-cw_session=${SESSION_COOKIE_VALUE}; __Host-cw_trusted_device=${TRUSTED_DEVICE_COOKIE_VALUE}`,
        )
        .send(body)
        .expect(200);

      const line: LogLine | undefined = lines.find((entry) => entry.msg === 'two-step request');
      expect(line).toMatchObject({
        body: logged,
        headers: { cookie: REDACTED },
        cookies: { '__Host-cw_session': REDACTED, '__Host-cw_trusted_device': REDACTED },
      });
      const output: string = raw.join('');
      for (const value of [...secrets, SESSION_COOKIE_VALUE, TRUSTED_DEVICE_COOKIE_VALUE]) {
        expect(output).not.toContain(value);
      }
    },
  );

  it('masks every secret of two-step verification in a logged object, at any depth', async () => {
    const logger: PinoLogger = await app.resolve(PinoLogger);
    const keys: readonly string[] = [
      'trustedDeviceToken',
      'otpauthUri',
      'secret',
      'code',
      'codes',
      'backupCodes',
      'credential',
      '__Host-cw_session',
      '__Host-cw_trusted_device',
    ];
    const secrets: Record<string, string> = Object.fromEntries(
      keys.map((key: string) => [key, `${key}-value-fixture`]),
    );
    const masked: Record<string, string> = Object.fromEntries(
      keys.map((key: string) => [key, REDACTED]),
    );

    logger.info({ ...secrets, nested: { items: [secrets] } }, 'two-step object');

    expect(lines.find((line) => line.msg === 'two-step object')).toMatchObject({
      ...masked,
      nested: { items: [masked] },
    });
    expect(raw.join('')).not.toContain('-value-fixture');
  });

  it('keeps the machine code of a logged error and masks a one-time code it holds', async () => {
    await request(app.getHttpServer()).get('/samples/42/two-step-error').expect(200);

    expect(lines.find((line) => line.msg === 'two-step failure')).toMatchObject({
      err: { code: 'ECONNREFUSED', answer: { code: REDACTED } },
    });
    expect(raw.join('')).not.toContain('261845');
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

  it('preserves a wrapped SQLSTATE and stack frames without logging multiline SQL data', async () => {
    await request(app.getHttpServer()).get('/samples/42/sql-error').expect(200);

    const failure = lines.find((line) => line.msg === 'database failure');
    expect(failure).toMatchObject({
      err: {
        message: 'Database operation failed.',
        code: '23505',
      },
    });
    expect((failure?.err as Record<string, unknown> | undefined)?.stack).toContain(
      'at SampleController.logSqlError',
    );
    expect(raw.join('')).not.toMatch(
      /diagnostic fixture|continuation fixture|query fixture|param fixture/iu,
    );
  });

  it('writes an error held under another key or in a plain member as a logged error', async () => {
    await request(app.getHttpServer()).get('/samples/42/held-errors').expect(200);

    const held: LogLine | undefined = lines.find((line) => line.msg === 'held errors');
    const sanitized: Record<string, unknown> = {
      type: 'Error',
      message: 'Database operation failed.',
      code: '23505',
      table: 'users',
    };
    expect(held).toMatchObject({ error: sanitized, failure: { cause: sanitized } });
    expect(lines.find((line) => line.msg === 'problem with a cause')).toMatchObject({
      err: { type: 'ProblemException', options: { cause: sanitized } },
    });
    expect(raw.join('')).not.toMatch(/ateliernord\.example|already exists/u);
  });

  it('masks what child(), setBindings(), assign() and runInContext() bind to a logger', async () => {
    await request(app.getHttpServer())
      .get('/samples/42/bindings')
      .set('X-Request-Id', 'gateway-req-0003')
      .expect(200);

    expect(lines.find((line) => line.msg === 'assigned line')).toMatchObject({
      requestId: 'gateway-req-0003',
      token: REDACTED,
      user: { email: REDACTED, id: 'user-1' },
    });
    expect(lines.find((line) => line.msg === 'child line')).toMatchObject({
      Access_Token: REDACTED,
      failure: { message: 'Database operation failed.', code: '23505' },
    });
    expect(lines.find((line) => line.msg === 'rebound line')).toMatchObject({
      password: REDACTED,
    });
    expect(lines.find((line) => line.msg === 'context line')).toMatchObject({ secret: REDACTED });
    expect(raw.join('')).not.toMatch(
      /assign-token-fixture|child-token-fixture|bound-password-fixture|context-secret-fixture|ateliernord\.example/u,
    );
  });

  it('masks the objects and errors interpolated into a message', async () => {
    await request(app.getHttpServer()).get('/samples/42/interpolated').expect(200);

    expect(lines.find((line) => String(line.msg).startsWith('answer'))).toMatchObject({
      msg: `answer {"code":"${REDACTED}"} from {"email":"${REDACTED}","token":"${REDACTED}"} after Error: No mailbox for ${REDACTED}`,
    });
    expect(raw.join('')).not.toMatch(/261845|interpolated-token-fixture|ateliernord\.example/u);
  });

  it('masks the message taken from an error logged without one', async () => {
    await request(app.getHttpServer()).get('/samples/42/errors-without-message').expect(200);

    expect(lines.map((line) => line.msg)).toEqual([
      'Database operation failed.',
      `No mailbox for ${REDACTED}`,
      'request completed',
    ]);
    expect(raw.join('')).not.toMatch(/query-param-fixture|ateliernord\.example/u);
  });

  it('writes a logged request or response object as its method, route and status only', async () => {
    await request(app.getHttpServer())
      .get('/samples/42/request-objects?token=query-secret-fixture')
      .set('X-Request-Id', 'gateway-req-0004')
      .set('Authorization', 'Bearer bearer-secret-fixture')
      .set('Cookie', `__Host-cw_session=${SESSION_COOKIE_VALUE}`)
      .expect(200);

    const summary: Record<string, unknown> = {
      id: 'gateway-req-0004',
      method: 'GET',
      route: '/samples/:sampleId/request-objects',
    };
    expect(lines.find((line) => line.msg === 'request objects')).toEqual(
      expect.objectContaining({ request: summary, response: { statusCode: 200 } }),
    );
    expect(lines.find((line) => line.msg === 'request objects under req')).toEqual(
      expect.objectContaining({ req: summary, res: { statusCode: 200 } }),
    );
    expect(lines.find((line) => line.msg === 'request as the line')).toEqual(
      expect.objectContaining({ req: summary }),
    );
    const output: string = raw.join('');
    for (const value of [
      'bearer-secret-fixture',
      SESSION_COOKIE_VALUE,
      'query-secret-fixture',
      '127.0.0.1',
      'rawHeaders',
    ]) {
      expect(output).not.toContain(value);
    }
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

  it.each([
    ['trustedDeviceToken', 'trusted_device_token'],
    ['otpauthUri', 'OTPAUTH-URI'],
    ['code', 'Code'],
    ['codes', 'CODES'],
    ['backupCodes', 'backup_codes'],
    ['credential', 'Credential'],
    ['__Host-cw_session', '__host-cw-session'],
    ['__Host-cw_trusted_device', '__HOST_CW_TRUSTED_DEVICE'],
  ])('masks %s at any depth, also spelled %s', (key: string, spelling: string) => {
    const value: string = `${key}-value-fixture`;

    const sanitized: unknown = sanitizeLogValue(
      { [key]: value, body: { [spelling]: value }, items: [{ answer: { [key]: { value } } }] },
      redactedKeySet(),
    );

    expect(sanitized).toEqual({
      [key]: REDACTED,
      body: { [spelling]: REDACTED },
      items: [{ answer: { [key]: REDACTED } }],
    });
    expect(JSON.stringify(sanitized)).not.toContain(value);
  });

  it('keeps the code of an error and of the errors it holds, never the code of a plain object', () => {
    const inner: Error = Object.assign(new Error('Reset by the peer'), { code: 'ECONNRESET' });
    const outer: AggregateError = Object.assign(new AggregateError([inner], 'Every call failed'), {
      code: 'ERR_CALLS_FAILED',
      last: Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' }),
      answer: { code: '261845' },
    });

    expect(sanitizeSerializedError(pino.stdSerializers.err(outer), redactedKeySet())).toMatchObject(
      {
        code: 'ERR_CALLS_FAILED',
        last: { code: 'ETIMEDOUT' },
        aggregateErrors: [{ code: 'ECONNRESET' }],
        answer: { code: REDACTED },
      },
    );
    expect(
      sanitizeSerializedError({ message: 'not an error', code: '261845' }, redactedKeySet()),
    ).toEqual({ message: 'not an error', code: REDACTED });
  });

  it('counts the depth limit of an error it holds from the outer error', () => {
    const inner: Error = Object.assign(new Error('Inner'), {
      a: { b: { c: { d: { e: { f: 'deep' } } } } },
    });
    const outer: Error = Object.assign(new Error('Outer'), { inner });

    expect(sanitizeSerializedError(pino.stdSerializers.err(outer), redactedKeySet())).toMatchObject(
      { inner: { a: { b: { c: { d: { e: REDACTED } } } } } },
    );
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
          message: 'Failed query: select $1\nparams: param fixture\ncontinuation fixture',
          stack:
            'DrizzleQueryError: Failed query: select $1\nparams: param fixture\ncontinuation fixture\n    at file.ts:1:1',
          query: 'select $1',
          params: ['param fixture\ncontinuation fixture'],
          detail: 'row detail fixture',
          where: 'SQL statement',
          code: '23505',
        },
        redactedKeySet(),
      ),
    ).toEqual({
      type: 'DrizzleQueryError',
      message: 'Database operation failed.',
      stack: 'Database operation failed.\n    at file.ts:1:1',
      code: '23505',
    });
  });

  it('masks every e-mail address of a text', () => {
    expect(maskEmails('from a.b+c@x.example to d@y.z.example')).toBe(
      `from ${REDACTED} to ${REDACTED}`,
    );
    expect(maskEmails('Camille.Martin@AtelierNord.FR wrote')).toBe(`${REDACTED} wrote`);
  });

  it('keeps the versions of a pnpm store path readable', () => {
    const frame: string =
      'at file:///app/node_modules/.pnpm/@cadenway+nest-common@0.3.0_zod@4.6.7/node_modules/@cadenway/nest-common/dist/index.js:1:1';

    expect(maskEmails(frame)).toBe(frame);
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
