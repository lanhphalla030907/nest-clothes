import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Delivery integration tests against a real PostgreSQL database.
 *
 * Kept out of `vitest.config.e2e.ts` on purpose: the existing e2e suites run
 * against whatever `DATABASE_URL` points at, while these tests install triggers
 * and delete fixtures. The setup file rewrites `DATABASE_URL` to an isolated
 * `*_test` database before any application module is imported.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: [
      'test/delivery.integration.test.ts',
      'test/delivery-cod.integration.test.ts',
    ],
    setupFiles: ['./test/support/test-db-env.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
