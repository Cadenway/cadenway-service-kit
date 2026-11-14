/**
 * Type TelemetryShutdown
 *
 * @description
 * Function that flushes and stops the telemetry started in this process.
 *
 * @type {() => Promise<void>}
 */
export type TelemetryShutdown = () => Promise<void>;

/**
 * Constant registry
 *
 * @description
 * Holds the shutdown function of the running telemetry, if any. Kept apart from the SDK so the
 * main entry point can flush telemetry at shutdown without importing the OpenTelemetry SDK.
 *
 * @type {{ shutdown: TelemetryShutdown | undefined }}
 */
const registry: { shutdown: TelemetryShutdown | undefined } = { shutdown: undefined };

/**
 * Function registerTelemetryShutdown
 *
 * @description
 * Records how to stop the telemetry that was just started, or clears the record with `undefined`.
 *
 * @param {TelemetryShutdown | undefined} shutdown - Function that flushes and stops telemetry.
 * @returns {void}
 */
export function registerTelemetryShutdown(shutdown: TelemetryShutdown | undefined): void {
  registry.shutdown = shutdown;
}

/**
 * Function shutdownTelemetry
 *
 * @description
 * Flushes pending spans and metrics and stops telemetry. Resolves at once when telemetry was
 * never started, so an application can call it unconditionally while shutting down.
 *
 * @returns {Promise<void>} Resolves once telemetry is stopped.
 */
export async function shutdownTelemetry(): Promise<void> {
  await registry.shutdown?.();
}
