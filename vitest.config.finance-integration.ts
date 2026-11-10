import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Finance integration tests against a real PostgreSQL database.
 *
 * Kept out of the default unit suite and the e2e config on purpose: the fixtures
 * create orders, payments, COD collections and deliveries, and delete them again.
 * The setup file rewrites `DATABASE_URL` to an isolated `*_test` database before
 * any application module is imported, and `resolveTestDatabaseUrl` refuses to
 * hand back the development database.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['test/finance.integration.test.ts'],
    setupFiles: ['./test/support/test-db-env.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
