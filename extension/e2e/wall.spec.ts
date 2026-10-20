import { expect, test } from './support/extension';

test('keyboard navigation, detail view and delete', async ({ context, sites, save, openWall }) => {
  const page = await context.newPage();
  for (const n of [0, 1, 2, 3]) {
    await page.goto(sites.url(`/site/${String(n)}`));
    expect((await save(page)).ok).toBe(true);
  }

  const wall = await openWall();
  await expect(wall.locator('.card.is-ready')).toHaveCount(4, { timeout: 30_000 });

  // Most recent first: /site/3 is the first card.
  await wall.keyboard.press('ArrowRight');
  const card = (index: number) => wall.locator(`.card[data-index="${String(index)}"] .card-hit`);
  await expect(card(0)).toBeFocused();
  await expect(card(0)).toHaveAccessibleName(/^A long essay 3/);
  await wall.keyboard.press('ArrowRight');
  await expect(card(1)).toBeFocused();
  await wall.keyboard.press('ArrowDown'); // 3 columns at 1440px: the 4th card
  await expect(card(3)).toBeFocused();

  await wall.keyboard.press('Enter');
  const detail = wall.getByTestId('detail');
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('link', { name: 'Open site' })).toHaveAttribute(
    'href',
    sites.url('/site/0'),
  );
  await expect(detail).toContainText('We make calm software');
  await expect(detail.locator('.detail-image')).toHaveJSProperty('complete', true);

  await wall.keyboard.press('Escape');
  await expect(detail).toBeHidden();

  await wall.keyboard.press('Enter');
  await expect(detail).toBeVisible();
  const del = detail.getByRole('button', { name: 'Delete' });
  await del.click();
  await detail.getByRole('button', { name: 'Click again to delete' }).click();
  await expect(detail).toBeHidden();
  await expect(wall.getByTestId('card')).toHaveCount(3);
});

test('the wall shows saves made while it is open', async ({ context, sites, save, openWall }) => {
  const wall = await openWall();
  await expect(wall.getByTestId('empty')).toBeVisible();

  const page = await context.newPage();
  await page.goto(sites.url('/site/5'));
  expect((await save(page)).ok).toBe(true);
  await expect(wall.getByTestId('card')).toHaveCount(1);
  await expect(wall.locator('.card.is-ready')).toHaveCount(1, { timeout: 30_000 });
});
