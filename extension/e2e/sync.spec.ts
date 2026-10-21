import {
  expectBackedUp,
  localSaves,
  setOffline,
  signIn,
  syncNow,
  uniqueEmail,
} from './support/backup';
import {
  expect,
  launchBrowser,
  openNewTab,
  saveActiveTab,
  serviceWorker,
  statuses,
  test,
} from './support/extension';

// Needs the local Supabase stack (`pnpm db:start`); CI runs these in the supabase job.
test.describe('backup and sync @sync', () => {
  test('saves back up, and a fresh install shows the same wall after signing in', async ({
    context,
    sites,
    save,
    openWall,
  }) => {
    const email = uniqueEmail('reinstall');
    const wall = await openWall();
    await expect(wall.getByTestId('sync-status')).toHaveText('Not backed up');
    await signIn(wall, email);
    await expectBackedUp(wall);

    const page = await context.newPage();
    for (const n of [0, 1, 2]) {
      await page.goto(sites.url(`/site/${String(n)}`));
      expect((await save(page)).ok).toBe(true);
    }
    await expect(wall.getByTestId('count')).toHaveText('3 saved');
    await expectBackedUp(wall);
    const original = (await localSaves(wall)).map((s) => s.id).sort();

    // A new profile is what uninstalling and reinstalling leaves: no local data at all.
    const fresh = await launchBrowser();
    try {
      const freshWall = await openNewTab(fresh);
      await expect(freshWall.getByTestId('empty')).toBeVisible();
      await signIn(freshWall, email);
      await expect(freshWall.getByTestId('count')).toHaveText('3 saved', { timeout: 30_000 });
      await expectBackedUp(freshWall);
      expect((await localSaves(freshWall)).map((s) => s.id).sort()).toEqual(original);
      expect(await statuses(freshWall)).toEqual(['ready', 'ready', 'ready']);
      await expect(freshWall.locator('.card.is-ready')).toHaveCount(3);
      await expect(freshWall.locator('.card-image img').first()).toHaveJSProperty('complete', true);

      // The detail view shows the full image (wider than the 960px card), downloaded after the cards.
      await freshWall.locator('.card-hit').first().click();
      const image = freshWall.getByTestId('detail').locator('.detail-image');
      await expect
        .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
        .toBeGreaterThan(960);
    } finally {
      await fresh.close();
    }
  });

  test('saves made offline upload by themselves once the connection is back', async ({
    context,
    worker,
    sites,
    save,
    openWall,
  }) => {
    const wall = await openWall();
    await signIn(wall, uniqueEmail('offline'));
    await expectBackedUp(wall);

    await setOffline(worker, true);
    const page = await context.newPage();
    for (const n of [3, 4]) {
      await page.goto(sites.url(`/site/${String(n)}`));
      expect((await save(page)).ok).toBe(true);
    }
    // Saving never waits for the network.
    await expect(wall.locator('.card.is-ready')).toHaveCount(2, { timeout: 30_000 });
    await expect(wall.getByTestId('sync-status')).toHaveText(
      "Offline. 2 saves will back up when you're online",
      { timeout: 30_000 },
    );
    await expect(wall.getByTestId('card-sync')).toHaveCount(2);
    await expect(wall.getByTestId('card-sync').first()).toHaveText('Waiting to back up');

    // No click: the retry timer picks it up.
    await setOffline(worker, false);
    await expectBackedUp(wall, 60_000);
    await expect(wall.getByTestId('card-sync')).toHaveCount(0);
    expect((await localSaves(wall)).every((s) => s.syncState === 'synced')).toBe(true);
  });

  test('deletes and re-saves reach the other browser, and the same page stays one save', async ({
    context,
    sites,
    save,
    openWall,
  }) => {
    const email = uniqueEmail('two-browsers');
    const wallA = await openWall();
    await signIn(wallA, email);

    const pageA = await context.newPage();
    await pageA.goto(sites.url('/site/1'));
    expect((await save(pageA)).ok).toBe(true);
    await pageA.goto(sites.url('/site/2'));
    expect((await save(pageA)).ok).toBe(true);
    await expect(wallA.getByTestId('count')).toHaveText('2 saved');
    await expectBackedUp(wallA);

    const other = await launchBrowser();
    try {
      const workerB = await serviceWorker(other);
      // B saves /site/1 before signing in, so it has its own id for the same page.
      const pageB = await other.newPage();
      await pageB.goto(sites.url('/site/1'));
      expect((await saveActiveTab(workerB, pageB)).ok).toBe(true);
      const wallB = await openNewTab(other);
      await expect(wallB.locator('.card.is-ready')).toHaveCount(1, { timeout: 30_000 });

      await signIn(wallB, email);
      await expectBackedUp(wallB);
      await expect(wallB.getByTestId('count')).toHaveText('2 saved', { timeout: 30_000 });
      const idsA = (await localSaves(wallA)).map((s) => s.id).sort();
      expect((await localSaves(wallB)).map((s) => s.id).sort()).toEqual(idsA);

      // B's capture of /site/1 is newer, so A picks it up.
      await syncNow(wallA);
      await expectBackedUp(wallA);
      const site1 = (saves: Awaited<ReturnType<typeof localSaves>>) =>
        saves.find((s) => s.url === sites.url('/site/1'))?.updatedAt;
      expect(site1(await localSaves(wallA))).toBe(site1(await localSaves(wallB)));

      // Deleting on A removes it from B.
      await wallA.locator('.card-hit').first().click();
      const detail = wallA.getByTestId('detail');
      await detail.getByRole('button', { name: 'Delete' }).click();
      await detail.getByRole('button', { name: 'Click again to delete' }).click();
      await expect(wallA.getByTestId('count')).toHaveText('1 saved');
      await expectBackedUp(wallA);
      await syncNow(wallB);
      await expect(wallB.getByTestId('count')).toHaveText('1 saved', { timeout: 30_000 });
    } finally {
      await other.close();
    }
  });
});
