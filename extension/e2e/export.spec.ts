import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { expect, test } from './support/extension';

test('Export downloads a zip of every save with its images', async ({
  context,
  sites,
  save,
  openWall,
}) => {
  const page = await context.newPage();
  for (const n of [0, 1]) {
    await page.goto(sites.url(`/site/${String(n)}`));
    expect((await save(page)).ok).toBe(true);
  }
  const wall = await openWall();
  await expect(wall.locator('.card.is-ready')).toHaveCount(2, { timeout: 30_000 });

  const download = wall.waitForEvent('download');
  await wall.getByTestId('export-trigger').click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^visual-tabs-export-\d{4}-\d{2}-\d{2}\.zip$/);

  const files = unzipSync(new Uint8Array(await readFile(await file.path())));
  const manifest = JSON.parse(strFromU8(files['saves.json'] ?? new Uint8Array())) as {
    saves: { url: string; images: Record<string, string> }[];
  };
  expect(manifest.saves.map((s) => s.url).sort()).toEqual([
    sites.url('/site/0'),
    sites.url('/site/1'),
  ]);
  for (const saved of manifest.saves) {
    expect(Object.keys(saved.images).sort()).toEqual(['card', 'full']);
    for (const name of Object.values(saved.images)) {
      // WebP files start with "RIFF".
      expect(strFromU8(files[name]?.slice(0, 4) ?? new Uint8Array())).toBe('RIFF');
    }
  }
});
