import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Every suite here writes to the same PostgreSQL database and some of them
    // assert on constraints (RESTRICT, CASCADE) that only hold while their own
    // fixtures are intact. Running the files one at a time keeps one suite's
    // teardown from pulling rows out from under another's assertions; the suites
    // are small enough that the wall-clock cost is negligible.
    fileParallelism: false,
  },
});
