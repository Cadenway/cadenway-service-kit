import { createRequire } from 'node:module';

import { Body, Controller, Module, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApplication } from '../bootstrap/create-application.js';
import { startTelemetry } from '../telemetry/start-telemetry.js';
import { shutdownTelemetry } from '../telemetry/telemetry-handle.js';
import { startCollector, type Collector } from '../testing/otlp-collector.js';

/**
 * Constant MALFORMED_BODIES
 *
 * @description
 * Sign-in bodies that are not valid JSON, by the mistake they make. The JSON parser quotes the
 * text around an unexpected token in its message, which is how a password could leak.
 *
 * @type {readonly (readonly [string, string])[]}
 */
const MALFORMED_BODIES: readonly (readonly [string, string])[] = [
  ['an unquoted value', '{"password": hunter2-secret}'],
  ['single quotes', "{'password':'x'}"],
  ['a trailing comma', '{"password": "hunter2-secret",}'],
];

/**
 * Constant BODY_FRAGMENTS
 *
 * @description
 * Pieces of the malformed bodies that must appear in no response, log line or span.
 *
 * @type {readonly string[]}
 */
const BODY_FRAGMENTS: readonly string[] = ['password', 'hunter2'];

/**
 * Constant FIXED_PROBLEM
 *
 * @description
 * Response every malformed body receives, whatever its content.
 *
 * @type {Readonly<Record<string, unknown>>}
 */
const FIXED_PROBLEM: Readonly<Record<string, unknown>> = {
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
 * Interface ExportedSpan
 *
 * @description
 * Part of a span of an OTLP JSON export that the assertions read.
 */
interface ExportedSpan {
  // #region Properties
  /**
   * Property name
   *
   * @description
   * Span name, such as `middleware - jsonParser`.
   *
   * @type {string}
   * @readonly
   */
  readonly name: string;

  /**
   * Property events
   *
   * @description
   * Events of the span; a recorded error is the event `exception`.
   *
   * @type {readonly { readonly name: string; readonly attributes?: readonly { readonly key: string; readonly value: { readonly stringValue?: string } }[] }[] | undefined}
   * @readonly
   */
  readonly events?: readonly {
    readonly name: string;
    readonly attributes?: readonly {
      readonly key: string;
      readonly value: { readonly stringValue?: string };
    }[];
  }[];

  /**
   * Property status
   *
   * @description
   * Status of the span; an error status carries a message.
   *
   * @type {{ readonly code?: number; readonly message?: string } | undefined}
   * @readonly
   */
  readonly status?: { readonly code?: number; readonly message?: string };
  // #endregion
}

/**
 * Function exportedSpans
 *
 * @description
 * Reads every span the collector received.
 *
 * @param {readonly string[]} exports - Bodies posted to `/v1/traces`, in OTLP JSON.
 * @returns {ExportedSpan[]} The spans of every export.
 */
function exportedSpans(exports: readonly string[]): ExportedSpan[] {
  return exports.flatMap((body: string) =>
    (
      (
        JSON.parse(body) as {
          resourceSpans?: { scopeSpans?: { spans?: ExportedSpan[] }[] }[];
        }
      ).resourceSpans ?? []
    ).flatMap((resource) => (resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? [])),
  );
}

/**
 * Class SampleController
 *
 * @description
 * Route receiving a JSON body, standing in for a sign-in.
 */
@Controller('internal/v1/samples')
class SampleController {
  // #region Methods
  /**
   * Method create
   *
   * @description
   * Accepts any well-formed body.
   *
   * @param {unknown} body - Parsed body.
   * @returns {{ received: boolean }} A fixed body.
   */
  @Post()
  public create(@Body() body: unknown): { received: boolean } {
    return { received: body !== undefined };
  }
  // #endregion
}

/**
 * Class SampleModule
 *
 * @description
 * Module of the fictional application.
 */
@Module({ controllers: [SampleController] })
class SampleModule {}

describe('a malformed JSON body on an application with telemetry', () => {
  const lines: string[] = [];
  const responses: Map<string, Response> = new Map<string, Response>();
  let collector: Collector;
  let spans: ExportedSpan[];
  let wellFormed: Response;

  beforeAll(async () => {
    collector = await startCollector();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.url;
    startTelemetry({ service: 'sample-service', version: '1.2.3' });
    // Vitest loads `http` and Express as ES modules, which the require hooks of the
    // instrumentations do not see; requiring them once patches the module objects the
    // application shares, as `--import @cadenway/nest-common/register` does in a service.
    const requireHere: NodeJS.Require = createRequire(import.meta.url);
    requireHere('node:http');
    createRequire(requireHere.resolve('@nestjs/platform-express'))('express');

    const app: NestExpressApplication = await createApplication(SampleModule, {
      service: 'sample-service',
      version: '1.2.3',
      config: { LOG_LEVEL: 'trace' },
      internalTokenVerification: 'off',
      logDestination: {
        write: (line: string): void => {
          lines.push(line);
        },
      },
    });
    await app.init();
    for (const [mistake, body] of MALFORMED_BODIES) {
      responses.set(
        mistake,
        await request(app.getHttpServer())
          .post('/internal/v1/samples')
          .set('Content-Type', 'application/json')
          .send(body),
      );
    }
    // Over the 100 kB of the JSON parser NestJS adds after the one of the kit when telemetry
    // wraps the handler names: that parser must find the body read and leave it alone.
    wellFormed = await request(app.getHttpServer())
      .post('/internal/v1/samples')
      .send({ title: 'well-formed', padding: 'p'.repeat(200_000) });
    // Closing the application flushes the spans to the collector.
    await app.close();
    spans = exportedSpans(collector.received.get('/v1/traces') ?? []);
  });

  afterAll(async () => {
    await shutdownTelemetry();
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    await collector.close();
  });

  it.each(MALFORMED_BODIES)('answers %s with the fixed 400 request.invalid', (mistake: string) => {
    const response: Response | undefined = responses.get(mistake);

    expect(response?.status).toBe(400);
    expect(response?.headers['content-type']).toMatch(/^application\/problem\+json/u);
    expect(response?.body).toEqual(FIXED_PROBLEM);
    for (const fragment of BODY_FRAGMENTS) {
      expect(response?.text).not.toContain(fragment);
    }
  });

  it('still accepts a well-formed body larger than the default limit of NestJS', () => {
    expect(wellFormed.status).toBe(201);
    expect(wellFormed.body).toEqual({ received: true });
  });

  it('writes no fragment of the bodies in the logs', () => {
    const completed: Record<string, unknown>[] = lines
      .map((line: string) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === 'request completed' || line.msg === 'request failed');

    // The capture works at `trace`: the well-formed request has its completion line. A refused
    // body never reaches the request logger, which NestJS registers after the parser, so the
    // malformed requests write no line of their own; every line is still searched.
    expect(completed).toContainEqual(expect.objectContaining({ status: 201 }));
    for (const fragment of BODY_FRAGMENTS) {
      expect(lines.join('\n')).not.toContain(fragment);
    }
  });

  it('records a fixed error on the parser span and no fragment of the bodies in any span', () => {
    const exported: string = (collector.received.get('/v1/traces') ?? []).join('\n');
    const failed: ExportedSpan[] = spans.filter(
      (span: ExportedSpan) =>
        span.name === 'middleware - jsonParser' &&
        (span.events ?? []).some((event) => event.name === 'exception'),
    );
    const exceptions: Record<string, string | undefined>[] = failed.flatMap((span) =>
      (span.events ?? [])
        .filter((event) => event.name === 'exception')
        .map((event) =>
          Object.fromEntries(
            (event.attributes ?? []).map((attribute) => [
              attribute.key,
              attribute.value.stringValue,
            ]),
          ),
        ),
    );

    expect(exceptions).toHaveLength(MALFORMED_BODIES.length);
    for (const exception of exceptions) {
      expect(exception).toMatchObject({
        'exception.type': 'ProblemException',
        'exception.message': 'request.invalid: The request body is not valid JSON.',
      });
    }
    for (const span of failed) {
      expect(span.status?.message).toBe('request.invalid: The request body is not valid JSON.');
    }
    for (const fragment of BODY_FRAGMENTS) {
      expect(exported).not.toContain(fragment);
    }
  });
});
