import { expect, test } from './support/extension';

test('loads unpacked and overrides the new tab', async ({ context, worker }) => {
  expect(worker.url()).toMatch(/^chrome-extension:\/\/[a-p]{32}\/background\.js$/);

  const page = await context.newPage();
  await page.goto('chrome://newtab');
  await expect(page).toHaveURL(/^chrome-extension:\/\/[a-p]{32}\/newtab\.html$/);
  await expect(page.getByTestId('empty')).toContainText('Alt+Shift+S');
});
