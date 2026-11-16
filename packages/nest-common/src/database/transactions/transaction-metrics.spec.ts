import { EventEmitter } from 'node:events';

import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import type { Pool } from 'pg';
import { expect, it, vi } from 'vitest';

import { SystemTransactionRunner } from './system-transaction-runner.js';
import { assertNoActiveTransaction } from './transaction-context.js';

it('records pool wait and connection holding time separately, once per physical transaction', async () => {
  const exporter: InMemoryMetricExporter = new InMemoryMetricExporter(
    AggregationTemporality.CUMULATIVE,
  );
  const provider: MeterProvider = new MeterProvider({
    readers: [new PeriodicExportingMetricReader({ exporter })],
  });
  expect(metrics.setGlobalMeterProvider(provider)).toBe(true);
  let clock: number = 0;
  const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const connection = Object.assign(new EventEmitter(), {
    query(statement: string): Promise<{ command: string; rows: unknown[] }> {
      clock += 2;
      return Promise.resolve({ command: statement, rows: [] });
    },
    release: vi.fn(),
  });
  const connect = vi.fn(() => {
    clock += 17;
    return Promise.resolve(connection);
  });
  const runner: SystemTransactionRunner = new SystemTransactionRunner({
    connect,
  } as unknown as Pool);

  try {
    expect(assertNoActiveTransaction).not.toThrow();
    await runner.run(async (outer) => {
      expect(assertNoActiveTransaction).toThrow('must run outside an active transaction');
      await runner.run((joined) => {
        expect(joined).toBe(outer);
        clock += 50;
        return Promise.resolve();
      });
    });
    expect(assertNoActiveTransaction).not.toThrow();
    await expect(runner.run(() => Promise.reject(new Error('work failed')))).rejects.toThrow(
      'work failed',
    );
    expect(assertNoActiveTransaction).not.toThrow();
    connect.mockImplementationOnce(() => {
      clock += 27;
      return Promise.reject(new Error('pool timed out'));
    });
    await expect(runner.run(() => Promise.resolve())).rejects.toThrow('pool timed out');
    expect(connection.release).toHaveBeenCalledTimes(2);

    await provider.forceFlush();
    const measured: MetricData[] = exporter
      .getMetrics()
      .flatMap((resource) =>
        resource.scopeMetrics
          .filter(({ scope }) => scope.name === '@cadenway/nest-common')
          .flatMap(({ metrics: recorded }) => recorded),
      );
    const checkout = measured.find(
      ({ descriptor }) => descriptor.name === 'cadenway.postgres.pool.acquire.duration',
    );
    const transaction = measured.find(
      ({ descriptor }) => descriptor.name === 'cadenway.postgres.transaction.duration',
    );
    expect(checkout?.descriptor.unit).toBe('ms');
    expect(transaction?.descriptor.unit).toBe('ms');
    expect(checkout?.dataPointType).toBe(DataPointType.HISTOGRAM);
    expect(transaction?.dataPointType).toBe(DataPointType.HISTOGRAM);
    expect(checkout?.dataPoints).toMatchObject([
      { attributes: { kind: 'system', outcome: 'success' }, value: { count: 2, sum: 34 } },
      { attributes: { kind: 'system', outcome: 'error' }, value: { count: 1, sum: 27 } },
    ]);
    expect(transaction?.dataPoints).toMatchObject([
      { attributes: { kind: 'system', outcome: 'success' }, value: { count: 1, sum: 56 } },
      { attributes: { kind: 'system', outcome: 'error' }, value: { count: 1, sum: 6 } },
    ]);
    for (const { dataPoints } of measured) {
      for (const point of dataPoints) {
        expect(Object.keys(point.attributes).sort()).toEqual(['kind', 'outcome']);
      }
    }
  } finally {
    now.mockRestore();
    metrics.disable();
    await provider.shutdown();
  }
});
