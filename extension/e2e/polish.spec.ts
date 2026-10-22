import type { Page } from '@playwright/test';
import { expectBackedUp, signIn, syncNow, uniqueEmail } from './support/backup';
import { expect, launchBrowser, openNewTab, test } from './support/extension';

async function openCard(wall: Page, title: string): Promise<void> {
  await wall.getByTestId('card').filter({ hasText: title }).locator('.card-hit').click();
  await expect(wall.getByTestId('detail')).toBeVisible();
}

async function writeNote(wall: Page, text: string): Promise<void> {
  const note = wall.getByTestId('note');
  await note.fill(text);
  await expect(wall.getByTestId('note-status')).toHaveText('Saved.');
}

test('notes are kept and searchable, and filters, density and "More like this" work', async ({
  context,
  sites,
  save,
  openWall,
}) => {
  const page = await context.newPage();
  for (const n of [1, 2, 3]) {
    await page.goto(sites.url(`/site/${String(n)}`));
    expect((await save(page)).ok).toBe(true);
  }
  const wall = await openWall();
  await expect(wall.getByTestId('count')).toHaveText('3 saved');

  // A note is stored as you type, and survives closing the tab.
  await openCard(wall, 'Portfolio grid 2');
  await writeNote(wall, 'zebra moodboard for the Kola pitch');
  // Enter in the note box adds a line; it doesn't open the site.
  await wall.getByTestId('note').press('Enter');
  await expect(wall.getByTestId('detail')).toBeVisible();
  await wall.keyboard.press('Escape');
  await expect(wall.getByTestId('detail')).toBeHidden();

  const input = wall.getByTestId('search');
  await input.fill('zebra');
  await expect(wall.getByTestId('count')).toHaveText('1 match');
  await expect(wall.getByTestId('card')).toContainText('Portfolio grid 2');
  await input.fill('');

  await wall.reload();
  await openCard(wall, 'Portfolio grid 2');
  await expect(wall.getByTestId('note')).toHaveValue('zebra moodboard for the Kola pitch');
  await wall.keyboard.press('Escape');

  // Colour filter: site 2 has an orange background.
  const orange = wall.locator('.swatch-button[data-colour="orange"]');
  await orange.click();
  await expect(orange).toHaveAttribute('aria-pressed', 'true');
  await expect(wall.getByTestId('count')).toHaveText('1 of 3 saved');
  await expect(wall.getByTestId('card')).toContainText('Portfolio grid 2');
  await orange.click();
  await expect(wall.getByTestId('count')).toHaveText('3 saved');

  // Font filter: each test site uses a different font.
  const font = wall.getByTestId('font-filter');
  const fonts = await font.locator('option').allTextContents();
  expect(fonts.length).toBeGreaterThan(1);
  await font.selectOption({ index: 1 });
  await expect(wall.getByTestId('count')).toHaveText(/^[12] of 3 saved$/);

  // Filters narrow search results too, and say so when nothing is left.
  await wall.getByTestId('date-filter').selectOption('older');
  await expect(wall.getByTestId('empty')).toContainText('No saves match these filters.');
  await wall.getByTestId('empty').getByRole('button', { name: 'Clear filters' }).click();
  await expect(wall.getByTestId('count')).toHaveText('3 saved');
  await expect(font).toHaveValue('');

  // Density: two per row puts the second card beside the first, and is remembered.
  await wall.getByTestId('density').getByRole('button', { name: '2' }).click();
  const top = async (i: number) => (await wall.getByTestId('card').nth(i).boundingBox())?.y;
  await expect.poll(async () => (await top(1)) === (await top(0))).toBe(true);
  await expect.poll(async () => (await top(2)) !== (await top(0))).toBe(true);
  await wall.reload();
  await expect(wall.getByTestId('density').getByRole('button', { name: '2' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect.poll(async () => (await top(2)) !== (await top(0))).toBe(true);

  // More like this, signed out: matched on this computer by fonts, colours and tags.
  await openCard(wall, 'Portfolio grid 2');
  await wall.getByTestId('more-like-this').click();
  await expect(wall.getByTestId('similar-banner')).toContainText('More like Portfolio grid 2');
  await expect(wall.getByTestId('search-status')).toContainText('Sign in');
  await expect(wall.getByTestId('card').filter({ hasText: 'Portfolio grid 2' })).toHaveCount(0);
  await wall.locator('.brand').click();
  await wall.keyboard.press('Escape');
  await expect(wall.getByTestId('similar-banner')).toBeHidden();
  await expect(wall.getByTestId('count')).toHaveText('3 saved');

  // Help explains the basics with the shortcuts as they're set.
  await wall.getByTestId('help-trigger').click();
  await expect(wall.getByTestId('help')).toContainText('Alt+Shift+S');
  await expect(wall.getByTestId('help')).toContainText('Describe what you remember');
});

// Needs the local Supabase stack; the "More like this" part also needs the Edge Functions
// served against the mock models (see search.spec.ts). CI runs these in the supabase job.
test.describe('notes and look-alikes across devices @sync', () => {
  test('a note syncs to another browser, and the latest edit wins', async ({
    context,
    sites,
    save,
    openWall,
  }) => {
    const email = uniqueEmail('notes');
    const wall = await openWall();
    await signIn(wall, email);
    const page = await context.newPage();
    await page.goto(sites.url('/site/1'));
    expect((await save(page)).ok).toBe(true);
    await expectBackedUp(wall);

    await openCard(wall, 'Index 1');
    await writeNote(wall, 'first thoughts');
    await wall.keyboard.press('Escape');
    await expectNoteUploaded(wall, 'first thoughts');

    const other = await launchBrowser();
    try {
      const otherWall = await openNewTab(other);
      await signIn(otherWall, email);
      await expect(otherWall.getByTestId('count')).toHaveText('1 saved', { timeout: 30_000 });
      await openCard(otherWall, 'Index 1');
      await expect(otherWall.getByTestId('note')).toHaveValue('first thoughts');
      await writeNote(otherWall, 'edited on the laptop');
      await otherWall.keyboard.press('Escape');
      await expectNoteUploaded(otherWall, 'edited on the laptop');
    } finally {
      await other.close();
    }

    // The first browser picks up the later edit made on the other one.
    await expectNoteUploaded(wall, 'edited on the laptop');
  });

  test('"More like this" uses the server once saves are described', async ({
    context,
    sites,
    save,
    openWall,
  }) => {
    const wall = await openWall();
    await signIn(wall, uniqueEmail('similar'));
    const page = await context.newPage();
    for (const n of [1, 2, 3, 4]) {
      await page.goto(sites.url(`/site/${String(n)}`));
      expect((await save(page)).ok).toBe(true);
    }
    await expectBackedUp(wall);
    await expect(wall.getByTestId('card-understanding')).toHaveCount(0, { timeout: 60_000 });

    await openCard(wall, 'Index 1');
    await wall.getByTestId('more-like-this').click();
    await expect(wall.getByTestId('search-status')).toHaveText('Closest first.', {
      timeout: 15_000,
    });
    await expect(wall.getByTestId('count')).toHaveText('3 similar sites');
  });
});

/** The first save's note in this browser's local store, and whether it still waits to upload. */
function localNote(wall: Page): Promise<{ note: string | null; pending: boolean }> {
  return wall.evaluate(
    () =>
      new Promise<{ note: string | null; pending: boolean }>((resolve, reject) => {
        const open = indexedDB.open('visual-memory');
        open.onerror = () => {
          reject(new Error('could not open the database'));
        };
        open.onsuccess = () => {
          const request = open.result.transaction('saves').objectStore('saves').getAll();
          request.onsuccess = () => {
            const [first] = request.result as { note: string | null; notePending?: boolean }[];
            resolve({ note: first?.note ?? null, pending: first?.notePending ?? false });
            open.result.close();
          };
        };
      }),
  );
}

/** Syncs until this browser's note edit has reached the server. */
async function expectNoteUploaded(wall: Page, note: string): Promise<void> {
  await expect
    .poll(
      async () => {
        await syncNow(wall);
        return localNote(wall);
      },
      { timeout: 20_000 },
    )
    .toEqual({ note, pending: false });
}
