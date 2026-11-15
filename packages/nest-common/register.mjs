// Registers the module hooks of the OpenTelemetry instrumentations with `module.register()`,
// for Node's `--import`, which does not print the ExperimentalWarning of `--experimental-loader`:
//
//   node --import @cadenway/nest-common/register --import ./dist/telemetry.js dist/main.js
//
// The specifier is resolved from this file, so it works under pnpm's strict node_modules, where
// the application cannot name `@opentelemetry/instrumentation` itself. No `data` is passed: the
// `initialize` hook of import-in-the-middle then applies no include or exclude list and wraps
// every module, as the hook does under `--experimental-loader`.
import { register } from 'node:module';

register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
