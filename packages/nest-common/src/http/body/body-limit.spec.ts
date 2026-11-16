import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { ProblemException } from '../../problem/problem.js';
import { applyJsonBodyLimit, JSON_BODY_LIMIT_BYTES } from './body-limit.js';

/**
 * Type Middleware
 *
 * @description
 * Express middleware, as `applyJsonBodyLimit` registers it.
 *
 * @type {(request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => void}
 */
type Middleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => void;

/**
 * Interface Outcome
 *
 * @description
 * What the parser handed on for one request.
 */
interface Outcome {
  // #region Properties
  /**
   * Property error
   *
   * @description
   * Error given to `next`, `undefined` when the parser handed on without one.
   *
   * @type {unknown}
   * @readonly
   */
  readonly error: unknown;

  /**
   * Property body
   *
   * @description
   * Body the parser left on the request.
   *
   * @type {unknown}
   * @readonly
   */
  readonly body: unknown;
  // #endregion
}

/**
 * Function registeredParser
 *
 * @description
 * Runs `applyJsonBodyLimit` on a host that records what it registers.
 *
 * @param {number | undefined} limitBytes - Limit given to `applyJsonBodyLimit`.
 * @returns {Middleware} The single middleware registered through `use`.
 * @throws {Error} When the host's `useBodyParser` is called, or not exactly one middleware is registered.
 */
function registeredParser(limitBytes?: number): Middleware {
  const registered: Middleware[] = [];
  applyJsonBodyLimit(
    {
      use: (handler: Middleware): void => {
        registered.push(handler);
      },
      useBodyParser: (): never => {
        throw new Error('useBodyParser must not be called on a host with use.');
      },
    },
    limitBytes,
  );
  const parser: Middleware | undefined = registered[0];
  if (parser === undefined || registered.length !== 1) {
    throw new Error('applyJsonBodyLimit must register exactly one middleware.');
  }
  return parser;
}

/**
 * Function send
 *
 * @description
 * Sends one JSON request through a parser and reports what it handed on.
 *
 * @param {Middleware} parser - Parser under test.
 * @param {string} body - Raw request body.
 * @returns {Promise<Outcome>} What the parser handed on.
 */
async function send(parser: Middleware, body: string): Promise<Outcome> {
  const outcomes: Outcome[] = [];
  const server: Server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    parser(incoming, response, (error?: unknown): void => {
      outcomes.push({ error, body: (incoming as { body?: unknown }).body });
      response.end();
    });
  });
  await request(server).post('/').set('Content-Type', 'application/json').send(body);
  const outcome: Outcome | undefined = outcomes[0];
  if (outcome === undefined) {
    throw new Error('The parser handed nothing on.');
  }
  return outcome;
}

describe('applyJsonBodyLimit', () => {
  it.each([
    ['an unquoted value', '{"password": hunter2-secret}'],
    ['single quotes', "{'password':'x'}"],
    ['a trailing comma', '{"password": "hunter2-secret",}'],
    ['a top-level string refused by strict mode', '"password hunter2-secret"'],
  ])(
    'hands on the fixed problem for %s, with no cause and nothing of the body',
    async (_mistake: string, body: string) => {
      const outcome: Outcome = await send(registeredParser(), body);

      expect(outcome.error).toBeInstanceOf(ProblemException);
      const problem: ProblemException = outcome.error as ProblemException;
      expect(problem.problem).toMatchObject({ status: 400, code: 'request.invalid' });
      expect(problem.message).toBe('request.invalid: The request body is not valid JSON.');
      expect(problem.cause).toBeUndefined();
      expect(problem).not.toHaveProperty('body');
      expect(problem).not.toHaveProperty('type');
      for (const fragment of ['password', 'hunter2']) {
        expect(problem.stack).not.toContain(fragment);
        expect(JSON.stringify(problem.getResponse())).not.toContain(fragment);
      }
    },
  );

  it('hands on a body over the limit unchanged', async () => {
    const outcome: Outcome = await send(
      registeredParser(16),
      '{"title": "longer than sixteen bytes"}',
    );

    expect(outcome.error).not.toBeInstanceOf(ProblemException);
    expect(outcome.error).toMatchObject({ status: 413, type: 'entity.too.large' });
  });

  it('parses a well-formed body and hands on without an error', async () => {
    const outcome: Outcome = await send(registeredParser(), '{"title": "Plan the sprint"}');

    expect(outcome).toEqual({ error: undefined, body: { title: 'Plan the sprint' } });
  });

  it('falls back to the parser of NestJS on a host without use', () => {
    const calls: unknown[][] = [];

    applyJsonBodyLimit({
      useBodyParser: (...args: unknown[]): void => {
        calls.push(args);
      },
    });

    expect(calls).toEqual([['json', { limit: JSON_BODY_LIMIT_BYTES }]]);
  });
});
