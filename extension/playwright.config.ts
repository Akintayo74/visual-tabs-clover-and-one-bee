import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  // Each test gets its own browser profile; captures compete for the screen, so keep it serial.
  workers: 1,
  reporter: process.env.CI ? 'list' : [['list']],
  use: { testIdAttribute: 'data-testid' },
});
