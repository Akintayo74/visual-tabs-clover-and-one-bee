import { defineConfig } from 'vitest/config';

// Unit tests: no database or network.
export default defineConfig({
  test: { include: ['tests/unit/**/*.test.ts'] },
});
