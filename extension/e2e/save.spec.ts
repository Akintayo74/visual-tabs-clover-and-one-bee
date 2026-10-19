import { expect, statuses, test } from './support/extension';

const TOAST_BUDGET_MS = 300;

test('saves 20 varied sites, each with feedback inside the budget', async ({
  context,
  sites,
  save,
  openWall,
}) => {
  const page = await context.newPage();
  const toastTimes: number[] = [];
  for (let n = 0; n < 20; n++) {
    await page.goto(sites.url(`/site/${String(n)}`));
    // A person looks at a page before saving it. Without a pause, back-to-back saves hit
    // Chrome's two-captures-per-second limit, and the extension spaces captures out.
    await page.waitForTimeout(600);
    const result = await save(page);
    expect(result, `save of /site/${String(n)}: ${result.reason ?? ''}`).toMatchObject({
      ok: true,
    });
    expect(result.toastMs, `toast for /site/${String(n)}`).not.toBeNull();
    toastTimes.push(result.toastMs ?? Infinity);
    console.log(
      `/site/${String(n)}`,
      'toast',
      result.toastMs,
      'saved',
      result.savedToastMs,
      result.timings,
    );
  }
  const sorted = [...toastTimes].sort((a, b) => a - b);
  console.log('toast ms: median', sorted[10], 'max', sorted[19]);
  expect(Math.max(...toastTimes)).toBeLessThan(TOAST_BUDGET_MS);

  const wall = await openWall();
  await expect(wall.getByTestId('count')).toHaveText('20 saved');
  await expect.poll(() => statuses(wall), { timeout: 30_000 }).toEqual(Array(20).fill('ready'));
  // The grid is virtualised: only rows near the viewport are in the DOM.
  const mounted = await wall.getByTestId('card').count();
  expect(mounted).toBeGreaterThan(0);
  expect(mounted).toBeLessThan(20);
  await wall.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
  });
  await expect(wall.locator('.card[data-index="19"]')).toBeVisible();
  const timing = await wall.evaluate(() => ({
    scriptStart: performance.getEntriesByName('newtab-start')[0]?.startTime ?? null,
    rendered: performance.getEntriesByName('wall-rendered')[0]?.startTime ?? null,
  }));
  console.log('new tab timing (ms after navigation start)', timing);
  expect(timing.rendered).not.toBeNull();
  // From our script starting to the wall on screen: reading IndexedDB, layout and first render.
  expect((timing.rendered ?? Infinity) - (timing.scriptStart ?? 0)).toBeLessThan(100);

  // Images come from IndexedDB as WebP.
  await expect
    .poll(() =>
      wall.evaluate(
        () =>
          [...document.querySelectorAll<HTMLImageElement>('.card-image img')].filter(
            (img) => img.complete && img.naturalWidth > 0,
          ).length,
      ),
    )
    .toBeGreaterThan(0);
});

test('re-saving the same page replaces the snapshot instead of duplicating', async ({
  context,
  sites,
  save,
  openWall,
}) => {
  const page = await context.newPage();
  await page.goto(sites.url('/site/0'));
  const first = await save(page);
  await page.goto(sites.url('/site/0?utm_source=newsletter#top'));
  const second = await save(page);
  expect(first.ok && second.ok).toBe(true);
  expect(second.id).toBe(first.id);

  const wall = await openWall();
  await expect(wall.getByTestId('card')).toHaveCount(1);
});

test('save and close closes the tab only after the save is stored', async ({
  context,
  sites,
  save,
  openWall,
}) => {
  const page = await context.newPage();
  await page.goto(sites.url('/site/1'));
  const closed = page.waitForEvent('close');
  const result = await save(page, { close: true });
  expect(result.ok).toBe(true);
  await closed;

  const wall = await openWall();
  await expect(wall.getByTestId('card')).toHaveCount(1);
});

test('unsupported pages fail with a clear reason and store nothing', async ({
  context,
  save,
  openWall,
}) => {
  const page = await context.newPage();
  await page.goto('chrome://version');
  const result = await save(page);
  expect(result).toMatchObject({ ok: false, reason: "Browser pages can't be saved." });

  const wall = await openWall();
  await expect(wall.getByTestId('empty')).toBeVisible();
});

test('very large and busy pages still save', async ({ context, sites, save, openWall }) => {
  const page = await context.newPage();
  await page.goto(sites.url('/huge'));
  expect(await save(page)).toMatchObject({ ok: true });

  await page.goto(sites.url('/busy'));
  await page.waitForTimeout(200); // let the page start blocking its main thread
  const started = Date.now();
  const busy = await save(page);
  expect(busy.ok).toBe(true);
  // The fingerprint gives up after 2s; the save doesn't wait for the page.
  expect(Date.now() - started).toBeLessThan(4000);

  const wall = await openWall();
  await expect(wall.locator('.card.is-ready')).toHaveCount(2, { timeout: 30_000 });
});
