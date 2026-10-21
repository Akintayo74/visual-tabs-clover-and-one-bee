import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  completeProcessing,
  countPendingUploads,
  deleteSave,
  getImage,
  getSave,
  hasUnprocessedSaves,
  listDeletions,
  listMissingFullImages,
  listSaves,
  listUploadQueue,
  markDeletionFailed,
  markSynced,
  markUploadFailed,
  nextRetryAt,
  remoteRef,
  resetDbForTests,
  resetForNewAccount,
  storeFullImage,
  storeRemoteSave,
  storeUnderstanding,
  upsertSnapshot,
  type NewSnapshot,
} from '@/src/lib/db';
import type { RemoteSave } from '@/src/lib/remote';

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
    palette: [],
    fonts: [],
    fingerprint: null,
    raw: new Blob(['raw']),
    now: 1000,
    ...overrides,
  };
}

const images = { full: new Blob(['full']), card: new Blob(['card']), width: 2400, height: 1500 };

function row(overrides: Partial<RemoteSave> = {}): RemoteSave {
  return {
    id: 'remote-1',
    dedupe_key: 'https://studio.design',
    url: 'https://studio.design/',
    canonical_url: null,
    title: 'Studio',
    site_name: 'Studio',
    favicon_url: null,
    created_at: '2026-10-01T00:00:00.000Z',
    captured_at: '2026-10-02T00:00:00.000Z',
    updated_at: '2026-10-02T00:00:01.000Z',
    deleted_at: null,
    image_full_path: 'u/remote-1/full.webp',
    image_card_path: 'u/remote-1/card.webp',
    width: 2400,
    height: 1500,
    fingerprint: null,
    palette: ['#fff'],
    fonts: ['Inter'],
    note: null,
    status: 'ready',
    error: null,
    description: 'A studio site.',
    recall_phrases: ['studio with big type'],
    tags: ['studio'],
    ...overrides,
  };
}

async function readySave(overrides: Partial<NewSnapshot> = {}) {
  const record = await upsertSnapshot(snapshot(overrides));
  await completeProcessing(record.id, record.updatedAt, images);
  return record;
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
});

describe('the upload queue', () => {
  it('lists processed saves that are due, oldest first, and skips ones still processing', async () => {
    const newer = await readySave({ dedupeKey: 'https://b.example', now: 3000 });
    const older = await readySave({ dedupeKey: 'https://a.example', now: 2000 });
    await upsertSnapshot(snapshot({ dedupeKey: 'https://c.example', now: 4000 }));
    expect((await listUploadQueue(Date.now())).map((s) => s.id)).toEqual([older.id, newer.id]);
    expect(await countPendingUploads()).toBe(3);
  });

  it('waits after a failure, and counts attempts', async () => {
    const save = await readySave();
    await markUploadFailed(save.id, save.updatedAt, 'boom', 50_000);
    expect(await listUploadQueue(10_000)).toEqual([]);
    expect(await listUploadQueue(50_000)).toHaveLength(1);
    expect((await getSave(save.id))?.sync).toMatchObject({ attempts: 1, error: 'boom' });
    expect(await nextRetryAt()).toBe(50_000);
  });

  it('marks a save synced, but not if it was re-captured during the upload', async () => {
    const save = await readySave();
    const remote = { capturedAt: 1000, fullPath: 'f', cardPath: 'c' };
    await markSynced(save.id, save.updatedAt, remote);
    expect(await getSave(save.id)).toMatchObject({ syncState: 'synced', sync: { remote } });

    await upsertSnapshot(snapshot({ now: 5000 }));
    await markSynced(save.id, 1000, remote);
    expect(await getSave(save.id)).toMatchObject({ syncState: 'pending', sync: { remote } });
    expect(await nextRetryAt()).toBeNull(); // Still processing; nothing to retry yet.
  });

  it('a re-save after syncing needs uploading again and keeps the server reference', async () => {
    const save = await readySave();
    const remote = { capturedAt: 1000, fullPath: 'f', cardPath: 'c' };
    await markSynced(save.id, save.updatedAt, remote);
    await upsertSnapshot(snapshot({ now: 7000 }));
    expect(await getSave(save.id)).toMatchObject({
      syncState: 'pending',
      sync: { attempts: 0, remote },
    });
  });
});

describe('storeRemoteSave', () => {
  it('stores a save from the server as synced and ready', async () => {
    await storeRemoteSave(row(), { card: new Blob(['c']), full: null });
    expect(await getSave('remote-1')).toMatchObject({
      status: 'ready',
      syncState: 'synced',
      updatedAt: Date.parse('2026-10-02T00:00:00.000Z'),
      sync: { remote: remoteRef(row()) },
    });
    expect(await getImage('remote-1', 'card')).toBeDefined();
    expect((await listMissingFullImages()).map((s) => s.id)).toEqual(['remote-1']);
    await storeFullImage('remote-1', Date.parse('2026-10-02T00:00:00.000Z'), new Blob(['f']));
    expect(await listMissingFullImages()).toEqual([]);
  });

  it('shows a save whose image is missing on the server as failed instead of dropping it', async () => {
    await storeRemoteSave(row(), { card: null, full: null });
    expect(await getSave('remote-1')).toMatchObject({ status: 'failed' });
  });

  it("replaces a local save of the same page with the server's, under the server's id", async () => {
    const local = await readySave();
    expect(
      await storeRemoteSave(
        row(),
        { card: new Blob(['c']), full: new Blob(['f']) },
        {
          replaceId: local.id,
          expectedUpdatedAt: local.updatedAt,
        },
      ),
    ).toBe(true);
    expect((await listSaves()).map((s) => s.id)).toEqual(['remote-1']);
    expect(await getImage(local.id, 'card')).toBeUndefined();
  });

  it('leaves a local save alone if it was re-captured meanwhile', async () => {
    const local = await readySave();
    await upsertSnapshot(snapshot({ now: 9000 }));
    expect(
      await storeRemoteSave(
        row(),
        { card: null, full: null },
        {
          replaceId: local.id,
          expectedUpdatedAt: local.updatedAt,
        },
      ),
    ).toBe(false);
    expect((await listSaves()).map((s) => s.id)).toEqual([local.id]);
  });
});

describe('deletions', () => {
  it('back off after a failure', async () => {
    const save = await readySave();
    await deleteSave(save.id);
    await markDeletionFailed(save.id, 'boom', 60_000);
    expect(await listDeletions(1000)).toEqual([]);
    expect(await listDeletions(60_000)).toMatchObject([{ id: save.id, attempts: 1 }]);
  });
});

describe('resetForNewAccount', () => {
  it("removes the previous account's synced saves and keeps ones never uploaded", async () => {
    await storeRemoteSave(row(), { card: new Blob(['c']), full: null });
    const local = await readySave({ dedupeKey: 'https://local.example' });
    await deleteSave('remote-1');
    await storeRemoteSave(row({ id: 'remote-2', dedupe_key: 'https://r2.example' }), {
      card: null,
      full: null,
    });
    await resetForNewAccount();
    expect((await listSaves()).map((s) => s.id)).toEqual([local.id]);
    expect(await listDeletions(Date.now())).toEqual([]);
  });
});

describe('understanding from the server', () => {
  it('stores what the server made of a save, and keeps it through a re-save', async () => {
    await storeRemoteSave(row({ status: 'pending', description: null }), {
      card: new Blob(['c']),
      full: null,
    });
    expect((await getSave('remote-1'))?.understanding).toMatchObject({ status: 'pending' });
    expect(await hasUnprocessedSaves()).toBe(true);

    await storeUnderstanding('remote-1', {
      status: 'ready',
      error: null,
      description: 'Big type.',
      recallPhrases: ['big type site'],
      tags: ['type'],
    });
    expect(await hasUnprocessedSaves()).toBe(false);

    await upsertSnapshot(snapshot({ now: 9_000_000_000_000 }));
    const resaved = await getSave('remote-1');
    expect(resaved?.syncState).toBe('pending');
    // Still findable by its old description until the new snapshot is described.
    expect(resaved?.understanding?.description).toBe('Big type.');
  });

  it('ignores saves that are not uploaded yet', async () => {
    await readySave();
    expect(await hasUnprocessedSaves()).toBe(false);
  });
});
