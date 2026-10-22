import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { unzipSync, strFromU8 } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import { completeProcessing, resetDbForTests, upsertSnapshot } from '@/src/lib/db';
import type { Fingerprint } from '@/src/lib/types';
import { buildExport, exportFileName, type ExportManifest } from '@/src/newtab/export';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
});

const base = {
  canonicalUrl: null,
  faviconUrl: null,
  width: 100,
  height: 100,
  palette: ['#000'],
  fonts: ['Inter'],
};

describe('buildExport', () => {
  it('zips saves.json with every save and its images', async () => {
    const ready = await upsertSnapshot({
      ...base,
      dedupeKey: 'https://a.example',
      url: 'https://a.example/',
      title: 'A',
      siteName: 'A',
      fingerprint: { version: 1, title: 'A' } as Fingerprint,
      raw: new Blob(['raw-a']),
      now: 1000,
    });
    await completeProcessing(ready.id, 1000, {
      full: new Blob(['full-a']),
      card: new Blob(['card-a']),
      width: 100,
      height: 100,
    });
    const processing = await upsertSnapshot({
      ...base,
      dedupeKey: 'https://b.example',
      url: 'https://b.example/',
      title: 'B',
      siteName: 'B',
      fingerprint: null,
      raw: new Blob(['raw-b']),
      now: 2000,
    });

    const files = unzipSync(new Uint8Array(await (await buildExport()).arrayBuffer()));
    const manifest = JSON.parse(
      strFromU8(files['saves.json'] ?? new Uint8Array()),
    ) as ExportManifest;
    expect(manifest.version).toBe(1);
    expect(manifest.saves.map((s) => s.title)).toEqual(['B', 'A']);
    const a = manifest.saves[1];
    expect(a?.fingerprint).toEqual({ version: 1, title: 'A' });
    expect(a?.images).toEqual({
      full: `images/${ready.id}-full.webp`,
      card: `images/${ready.id}-card.webp`,
    });
    expect(strFromU8(files[`images/${ready.id}-full.webp`] ?? new Uint8Array())).toBe('full-a');
    // A save still processing exports its raw capture.
    expect(manifest.saves[0]?.images).toEqual({ raw: `images/${processing.id}-raw.jpg` });
    expect(files[`images/${processing.id}-raw.jpg`]).toBeDefined();
  });

  it('names the file with the date', () => {
    expect(exportFileName(new Date('2026-10-21T12:00:00Z'))).toBe(
      'visual-tabs-export-2026-10-21.zip',
    );
  });
});
