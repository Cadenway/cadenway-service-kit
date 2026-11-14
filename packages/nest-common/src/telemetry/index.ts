/**
 * Entry point `@cadenway/nest-common/telemetry`: the OpenTelemetry start-up, kept apart from the
 * main entry point so the preloaded `telemetry.js` of an application imports the SDK and nothing
 * of NestJS before the instrumentations are registered.
 *
 * @packageDocumentation
 */
export { startTelemetry, type TelemetryHandle, type TelemetryOptions } from './start-telemetry.js';
export { shutdownTelemetry } from './telemetry-handle.js';
