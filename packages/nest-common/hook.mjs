// Module loader of the OpenTelemetry instrumentations, re-exported so an application can name it
// without depending on `@opentelemetry/instrumentation` itself: under pnpm's strict node_modules a
// transitive dependency cannot be resolved from the application.
//
//   node --experimental-loader=@cadenway/nest-common/hook.mjs --import ./telemetry.js dist/main.js
export { initialize, load, resolve } from '@opentelemetry/instrumentation/hook.mjs';
