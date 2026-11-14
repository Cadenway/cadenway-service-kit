import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { HealthCheckResult } from '@nestjs/terminus';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, it } from 'vitest';

import { HealthModule } from './health.module.js';

/**
 * Constant healthyBody
 *
 * @description
 * Complete healthy response read by the orchestrator and dashboards.
 *
 * @type {HealthCheckResult}
 */
const healthyBody: HealthCheckResult = { status: 'ok', info: {}, error: {}, details: {} };

describe('HealthModule', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [HealthModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers 200 on the liveness route', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200, healthyBody);
  });

  it('answers 200 on the readiness route', async () => {
    await request(app.getHttpServer()).get('/health/ready').expect(200, healthyBody);
  });
});
