import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { baseConfigShape } from '../../config/base-config.js';
import { ConfigError, loadConfig } from '../../config/load-config.js';
import { runApplication, type StartupErrorStream } from './run-application.js';

/**
 * Interface Outcome
 *
 * @description
 * What one run reported: the lines written and the exit codes asked for.
 */
interface Outcome {
  // #region Properties
  /**
   * Property chunks
   *
   * @description
   * Chunks written to the error stream, in order.
   *
   * @type {string[]}
   * @readonly
   */
  readonly chunks: string[];

  /**
   * Property exits
   *
   * @description
   * Codes the run asked the process to exit with.
   *
   * @type {number[]}
   * @readonly
   */
  readonly exits: number[];
  // #endregion
}

/**
 * Function run
 *
 * @description
 * Runs a start-up through `runApplication` with recording seams.
 *
 * @param {() => Promise<void>} main - Start-up to run.
 * @returns {Promise<Outcome>} What the run wrote and asked.
 */
async function run(main: () => Promise<void>): Promise<Outcome> {
  const outcome: Outcome = { chunks: [], exits: [] };
  const stderr: StartupErrorStream = {
    write: (chunk: string, callback: (error?: Error | null) => void): boolean => {
      outcome.chunks.push(chunk);
      setImmediate(callback);
      return true;
    },
  };
  await runApplication(
    {
      service: 'task-service',
      version: '1.4.0',
      stderr,
      exit: (code: number): void => {
        outcome.exits.push(code);
      },
    },
    main,
  );
  return outcome;
}

describe('runApplication', () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it('runs the start-up and reports nothing when it succeeds', async () => {
    let started: boolean = false;
    const outcome: Outcome = await run(() => {
      started = true;
      return Promise.resolve();
    });

    expect(started).toBe(true);
    expect(outcome).toEqual({ chunks: [], exits: [] });
    expect(process.exitCode).toBeUndefined();
  });

  it('reports an invalid configuration as one JSON line that names the variables, never a value', async () => {
    const secret: string = 'short-secret-value';
    const outcome: Outcome = await run(() => {
      loadConfig(z.object({ ...baseConfigShape, API_SECRET: z.string().min(32) }), {
        API_SECRET: secret,
      });
      return Promise.resolve();
    });

    expect(outcome.chunks).toHaveLength(1);
    const chunk: string = outcome.chunks[0] ?? '';
    expect(chunk.endsWith('\n')).toBe(true);
    expect(chunk.trimEnd().includes('\n')).toBe(false);
    const line: Record<string, unknown> = JSON.parse(chunk) as Record<string, unknown>;
    expect(line).toMatchObject({
      level: 'fatal',
      service: 'task-service',
      version: '1.4.0',
      msg: 'start-up failed',
      err: {
        type: 'ConfigError',
        issues: ['PORT: required, not set', expect.stringMatching(/^API_SECRET: /u)],
      },
    });
    expect(new Date(line.time as string).toISOString()).toBe(line.time);
    expect(chunk).not.toContain(secret);
    expect(outcome.exits).toEqual([1]);
    expect(process.exitCode).toBe(1);
  });

  it('sanitizes any other error as the logs do', async () => {
    const outcome: Outcome = await run(() => {
      const error: Error & { password?: string; connectionString?: string } = new Error(
        'cannot reach the database for ops@cadenway.example',
      );
      error.password = 'hunter2-hunter2';
      error.connectionString = 'postgres://svc:hunter2-hunter2@10.0.0.12/tasks';
      return Promise.reject(error);
    });

    const chunk: string = outcome.chunks[0] ?? '';
    const line: Record<string, unknown> = JSON.parse(chunk) as Record<string, unknown>;
    expect(line.err).toMatchObject({
      type: 'Error',
      password: '[REDACTED]',
      connectionString: '[REDACTED]',
      message: 'cannot reach the database for [REDACTED]',
    });
    expect(chunk).not.toContain('hunter2');
    expect(chunk).not.toContain('ops@cadenway.example');
    expect(outcome.exits).toEqual([1]);
    expect(process.exitCode).toBe(1);
  });

  it('keeps the issues of a configuration error the application built itself', async () => {
    const outcome: Outcome = await run(() =>
      Promise.reject(new ConfigError(['PORT: required, not set'])),
    );

    expect(JSON.parse(outcome.chunks[0] ?? '{}')).toMatchObject({
      err: { type: 'ConfigError', issues: ['PORT: required, not set'] },
    });
  });

  it('keeps the SQLSTATE without the database cause text in the start-up log', async () => {
    const databaseError = Object.assign(new Error('diagnostic fixture\ncontinuation fixture'), {
      severity: 'ERROR',
      code: '23505',
      detail: 'row detail fixture',
    });
    const outcome: Outcome = await run(() =>
      Promise.reject(new Error('Schema preflight failed', { cause: databaseError })),
    );

    const chunk: string = outcome.chunks[0] ?? '';
    const line = JSON.parse(chunk) as { err?: { stack?: string } };
    expect(line).toMatchObject({ err: { message: 'Database operation failed.', code: '23505' } });
    expect(line.err?.stack).toContain('at ');
    expect(chunk).not.toMatch(/diagnostic fixture|continuation fixture|row detail fixture/u);
  });

  it('keeps the machine code of a start-up error and masks the two-step secrets it holds', async () => {
    const outcome: Outcome = await run(() =>
      Promise.reject(
        Object.assign(new Error('listen EADDRINUSE: address already in use :::3000'), {
          code: 'EADDRINUSE',
          answer: { code: '261845', trustedDeviceToken: 'trusted-device-token-fixture' },
        }),
      ),
    );

    const chunk: string = outcome.chunks[0] ?? '';
    expect(JSON.parse(chunk)).toMatchObject({
      err: {
        code: 'EADDRINUSE',
        answer: { code: '[REDACTED]', trustedDeviceToken: '[REDACTED]' },
      },
    });
    expect(chunk).not.toMatch(/261845|trusted-device-token-fixture/u);
  });
});
