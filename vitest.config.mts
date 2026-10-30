import { defineConfig } from 'vitest/config';

// Use native ESM configuration loading in Vite and Vitest.

export default defineConfig({
  test: {
    include: ['test/upstream/**/*.spec.ts'],
    maxWorkers: 2,
    testTimeout: 10000,
  },
});
