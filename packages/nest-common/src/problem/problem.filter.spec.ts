import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  Param,
  Patch,
  Post,
  Logger,
  Query,
  type ArgumentsHost,
  type INestApplication,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { z } from 'zod';

import {
  assertVersionMatch,
  EtagInterceptor,
  IfMatch,
  type IfMatchCondition,
} from '../http/concurrency/etag.js';
import { applyJsonBodyLimit } from '../http/body/body-limit.js';
import { pageQueryShape, type PageQuery } from '../pagination/cursor.js';
import { zodDto, ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { ProblemFilter, toProblem, WS_EXCEPTION_EVENT } from './problem.filter.js';
import { ProblemException, type Problem } from './problem.js';

/**
 * Constant MALFORMED_BODIES
 *
 * @description
 * Bodies that are not valid JSON, by the mistake they make. The text of `JSON.parse` for some of
 * them quotes the characters around the faulty token.
 *
 * @type {readonly (readonly [string, string])[]}
 */
const MALFORMED_BODIES: readonly (readonly [string, string])[] = [
  ['an unquoted value', '{"password": hunter2-secret}'],
  ['single quotes', "{'password':'x'}"],
  ['a trailing comma', '{"password": "hunter2-secret",}'],
  ['a truncated body', '{"password": "hunter2'],
  ['a top-level string refused by strict mode', '"password hunter2-secret"'],
];

/**
 * Constant MALFORMED_JSON_PROBLEM
 *
 * @description
 * Response every body that is not valid JSON receives.
 *
 * @type {Problem}
 */
const MALFORMED_JSON_PROBLEM: Problem = {
  type: 'about:blank',
  title: 'Bad Request',
  status: 400,
  code: 'request.invalid',
  detail: 'The request body is not valid JSON.',
  details: {
    issues: [{ in: 'body', path: '', code: 'invalid_json', message: 'Expected valid JSON.' }],
  },
};

/**
 * Function parseFailure
 *
 * @description
 * Builds the error the body parser of Express raises for a body that is not valid JSON: a
 * `SyntaxError` with the text of `JSON.parse`, the body, and the members of `http-errors`.
 *
 * @param {string} body - Body that failed to parse.
 * @returns {SyntaxError} The error.
 */
function parseFailure(body: string): SyntaxError {
  return Object.assign(new SyntaxError(`Unexpected token 'h', "${body}" is not valid JSON`), {
    body,
    type: 'entity.parse.failed',
    status: 400,
    statusCode: 400,
    expose: true,
  });
}

/**
 * Interface ListQuery
 *
 * @description
 * Query string of the sample list route.
 */
interface ListQuery extends PageQuery {
  // #region Properties
  /**
   * Property status
   *
   * @description
   * Optional filter of the sample list.
   *
   * @type {'open' | 'closed' | undefined}
   * @readonly
   */
  readonly status?: 'open' | 'closed' | undefined;
  // #endregion
}

/**
 * Constant listQuerySchema
 *
 * @description
 * Schema of the sample list query, composed from the pagination shape.
 *
 * @type {z.ZodType<ListQuery>}
 */
const listQuerySchema: z.ZodType<ListQuery> = z.object({
  ...pageQueryShape,
  status: z.enum(['open', 'closed']).optional(),
});

/**
 * Class ListQueryDto
 *
 * @description
 * Parameter type validated by the global pipe.
 */
class ListQueryDto extends zodDto(listQuerySchema) {}

/**
 * Constant titleSchema
 *
 * @description
 * Schema of the sample write bodies.
 *
 * @type {z.ZodType<{ title: string }>}
 */
const titleSchema: z.ZodType<{ title: string }> = z.object({ title: z.string().min(1).max(200) });

/**
 * Class SampleController
 *
 * @description
 * Routes exercising the error format, validation, entity tags and the body limit.
 */
@Controller('samples')
class SampleController {
  // #region Methods
  /**
   * Method list
   *
   * @description
   * Echoes the validated query.
   *
   * @param {ListQueryDto} query - Query validated by the global pipe.
   * @returns {ListQuery} The parsed query.
   */
  @Get()
  public list(@Query() query: ListQueryDto): ListQuery {
    return query;
  }

  /**
   * Method create
   *
   * @description
   * Echoes a body validated by a per-parameter pipe.
   *
   * @param {{ title: string }} body - Validated body.
   * @returns {{ title: string; version: number }} The created sample.
   */
  @Post()
  public create(@Body(new ZodValidationPipe(titleSchema)) body: { title: string }): {
    title: string;
    version: number;
  } {
    return { title: body.title, version: 0 };
  }

  /**
   * Method read
   *
   * @description
   * Returns a sample at version 7, or fails the way its id asks.
   *
   * @param {string} sampleId - Id naming the behavior to trigger.
   * @returns {{ id: string; version: number }} The sample.
   */
  @Get(':sampleId')
  public read(@Param('sampleId') sampleId: string): { id: string; version: number } {
    if (sampleId === 'missing') {
      throw new ProblemException({
        status: 404,
        code: 'sample.not-found',
        detail: 'No such sample in this organization.',
      });
    }
    if (sampleId === 'broken') {
      throw new Error('connection to 10.0.0.12 refused with password hunter2');
    }
    if (sampleId === 'teapot') {
      throw new HttpException('I am a teapot', 418);
    }
    if (sampleId === 'gateway') {
      throw new HttpException('upstream detail', 502);
    }
    return { id: sampleId, version: 7 };
  }

  /**
   * Method update
   *
   * @description
   * Updates a sample stored at version 7 under an optional or mandatory `If-Match`.
   *
   * @param {string} sampleId - `long-text` makes the header mandatory.
   * @param {IfMatchCondition} condition - Parsed `If-Match` header.
   * @returns {{ id: string; version: number }} The sample at its new version.
   */
  @Patch(':sampleId')
  public update(
    @Param('sampleId') sampleId: string,
    @IfMatch() condition: IfMatchCondition,
  ): { id: string; version: number } {
    assertVersionMatch(condition, 7, { required: sampleId === 'long-text' });
    return { id: sampleId, version: 8 };
  }
  // #endregion
}

describe('HTTP formats', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [SampleController],
    }).compile();
    const created: NestExpressApplication = moduleRef.createNestApplication();
    applyJsonBodyLimit(created);
    created.useGlobalFilters(new ProblemFilter());
    created.useGlobalPipes(new ZodValidationPipe());
    created.useGlobalInterceptors(new EtagInterceptor());
    app = created;
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('problem filter', () => {
    it('writes a thrown problem as application/problem+json', async () => {
      const response: Response = await request(app.getHttpServer())
        .get('/samples/missing')
        .expect(404);

      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/u);
      expect(response.body).toEqual({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        code: 'sample.not-found',
        detail: 'No such sample in this organization.',
      });
    });

    it('answers 500 without any internal text for an unexpected error', async () => {
      const response: Response = await request(app.getHttpServer())
        .get('/samples/broken')
        .expect(500);

      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/u);
      expect(response.body).toEqual({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        code: 'internal.unexpected',
      });
      expect(response.text).not.toContain('hunter2');
      expect(response.text).not.toContain('at ');
    });

    it('answers 404 with a stable code for an unknown route', async () => {
      const response: Response = await request(app.getHttpServer()).get('/nowhere').expect(404);

      expect(response.body).toMatchObject({ status: 404, code: 'http.not-found' });
    });

    it('maps a status outside the contract to the nearest allowed one', async () => {
      const teapot: Response = await request(app.getHttpServer())
        .get('/samples/teapot')
        .expect(400);
      const gateway: Response = await request(app.getHttpServer())
        .get('/samples/gateway')
        .expect(503);

      expect(teapot.body).toMatchObject({ status: 400, code: 'http.bad-request' });
      expect(gateway.body).toEqual({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: 503,
        code: 'http.service-unavailable',
      });
    });

    it.each(MALFORMED_BODIES)(
      'answers %s with the fixed 400 request.invalid and nothing of the body',
      async (_mistake: string, body: string) => {
        const response: Response = await request(app.getHttpServer())
          .post('/samples')
          .set('Content-Type', 'application/json')
          .send(body)
          .expect(400);

        expect(response.headers['content-type']).toMatch(/^application\/problem\+json/u);
        expect(response.body).toEqual(MALFORMED_JSON_PROBLEM);
        expect(response.text).not.toContain('hunter2');
        expect(response.text).not.toContain('password');
      },
    );

    it('keeps the mapping of the other refusals of the body parser', async () => {
      const charset: Response = await request(app.getHttpServer())
        .post('/samples')
        .set('Content-Type', 'application/json; charset=latin1')
        .send('{"title": "x"}')
        .expect(400);

      expect(charset.body).toEqual({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        code: 'http.bad-request',
        detail: 'unsupported charset "LATIN1"',
      });
    });

    it('answers 400 request.body-too-large beyond 1 MB and accepts a body just under', async () => {
      const refused: Response = await request(app.getHttpServer())
        .post('/samples')
        .send({ title: 'x', padding: 'p'.repeat(1_048_576) })
        .expect(400);
      await request(app.getHttpServer())
        .post('/samples')
        .send({ title: 'x', padding: 'p'.repeat(900_000) })
        .expect(201);

      expect(refused.body).toMatchObject({ status: 400, code: 'request.body-too-large' });
    });
  });

  describe('validation pipe', () => {
    it('parses a valid query and applies the pagination default', async () => {
      const response: Response = await request(app.getHttpServer())
        .get('/samples?status=open')
        .expect(200);

      expect(response.body).toEqual({ status: 'open', limit: 50 });
    });

    it('answers 400 to an unknown query parameter', async () => {
      const response: Response = await request(app.getHttpServer())
        .get('/samples?status=open&colour=red')
        .expect(400);

      expect(response.body).toEqual({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        code: 'request.invalid',
        detail: 'The request does not match its contract.',
        details: {
          issues: [
            {
              in: 'query',
              path: 'colour',
              code: 'unrecognized_parameter',
              message: 'Unknown query parameter.',
            },
          ],
        },
      });
    });

    it('lists every issue of an invalid query without echoing the values', async () => {
      const response: Response = await request(app.getHttpServer())
        .get('/samples?limit=500&status=archived-secret-value')
        .expect(400);

      const issues: { path: string }[] = (
        response.body as { details: { issues: { path: string }[] } }
      ).details.issues;
      expect(issues.map((issue) => issue.path).sort()).toEqual(['limit', 'status']);
      expect(response.text).not.toContain('archived-secret-value');
    });

    it('validates a body with a per-parameter schema', async () => {
      const response: Response = await request(app.getHttpServer())
        .post('/samples')
        .send({ title: '' })
        .expect(400);

      expect(response.body).toMatchObject({
        code: 'request.invalid',
        details: { issues: [{ in: 'body', path: 'title' }] },
      });
    });
  });

  describe('entity tags', () => {
    it('returns the version of the aggregate as its ETag', async () => {
      const response: Response = await request(app.getHttpServer()).get('/samples/42').expect(200);

      expect(response.headers.etag).toBe('"7"');
    });

    it('accepts a matching If-Match, a wildcard and an absent header', async () => {
      await request(app.getHttpServer()).patch('/samples/42').set('If-Match', '"7"').expect(200);
      await request(app.getHttpServer())
        .patch('/samples/42')
        .set('If-Match', '"3", "7"')
        .expect(200);
      await request(app.getHttpServer()).patch('/samples/42').set('If-Match', '*').expect(200);
      const absent: Response = await request(app.getHttpServer()).patch('/samples/42').expect(200);

      expect(absent.headers.etag).toBe('"8"');
    });

    it('answers 412 to a stale or weak If-Match', async () => {
      const stale: Response = await request(app.getHttpServer())
        .patch('/samples/42')
        .set('If-Match', '"6"')
        .expect(412);
      await request(app.getHttpServer()).patch('/samples/42').set('If-Match', 'W/"7"').expect(412);

      expect(stale.body).toMatchObject({
        status: 412,
        code: 'precondition.failed',
        details: { currentVersion: 7 },
      });
    });

    it('answers 400 to a malformed If-Match and to a missing mandatory one', async () => {
      const malformed: Response = await request(app.getHttpServer())
        .patch('/samples/42')
        .set('If-Match', '7')
        .expect(400);
      const missing: Response = await request(app.getHttpServer())
        .patch('/samples/long-text')
        .expect(400);

      expect((malformed.body as Problem).code).toBe('request.if-match-invalid');
      expect((missing.body as Problem).code).toBe('request.if-match-required');
    });
  });
});

describe('a malformed JSON body without applyJsonBodyLimit', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [SampleController],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new ProblemFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('gets the fixed problem through the JSON parser NestJS registers itself', async () => {
    const response: Response = await request(app.getHttpServer())
      .post('/samples')
      .set('Content-Type', 'application/json')
      .send('{"password": hunter2-secret}')
      .expect(400);

    expect(response.body).toEqual(MALFORMED_JSON_PROBLEM);
    expect(response.text).not.toContain('hunter2');
  });
});

describe('toProblem', () => {
  it('gives a parse failure, raw or wrapped by NestJS, the fixed problem without its text', () => {
    const failure: SyntaxError = parseFailure('{"password": hunter2-secret}');

    const problems: Problem[] = [
      toProblem(failure),
      toProblem(new BadRequestException(failure.message, { cause: failure })),
    ];

    expect(problems).toEqual([MALFORMED_JSON_PROBLEM, MALFORMED_JSON_PROBLEM]);
    expect(JSON.stringify(problems)).not.toContain('hunter2');
  });

  it('keeps the message of any other client error', () => {
    expect(toProblem(new BadRequestException('The header X-Sample is missing.'))).toEqual({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      code: 'http.bad-request',
      detail: 'The header X-Sample is missing.',
    });
  });
});

/**
 * Function hostOf
 *
 * @description
 * Builds the arguments host of a message in another transport than HTTP, as NestJS hands it to
 * an exception filter.
 *
 * @param {'ws' | 'rpc'} type - Transport of the message.
 * @param {unknown} client - Client of the message, such as a Socket.IO socket.
 * @returns {ArgumentsHost} The host.
 */
function hostOf(type: 'ws' | 'rpc', client: unknown): ArgumentsHost {
  return {
    getType: () => type,
    getArgs: () => [client, {}],
    getArgByIndex: (index: number) => [client, {}][index],
    switchToHttp: () => {
      throw new Error('not an HTTP request');
    },
    switchToRpc: () => ({ getData: () => ({}), getContext: () => client }),
    switchToWs: () => ({
      getClient: () => client,
      getData: () => ({}),
      getPattern: () => 'tasks:watch',
    }),
  } as unknown as ArgumentsHost;
}

describe('ProblemFilter outside HTTP', () => {
  const filter: ProblemFilter = new ProblemFilter();

  it('emits the problem of a WebSocket message to its client as the event exception', () => {
    const emitted: [string, unknown][] = [];
    const socket: { emit(event: string, payload: unknown): boolean } = {
      emit: (event: string, payload: unknown): boolean => {
        emitted.push([event, payload]);
        return true;
      },
    };

    filter.catch(
      new ProblemException({ status: 403, code: 'room.join-forbidden', detail: 'Not a member.' }),
      hostOf('ws', socket),
    );
    filter.catch(new HttpException('Too many messages', 429), hostOf('ws', socket));

    expect(emitted).toEqual([
      [
        WS_EXCEPTION_EVENT,
        {
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          code: 'room.join-forbidden',
          detail: 'Not a member.',
        },
      ],
      [
        'exception',
        {
          type: 'about:blank',
          title: 'Too Many Requests',
          status: 429,
          code: 'http.too-many-requests',
          detail: 'Too many messages',
        },
      ],
    ]);
  });

  it('emits no internal text and no stack for an unexpected error of a WebSocket message', () => {
    const emitted: unknown[] = [];
    const socket: { emit(event: string, payload: unknown): void } = {
      emit: (_event: string, payload: unknown): void => {
        emitted.push(payload);
      },
    };

    const logged: MockInstance<Logger['error']> = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const failure: Error = new Error('password hunter2 rejected by 10.0.0.12');

    filter.catch(failure, hostOf('ws', socket));
    const calls: unknown[][] = [...logged.mock.calls];
    logged.mockRestore();

    expect(emitted).toEqual([
      {
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        code: 'internal.unexpected',
      },
    ]);
    expect(JSON.stringify(emitted)).not.toContain('hunter2');
    expect(calls).toEqual([[{ err: failure }, 'websocket message failed']]);
  });

  it('ignores a WebSocket client that cannot receive events', () => {
    expect(() => {
      filter.catch(new ProblemException({ status: 404, code: 'task.not-found' }), hostOf('ws', {}));
    }).not.toThrow();
  });

  it('throws the error of an RPC message again, untouched', () => {
    const error: Error = new Error('handled by the transport');

    expect(() => {
      filter.catch(error, hostOf('rpc', {}));
    }).toThrow(error);
  });
});
