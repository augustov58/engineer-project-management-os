import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    // Containers are shared across the run; each test still gets its own
    // database, so files may run in parallel.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
