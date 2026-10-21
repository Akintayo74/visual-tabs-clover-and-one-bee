import type { Page } from '@playwright/test';
import { expectBackedUp, signIn, uniqueEmail } from './support/backup';
import { expect, test } from './support/extension';

/** Every save's model status and description, read straight from IndexedDB. */
function understandings(page: Page): Promise<{ status?: string; description?: string | null }[]> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('visual-memory');
        open.onerror = () => {
          reject(new Error('could not open the database'));
        };
        open.onsuccess = () => {
          const request = open.result.transaction('saves').objectStore('saves').getAll();
          request.onsuccess = () => {
            resolve(
              (
                request.result as {
                  understanding?: { status: string; description: string | null };
                }[]
              ).map((s) => ({
                status: s.understanding?.status,
                description: s.understanding?.description,
              })),
            );
            open.result.close();
          };
        };
      }),
  );
}

test('the search box filters the wall as you type, and / and Esc work', async ({
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

  await wall.bringToFront();
  await wall.locator('.brand').click();
  await wall.keyboard.press('/');
  const input = wall.getByTestId('search');
  await expect(input).toBeFocused();
  await input.pressSequentially('portfolo');
  await expect(wall.getByTestId('count')).toHaveText('1 match');
  await expect(wall.getByTestId('card')).toHaveCount(1);
  await expect(wall.getByTestId('card')).toContainText('Portfolio grid 2');
  // Signed out, there's no smart search, and the page says so.
  await expect(wall.getByTestId('search-status')).toContainText('Sign in');

  await input.fill('nothing like this');
  await expect(wall.getByTestId('empty')).toHaveText('No quick matches.');

  await input.press('Escape');
  await expect(input).toHaveValue('');
  await expect(wall.getByTestId('count')).toHaveText('3 saved');
  await expect(wall.getByTestId('card')).toHaveCount(3);
});

// Needs the local Supabase stack with the Edge Functions served against the mock models:
// `pnpm --filter server mock-models` and
// `supabase functions serve --env-file server/functions.test.env`. CI runs this in the
// supabase job.
test.describe('described saves and smart search @sync', () => {
  test('uploaded saves get described, and search finds them by what they look like', async ({
    context,
    sites,
    save,
    openWall,
  }) => {
    const wall = await openWall();
    await signIn(wall, uniqueEmail('search'));
    await expectBackedUp(wall);

    const page = await context.newPage();
    for (const n of [1, 2, 3]) {
      await page.goto(sites.url(`/site/${String(n)}`));
      expect((await save(page)).ok).toBe(true);
    }
    await expectBackedUp(wall);
    // The server describes each save and the description syncs back down.
    await expect
      .poll(async () => (await understandings(wall)).map((u) => u.status), { timeout: 60_000 })
      .toEqual(['ready', 'ready', 'ready']);
    await expect(wall.getByTestId('card-understanding')).toHaveCount(0);

    const input = wall.getByTestId('search');
    // The mock model describes the index page by its huge links: Projects, Journal, Contact.
    await input.fill('the page with journal and contact');
    await expect(wall.getByTestId('search-status')).toHaveText('Best matches first.', {
      timeout: 15_000,
    });
    const first = wall.getByTestId('card').first();
    await expect(first).toContainText('Index 1');

    await first.locator('.card-hit').click();
    const detail = wall.getByTestId('detail');
    await expect(detail).toContainText('A saved site called Index 1');
    await expect(detail).toContainText('Remembered as');
  });
});
