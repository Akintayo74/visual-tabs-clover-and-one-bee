import { expect, test } from '@playwright/test';
import { extractFingerprint } from '../src/fingerprint/extract';
import { startSites, type SiteServer } from './support/sites';

// Runs the extraction function in real Chromium (layout and computed styles are needed),
// the same way scripting.executeScript serialises it.
let sites: SiteServer;
test.beforeAll(async () => {
  sites = await startSites();
});
test.afterAll(async () => {
  await sites.close();
});
test.use({ viewport: { width: 1440, height: 900 } });

test('one-page site of huge typographic links', async ({ page }) => {
  await page.goto(sites.url('/site/1'));
  const fp = await page.evaluate(extractFingerprint, null);
  expect(fp.pageHeightViewports).toBeLessThanOrEqual(1.1);
  expect(fp.largestText.slice(0, 3)).toEqual([
    { text: 'Projects', fontSize: 120, isLink: true, href: sites.url('/projects') },
    { text: 'Journal', fontSize: 120, isLink: true, href: sites.url('/journal') },
    { text: 'Contact', fontSize: 120, isLink: true, href: sites.url('/contact') },
  ]);
  expect(fp.links).toEqual({ total: 3, internal: 3, external: 0 });
  expect(fp.hasNav || fp.hasHeader || fp.hasFooter).toBe(false);
  expect(fp.fonts.headings).toEqual(['Helvetica']);
});

test('landing page with sections, header, nav, footer and canonical', async ({ page }) => {
  await page.goto(sites.url('/site/0'));
  const fp = await page.evaluate(extractFingerprint, null);
  expect(fp).toMatchObject({
    canonicalUrl: sites.url('/site/0'),
    siteName: 'Studio 0',
    hasHeader: true,
    hasNav: true,
    hasFooter: true,
    sectionCount: 5,
    links: { total: 3, internal: 2, external: 1 },
  });
  expect(fp.pageHeightViewports).toBeGreaterThan(3);
  expect(fp.largestText[0]).toMatchObject({
    text: 'We make calm software',
    fontSize: 96,
    isLink: false,
  });
  expect(fp.palette[0]).toBe('#0b0b0f');
  expect(fp.palette).toContain('#f5f5f0');
  expect(fp.fonts.headings[0]).toBe('Georgia');
});

test('full-screen canvas and 3D library', async ({ page }) => {
  await page.goto(sites.url('/site/4'));
  const fp = await page.evaluate(extractFingerprint, null);
  expect(fp.signals).toMatchObject({ largeCanvas: true, webgl: true });
  expect(fp.signals.libraries).toContain('three.js');
});

test('stays bounded on a huge page', async ({ page }) => {
  await page.goto(sites.url('/huge'));
  const started = Date.now();
  const fp = await page.evaluate(extractFingerprint, null);
  expect(fp.truncated).toBe(true);
  expect(Date.now() - started).toBeLessThan(1500);
});

test('ignores the save toast', async ({ page }) => {
  await page.goto(sites.url('/site/5'));
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'visual-memory-toast';
    host.innerHTML = '<p style="font-size:200px">Saving…</p>';
    document.body.append(host);
  });
  const fp = await page.evaluate(extractFingerprint, '#visual-memory-toast');
  expect(fp.largestText.map((t) => t.text)).not.toContain('Saving…');
});
