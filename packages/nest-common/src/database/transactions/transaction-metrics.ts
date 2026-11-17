import { metrics, type Histogram, type Meter, type MeterProvider } from '@opentelemetry/api';

/**
 * Interface TransactionMetrics
 *
 * @description
 * Instruments for the checkout and connection-holding phases of a transaction.
 */
interface TransactionMetrics {
  // #region Properties
  /**
   * Property poolAcquireDuration
   *
   * @description
   * Records successful and failed acquisition times.
   *
   * @type {Histogram}
   * @readonly
   */
  readonly poolAcquireDuration: Histogram;

  /**
   * Property transactionDuration
   *
   * @description
   * Records time spent holding an acquired connection.
   *
   * @type {Histogram}
   * @readonly
   */
  readonly transactionDuration: Histogram;
  // #endregion
}

/**
 * Property instruments
 *
 * @description
 * Caches transaction instruments for the active meter provider and refreshes them when the SDK starts.
 *
 * @type {{ readonly provider: MeterProvider; readonly metrics: TransactionMetrics; } | undefined}
 */
let instruments:
  { readonly provider: MeterProvider; readonly metrics: TransactionMetrics } | undefined;

/**
 * Function transactionMetrics
 *
 * @description
 * Returns instruments for the currently installed provider, including SDK startup after import.
 *
 * @returns {TransactionMetrics} Histograms attached to the current meter provider.
 */
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
