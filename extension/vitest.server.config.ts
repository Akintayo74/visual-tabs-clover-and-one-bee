import { defineConfig } from 'vitest/config';

// Database tests: run against the local Supabase stack (`pnpm db:start`).
export default defineConfig({
  test: {
    include: ['tests/server/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    // Tests share one database; keep them in one process so the users they create don't clash.
    fileParallelism: false,
  },
});
