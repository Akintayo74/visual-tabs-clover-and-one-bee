import { defineConfig } from 'vitest/config';

/**
 * Edge Function tests against the local stack (`supabase start`) with the functions served by
 * `supabase functions serve --env-file server/functions.test.env`, which points them at the
 * mock models these tests start.
 */
export default defineConfig({
  test: {
    include: ['tests/functions/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
