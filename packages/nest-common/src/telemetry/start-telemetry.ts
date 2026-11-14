import type { IncomingMessage } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import {
  context,
  metrics,
  propagation,
  trace,
  type Meter,
  type ObservableResult,
} from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor, NoopSpanProcessor } from '@opentelemetry/sdk-trace';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

import { registerTelemetryShutdown } from './telemetry-handle.js';

/**
 * Interface TelemetryOptions
 *
 * @description
 * Options of `startTelemetry`.
 */
export interface TelemetryOptions {
  // #region Properties
  /**
   * Property service
   *
   * @description
   * Name of the service or gateway, exported as `service.name`.
   *
   * @type {string}
   * @readonly
   */
  readonly service: string;

  /**
   * Property version
   *
   * @description
   * Released version of the application, exported as `service.version`.
   *
   * @type {string}
   * @readonly
   */
  readonly version: string;
  // #endregion
}

/**
 * Interface TelemetryHandle
 *
 * @description
 * Running telemetry of the process.
 */
export interface TelemetryHandle {
  // #region Properties
  /**
   * Property exporting
   *
   * @description
   * Whether spans and metrics leave the process. `false` when `OTEL_EXPORTER_OTLP_ENDPOINT` is
   * unset: spans are still created, so logs carry trace ids and `traceparent` is propagated.
   *
   * @type {boolean}
   * @readonly
   */
  readonly exporting: boolean;
  // #endregion

  // #region Methods
  /**
   * Method shutdown
   *
   * @description
   * Flushes pending spans and metrics and stops telemetry.
   *
   * @returns {Promise<void>} Resolves once telemetry is stopped.
   */
  shutdown(): Promise<void>;
  // #endregion
}

/**
 * Type IntervalHistogram
 *
 * @description
 * Histogram of event-loop delays returned by Node.
 *
 * @type {ReturnType<typeof monitorEventLoopDelay>}
 */
type IntervalHistogram = ReturnType<typeof monitorEventLoopDelay>;

/**
 * Constant ENDPOINT_VARIABLE
 *
 * @description
 * Environment variable naming the OTLP collector. Telemetry is exported if and only if it is set.
 *
 * @type {string}
 */
const ENDPOINT_VARIABLE: string = 'OTEL_EXPORTER_OTLP_ENDPOINT';

/**
 * Constant HEALTH_PATH_PREFIX
 *
 * @description
 * Path prefix of the probe routes, which are not traced.
 *
 * @type {string}
 */
const HEALTH_PATH_PREFIX: string = '/health/';

/**
 * Constant state
 *
 * @description
 * Telemetry already started in this process, so a second call does not register twice.
 *
 * @type {{ handle: TelemetryHandle | undefined }}
 */
const state: { handle: TelemetryHandle | undefined } = { handle: undefined };

/**
 * Function collectorConfigured
 *
 * @description
 * Tells whether an OTLP collector is configured, and refuses a value that is not an HTTP URL.
 *
 * @returns {boolean} `true` when `OTEL_EXPORTER_OTLP_ENDPOINT` holds an HTTP or HTTPS URL.
 * @throws {Error} When the variable is set to anything else.
 */
function collectorConfigured(): boolean {
  const endpoint: string | undefined = process.env[ENDPOINT_VARIABLE];
  if (endpoint === undefined || endpoint === '') {
    return false;
  }
  if (!URL.canParse(endpoint) || !/^https?:$/u.test(new URL(endpoint).protocol)) {
    throw new Error(`${ENDPOINT_VARIABLE} must be an http or https URL.`);
  }
  return true;
}

/**
 * Function observeEventLoopDelay
 *
 * @description
 * Registers the `nodejs.eventloop.delay.p99` gauge, in seconds, read from a Node histogram that
 * is reset at each collection.
 *
 * @returns {IntervalHistogram} The running histogram, to disable at shutdown.
 */
function observeEventLoopDelay(): IntervalHistogram {
  const histogram: IntervalHistogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const meter: Meter = metrics.getMeter('@cadenway/nest-common');
  meter
    .createObservableGauge('nodejs.eventloop.delay.p99', {
      unit: 's',
      description: '99th percentile of the event-loop delay since the previous collection.',
    })
    .addCallback((result: ObservableResult) => {
      result.observe(histogram.percentile(99) / 1e9);
      histogram.reset();
    });
  return histogram;
}

/**
 * Function startTelemetry
 *
 * @description
 * Starts the OpenTelemetry SDK of a Cadenway backend. Call it from the `telemetry.js` module the
 * process preloads, before anything imports `http`, Express, `pg`, `ioredis` or `fetch`:
 * `node --experimental-loader=@cadenway/nest-common/hook.mjs --import ./telemetry.js dist/main.js`.
 *
 * It instruments HTTP, Express, pg, ioredis and undici, propagates `traceparent` (W3C), and
 * exports traces and metrics as OTLP over HTTP to `OTEL_EXPORTER_OTLP_ENDPOINT`. When that
 * variable is unset nothing leaves the process. Probe routes under `/health/` are not traced. A
 * second call returns the handle of the first.
 *
 * @param {TelemetryOptions} options - Identity of the application.
 * @returns {TelemetryHandle} The running telemetry.
 * @throws {Error} When `OTEL_EXPORTER_OTLP_ENDPOINT` is set but is not an HTTP or HTTPS URL.
 */
export function startTelemetry(options: TelemetryOptions): TelemetryHandle {
  if (state.handle !== undefined) {
    return state.handle;
  }
  const exporting: boolean = collectorConfigured();
  const sdk: NodeSDK = new NodeSDK({
    resource: defaultResource().merge(
      resourceFromAttributes({
        [ATTR_SERVICE_NAME]: options.service,
        [ATTR_SERVICE_VERSION]: options.version,
      }),
    ),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request: IncomingMessage) =>
          (request.url ?? '').startsWith(HEALTH_PATH_PREFIX),
      }),
      new ExpressInstrumentation(),
      new PgInstrumentation(),
      new IORedisInstrumentation(),
      new UndiciInstrumentation(),
    ],
    // Explicit on both branches: left undefined, the SDK would fall back to its own environment
    // defaults and export to a local collector nobody asked for.
    spanProcessors: [
      exporting
        ? new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })
        : new NoopSpanProcessor(),
    ],
    metricReaders: exporting
      ? [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })]
      : [],
    logRecordProcessors: [],
  });
  sdk.start();
  const eventLoopDelay: IntervalHistogram | undefined = exporting
    ? observeEventLoopDelay()
    : undefined;
  const handle: TelemetryHandle = {
    exporting,
    shutdown: async (): Promise<void> => {
      if (state.handle !== handle) {
        return;
      }
      state.handle = undefined;
      registerTelemetryShutdown(undefined);
      eventLoopDelay?.disable();
      try {
        await sdk.shutdown();
      } finally {
        trace.disable();
        metrics.disable();
        propagation.disable();
        context.disable();
      }
    },
  };
  state.handle = handle;
  registerTelemetryShutdown(() => handle.shutdown());
  return handle;
}
