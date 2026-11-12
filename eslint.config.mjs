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
          paths: [{ name: 'nats', message: natsMessage }],
          patterns: [{ group: ['@nats-io/*'], message: natsMessage }, siblingSources],
        },
      ],
    },
  },
  {
    // The one package that owns the NATS client: only the sibling-source ban applies to it.
    files: ['packages/nest-messaging/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [siblingSources] }],
    },
  },
  {
    files: ['**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: { '@typescript-eslint/explicit-function-return-type': 'off' },
  },
  prettier,
);
