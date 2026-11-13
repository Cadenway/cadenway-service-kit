import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const natsMessage = 'NATS is reached only through @cadenway/nest-messaging.';
const siblingSources = {
  regex: '\\.\\./cadenway-',
  message: 'Never import sibling sources: use the published @cadenway/* packages.',
};
// Packages set aside when the dependencies were chosen: each has a retained replacement.
const rejectedPackages = [
  { name: 'axios', message: 'Use the native fetch of Node.' },
  { name: '@nestjs/schedule', message: 'An in-process timer is not durable: use nest-jobs.' },
  { name: 'bullmq', message: 'Jobs live in PostgreSQL through nest-jobs, not in Redis.' },
  { name: 'prom-client', message: 'Metrics go through the OpenTelemetry SDK.' },
  { name: 'date-fns', message: 'Use Temporal: it tells a plain date from an instant.' },
  { name: 'moment', message: 'Use Temporal: it tells a plain date from an instant.' },
  { name: 'lodash', message: 'Use the language and the standard library.' },
];

export default defineConfig(
  globalIgnores(['**/dist/', 'coverage/', 'docs/', '.claude/', '.codex/']),
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: true }],
      // NestJS modules are classes that only carry a decorator.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportAllDeclaration',
          message: 'Use explicit named exports: a barrel hides what a module exposes.',
        },
      ],
    },
  },
  {
    files: ['packages/*/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'nats', message: natsMessage }, ...rejectedPackages],
          patterns: [{ group: ['@nats-io/*'], message: natsMessage }, siblingSources],
        },
      ],
    },
  },
  {
    // The one package that owns the NATS client: the NATS ban alone is lifted for it.
    files: ['packages/nest-messaging/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: rejectedPackages, patterns: [siblingSources] }],
    },
  },
  {
    files: ['**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: { '@typescript-eslint/explicit-function-return-type': 'off' },
  },
  prettier,
);
