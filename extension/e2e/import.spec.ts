import type { Page } from '@playwright/test';
import { expect, statuses, test } from './support/extension';

/** Whether this extension page's tab is the active tab of its window. */
async function isActiveTab(page: Page): Promise<boolean | undefined> {
  return page.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: typeof browser }).chrome;
    return (await api.tabs.getCurrent())?.active;
  });
}

test('imports a window of 50 tabs, then closes the saved ones', async ({
  context,
  sites,
  openWall,
}) => {
  test.setTimeout(300_000);
  const wall = await openWall();
  await expect(wall.getByTestId('empty')).toBeVisible();

  // First a page that is still loading when the import reaches it, then 47 sites, a duplicate
  // and a browser page. (Chrome's memory-saver discarding can't be simulated here: Playwright
  // loses track of discarded tabs.)
  const slow = await context.newPage();
  void slow.goto(sites.url('/slow?ms=5000')).catch(() => undefined);
  for (let n = 0; n < 47; n++) {
    const page = await context.newPage();
    await page.goto(sites.url(`/site/${String(n)}`));
  }
  const duplicate = await context.newPage();
  await duplicate.goto(sites.url('/site/0?utm_source=x'));
  const browserPage = await context.newPage();
  await browserPage.goto('chrome://version');
  await wall.bringToFront();

  await wall.getByTestId('import-trigger').click();
  const panel = wall.getByTestId('import');
  await expect(panel).toContainText('Saved 49 tabs of 50.', { timeout: 280_000 });

  // The import returns to the tab it started from.
  expect(await isActiveTab(wall)).toBe(true);
  await panel.getByText('1 tab not saved').click();
  await expect(panel).toContainText("Browser pages can't be saved.");
  // The duplicate is saved onto the same record as /site/0, so 49 saved tabs make 48 saves.
  await expect.poll(() => statuses(wall), { timeout: 60_000 }).toEqual(Array(48).fill('ready'));
  await expect(wall.getByTestId('count')).toHaveText('48 saved');

  await panel.getByRole('button', { name: 'Close 49 saved tabs' }).click();
  await expect(panel).toContainText('Closed 49 tabs.');
  const open = context
    .pages()
    .filter((p) => !p.isClosed())
    .map((p) => p.url());
  expect(open).toContain('chrome://version/');
  expect(open.filter((url) => url.startsWith(sites.origin))).toEqual([]);

  await panel.getByRole('button', { name: 'Done' }).click();
  await expect(panel).toBeHidden();
});

test('a tab that navigated after saving is not closed', async ({ context, sites, openWall }) => {
  const wall = await openWall();
  const a = await context.newPage();
  await a.goto(sites.url('/site/1'));
  const b = await context.newPage();
  await b.goto(sites.url('/site/2'));
  await wall.bringToFront();

  await wall.getByTestId('import-trigger').click();
  const panel = wall.getByTestId('import');
  await expect(panel).toContainText('Saved 2 tabs of 2.', { timeout: 60_000 });

  await b.goto(sites.url('/site/3'));
  await panel.getByRole('button', { name: 'Close 2 saved tabs' }).click();
  await expect(panel).toContainText(
    'Closed 1 tab. Left 1 tab open because it now shows a different page.',
  );
  expect(a.isClosed()).toBe(true);
  expect(b.isClosed()).toBe(false);
});

test('cancelling stops the import and returns to the starting tab', async ({
  context,
  sites,
  openWall,
}) => {
  const wall = await openWall();
  for (let n = 0; n < 8; n++) {
    const page = await context.newPage();
    await page.goto(sites.url(`/site/${String(n)}`));
  }
  await wall.bringToFront();
  await wall.getByTestId('import-trigger').click();
  const panel = wall.getByTestId('import');
  await expect(panel).toContainText('Importing tab 2 of 8', { timeout: 30_000 });

  await panel.getByRole('button', { name: 'Cancel' }).click();
  await expect(panel).toContainText('Import cancelled.', { timeout: 30_000 });
  expect(await isActiveTab(wall)).toBe(true);
  const saved = (await statuses(wall)).length;
  expect(saved).toBeGreaterThan(0);
  expect(saved).toBeLessThan(8);
});
