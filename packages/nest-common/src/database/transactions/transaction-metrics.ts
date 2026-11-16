import { metrics, type Histogram, type Meter, type MeterProvider } from '@opentelemetry/api';

/** Instruments for the checkout and connection-holding phases of a transaction. */
interface TransactionMetrics {
  // #region Properties
  /** Records successful and failed acquisition times. */
  readonly poolAcquireDuration: Histogram;

  /** Records time spent holding an acquired connection. */
  readonly transactionDuration: Histogram;
  // #endregion
}

let instruments:
  { readonly provider: MeterProvider; readonly metrics: TransactionMetrics } | undefined;

/** Returns instruments for the currently installed provider, including SDK startup after import. */
export function transactionMetrics(): TransactionMetrics {
  const provider: MeterProvider = metrics.getMeterProvider();
  if (instruments?.provider === provider) {
    return instruments.metrics;
  }

  const meter: Meter = provider.getMeter('@cadenway/nest-common');
  const current: TransactionMetrics = {
    poolAcquireDuration: meter.createHistogram('cadenway.postgres.pool.acquire.duration', {
      description: 'Elapsed time waiting to acquire a PostgreSQL connection from the pool.',
      unit: 'ms',
    }),
    transactionDuration: meter.createHistogram('cadenway.postgres.transaction.duration', {
      description: 'Time a PostgreSQL connection is held by the transaction executor.',
      unit: 'ms',
    }),
  };
  instruments = { provider, metrics: current };
  return current;
}
