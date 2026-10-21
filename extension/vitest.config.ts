import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    include: ['tests/**/*.test.ts'],
    // Needs the local Supabase stack; see vitest.server.config.ts.
    exclude: ['tests/server/**'],
  },
});
