import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  completeProcessing,
  deleteSave,
  getDisplayImage,
  getFingerprint,
  getImage,
  listSaves,
  listSavesWithStatus,
  resetDbForTests,
  upsertSnapshot,
  type NewSnapshot,
} from '@/src/lib/db';
import type { Fingerprint } from '@/src/lib/types';

const fingerprint = { version: 1, title: 'Studio' } as Fingerprint;

function snapshot(overrides: Partial<NewSnapshot> = {}): NewSnapshot {
  return {
    dedupeKey: 'https://studio.design',
    url: 'https://studio.design/',
    canonicalUrl: null,
    title: 'Studio',
    siteName: 'Studio',
    faviconUrl: null,
    width: 2880,
    height: 1800,
    palette: ['#000000'],
    fonts: ['Inter'],
    fingerprint,
    raw: new Blob(['raw'], { type: 'image/jpeg' }),
    now: 1000,
    ...overrides,
  };
}

const processed = {
  full: new Blob(['full'], { type: 'image/webp' }),
  card: new Blob(['card'], { type: 'image/webp' }),
  width: 2400,
  height: 1500,
};

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
});

describe('upsertSnapshot', () => {
  it('stores a new save as processing, with its raw capture and fingerprint', async () => {
    const record = await upsertSnapshot(snapshot());
    expect(record).toMatchObject({ status: 'processing', createdAt: 1000, updatedAt: 1000 });
    expect(await getImage(record.id, 'raw')).toBeDefined();
    expect(await getFingerprint(record.id)).toEqual(fingerprint);
  });

  it('re-saving the same page replaces the snapshot and keeps id, creation time and note', async () => {
    const first = await upsertSnapshot(snapshot());
    await completeProcessing(first.id, first.updatedAt, processed);

    const second = await upsertSnapshot(
      snapshot({ title: 'Studio (new)', now: 5000, fingerprint: null }),
    );
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({
      createdAt: 1000,
      updatedAt: 5000,
      title: 'Studio (new)',
      status: 'processing',
    });

    const all = await listSaves();
    expect(all).toHaveLength(1);
    // Old processed images are gone; the new raw capture is there.
    expect(await getImage(first.id, 'card')).toBeUndefined();
    expect(await getImage(first.id, 'raw')).toBeDefined();
    expect(await getFingerprint(first.id)).toBeUndefined();
  });

  it('keeps different pages separate', async () => {
    await upsertSnapshot(snapshot());
    await upsertSnapshot(snapshot({ dedupeKey: 'https://studio.design/work', now: 2000 }));
    expect((await listSaves()).map((s) => s.dedupeKey)).toEqual([
      'https://studio.design/work',
      'https://studio.design',
    ]);
  });
});

describe('completeProcessing', () => {
  it('stores the WebP versions, drops the raw capture and marks the save ready', async () => {
    const record = await upsertSnapshot(snapshot());
    expect(await completeProcessing(record.id, record.updatedAt, processed)).toBe(true);
    const [saved] = await listSaves();
    expect(saved).toMatchObject({ status: 'ready', width: 2400, height: 1500 });
    expect(await getImage(record.id, 'raw')).toBeUndefined();
    expect(await getDisplayImage(record.id, 'card')).toBeDefined();
    expect(await listSavesWithStatus('processing')).toEqual([]);
  });

  it('does not overwrite a newer snapshot taken while processing ran', async () => {
    const first = await upsertSnapshot(snapshot());
    await upsertSnapshot(snapshot({ now: 2000 }));
    expect(await completeProcessing(first.id, first.updatedAt, processed)).toBe(false);
    expect(await getImage(first.id, 'raw')).toBeDefined();
    expect((await listSaves())[0]?.status).toBe('processing');
  });

  it('does nothing for a deleted save', async () => {
    const record = await upsertSnapshot(snapshot());
    await deleteSave(record.id);
    expect(await completeProcessing(record.id, record.updatedAt, processed)).toBe(false);
    expect(await listSaves()).toEqual([]);
  });
});

describe('deleteSave', () => {
  it('removes the save, its images and its fingerprint', async () => {
    const record = await upsertSnapshot(snapshot());
    await completeProcessing(record.id, record.updatedAt, processed);
    await deleteSave(record.id);
    expect(await listSaves()).toEqual([]);
    expect(await getImage(record.id, 'full')).toBeUndefined();
    expect(await getImage(record.id, 'card')).toBeUndefined();
    expect(await getFingerprint(record.id)).toBeUndefined();
  });
});
