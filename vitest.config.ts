import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['packages/*/src/**/*.spec.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['packages/*/src/**/*.int-spec.ts'],
          // Integration specs start disposable PostgreSQL and NATS containers in their hooks.
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/**/*.spec.ts', 'packages/*/src/**/*.int-spec.ts'],
      reporter: ['text', 'lcov'],
    },
  },
});
