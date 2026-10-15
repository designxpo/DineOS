import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Each test file provisions its own tenants, so files can share one database and run in parallel.
    fileParallelism: true,
  },
});
