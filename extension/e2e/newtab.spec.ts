import { chromium, expect, test } from '@playwright/test';
import path from 'node:path';

const extensionPath = path.resolve(import.meta.dirname, '../.output/chrome-mv3');

test('loads unpacked and overrides the new tab', async () => {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });

  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    expect(worker.url()).toMatch(/^chrome-extension:\/\/[a-p]{32}\/background\.js$/);

    const page = await context.newPage();
    await page.goto('chrome://newtab');
    await expect(page).toHaveURL(/^chrome-extension:\/\/[a-p]{32}\/newtab\.html$/);
    await expect(page.getByTestId('newtab-placeholder')).toBeVisible();
  } finally {
    await context.close();
  }
});
