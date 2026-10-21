import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPObjectStore,
  type IDBPTransaction,
  type StoreNames,
} from 'idb';
import type { RemoteSave } from './remote';
import type { Fingerprint, ImageVariant, RemoteRef, SaveRecord, SyncInfo } from './types';
import { dedupeKey } from './url';

export const DB_NAME = 'visual-memory';
const DB_VERSION = 3;

interface ImageRow {
  saveId: string;
  variant: ImageVariant;
  blob: Blob;
}

/** A save deleted on this device that the server hasn't heard about yet. */
export interface PendingDeletion {
  id: string;
  attempts: number;
  nextAttemptAt: number;
  error: string | null;
}

interface Schema extends DBSchema {
  saves: {
    key: string;
    value: SaveRecord;
    indexes: { byDedupeKey: string; byUpdatedAt: number; byStatus: string; bySyncState: string };
  };
  deletions: {
    key: string;
    value: PendingDeletion;
  };
  fingerprints: {
    key: string;
    value: { saveId: string; fingerprint: Fingerprint };
  };
  images: {
    key: [string, ImageVariant];
    value: ImageRow;
    indexes: { bySaveId: string };
  };
}

export type Db = IDBPDatabase<Schema>;

type SavesStore = IDBPObjectStore<Schema, ArrayLike<StoreNames<Schema>>, 'saves', 'versionchange'>;

/**
 * Version 1 keyed saves on the canonical URL. Re-keys them on the page URL, which is what
 * new saves use. A save whose new key another save already has keeps its old key, so the
 * migration never merges or drops saves.
 */
async function rekeyByPageUrl(saves: SavesStore): Promise<void> {
  const records = await saves.getAll();
  const taken = new Set(records.map((record) => record.dedupeKey));
  for (const record of records) {
    let key: string;
    try {
      key = dedupeKey(record.url);
    } catch {
      continue;
    }
    if (key === record.dedupeKey || taken.has(key)) continue;
    taken.delete(record.dedupeKey);
    taken.add(key);
    await saves.put({ ...record, dedupeKey: key });
  }
}

/** Version 3 adds sync state. Saves from before then haven't been uploaded. */
async function addSyncFields(saves: SavesStore): Promise<void> {
  for (const record of await saves.getAll()) {
    await saves.put({ ...record, syncState: 'pending', sync: freshSync(null) });
  }
}

function freshSync(remote: RemoteRef | null): SyncInfo {
  return { attempts: 0, nextAttemptAt: 0, error: null, remote };
}

let dbPromise: Promise<Db> | null = null;

export function getDb(): Promise<Db> {
  dbPromise ??= openDB<Schema>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        const saves = db.createObjectStore('saves', { keyPath: 'id' });
        saves.createIndex('byDedupeKey', 'dedupeKey', { unique: true });
        saves.createIndex('byUpdatedAt', 'updatedAt');
        saves.createIndex('byStatus', 'status');
        db.createObjectStore('fingerprints', { keyPath: 'saveId' });
        const images = db.createObjectStore('images', { keyPath: ['saveId', 'variant'] });
        images.createIndex('bySaveId', 'saveId');
      }
      if (oldVersion < 3) {
        tx.objectStore('saves').createIndex('bySyncState', 'syncState');
        db.createObjectStore('deletions', { keyPath: 'id' });
      }
      // Only IndexedDB requests are awaited inside, so the upgrade transaction stays open.
      const saves = tx.objectStore('saves');
      if (oldVersion === 1) void rekeyByPageUrl(saves).then(() => addSyncFields(saves));
      else if (oldVersion === 2) void addSyncFields(saves);
    },
  }).catch((error: unknown) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

/** For tests: forget the cached connection so the next call opens a fresh database. */
export function resetDbForTests(): void {
  dbPromise = null;
}

export interface NewSnapshot {
  dedupeKey: string;
  url: string;
  canonicalUrl: string | null;
  title: string;
  siteName: string;
  faviconUrl: string | null;
  width: number;
  height: number;
  palette: string[];
  fonts: string[];
  fingerprint: Fingerprint | null;
  raw: Blob;
  now: number;
}

/**
 * Stores a new capture in one transaction. If a save with the same dedupe key exists,
 * its snapshot is replaced (keeping its id, creation time and note) instead of adding a duplicate.
 */
export async function upsertSnapshot(
  snapshot: NewSnapshot,
  newId: () => string = () => crypto.randomUUID(),
): Promise<SaveRecord> {
  const db = await getDb();
  const tx = db.transaction(['saves', 'fingerprints', 'images'], 'readwrite');
  const saves = tx.objectStore('saves');
  const existing = await saves.index('byDedupeKey').get(snapshot.dedupeKey);

  const record: SaveRecord = {
    id: existing?.id ?? newId(),
    dedupeKey: snapshot.dedupeKey,
    url: snapshot.url,
    canonicalUrl: snapshot.canonicalUrl,
    title: snapshot.title,
    siteName: snapshot.siteName,
    faviconUrl: snapshot.faviconUrl,
    createdAt: existing?.createdAt ?? snapshot.now,
    updatedAt: snapshot.now,
    status: 'processing',
    error: null,
    width: snapshot.width,
    height: snapshot.height,
    palette: snapshot.palette,
    fonts: snapshot.fonts,
    note: existing?.note ?? null,
    // A new snapshot needs uploading. The server's copy (if any) is kept for reconciling.
    syncState: 'pending',
    sync: freshSync(existing?.sync.remote ?? null),
  };

  const images = tx.objectStore('images');
  if (existing) {
    for (const key of await images.index('bySaveId').getAllKeys(existing.id)) {
      await images.delete(key);
    }
  }
  await saves.put(record);
  await images.put({ saveId: record.id, variant: 'raw', blob: snapshot.raw });
  const fingerprints = tx.objectStore('fingerprints');
  if (snapshot.fingerprint) {
    await fingerprints.put({ saveId: record.id, fingerprint: snapshot.fingerprint });
  } else {
    await fingerprints.delete(record.id);
  }
  await tx.done;
  return record;
}

/**
 * Stores the processed images and marks the save ready, dropping the raw capture.
 * Does nothing if the save was deleted or re-captured since processing started.
 */
export async function completeProcessing(
  id: string,
  expectedUpdatedAt: number,
  result: { full: Blob; card: Blob; width: number; height: number },
): Promise<boolean> {
  const db = await getDb();
  const tx = db.transaction(['saves', 'images'], 'readwrite');
  const saves = tx.objectStore('saves');
  const record = await saves.get(id);
  if (record?.updatedAt !== expectedUpdatedAt) {
    await tx.done;
    return false;
  }
  const images = tx.objectStore('images');
  await images.put({ saveId: id, variant: 'full', blob: result.full });
  await images.put({ saveId: id, variant: 'card', blob: result.card });
  await images.delete([id, 'raw']);
  await saves.put({
    ...record,
    status: 'ready',
    error: null,
    width: result.width,
    height: result.height,
  });
  await tx.done;
  return true;
}

export async function setStatus(
  id: string,
  status: SaveRecord['status'],
  error: string | null = null,
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('saves', 'readwrite');
  const record = await tx.store.get(id);
  if (record) await tx.store.put({ ...record, status, error });
  await tx.done;
}

/** Every save, most recently captured first. */
export async function listSaves(): Promise<SaveRecord[]> {
  const db = await getDb();
  const all = await db.getAllFromIndex('saves', 'byUpdatedAt');
  return all.reverse();
}

export async function getSave(id: string): Promise<SaveRecord | undefined> {
  return (await getDb()).get('saves', id);
}

export async function listSavesWithStatus(status: SaveRecord['status']): Promise<SaveRecord[]> {
  return (await getDb()).getAllFromIndex('saves', 'byStatus', status);
}

export async function getFingerprint(id: string): Promise<Fingerprint | undefined> {
  return (await (await getDb()).get('fingerprints', id))?.fingerprint;
}

export async function getImage(id: string, variant: ImageVariant): Promise<Blob | undefined> {
  return (await (await getDb()).get('images', [id, variant]))?.blob;
}

/** The best image available for a given use: the processed one, else the raw capture. */
export async function getDisplayImage(
  id: string,
  variant: 'full' | 'card',
): Promise<Blob | undefined> {
  return (await getImage(id, variant)) ?? (await getImage(id, 'raw'));
}

/**
 * Deletes a save and its images. With `tombstone` (the default, for deletes the user makes),
 * the delete is queued for upload so other devices remove the save too.
 */
export async function deleteSave(id: string, { tombstone = true } = {}): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['saves', 'fingerprints', 'images', 'deletions'], 'readwrite');
  await removeSaveIn(tx, id);
  if (tombstone) {
    await tx.objectStore('deletions').put({ id, attempts: 0, nextAttemptAt: 0, error: null });
  }
  await tx.done;
}

type WriteTx = IDBPTransaction<Schema, StoreNames<Schema>[], 'readwrite'>;

async function removeSaveIn(tx: WriteTx, id: string): Promise<void> {
  const images = tx.objectStore('images');
  for (const key of await images.index('bySaveId').getAllKeys(id)) {
    await images.delete(key);
  }
  await tx.objectStore('fingerprints').delete(id);
  await tx.objectStore('saves').delete(id);
}

// ---- Sync ------------------------------------------------------------------------------

/** Saves whose current snapshot is ready and due for upload, oldest capture first. */
export async function listUploadQueue(now: number): Promise<SaveRecord[]> {
  const pending = await (await getDb()).getAllFromIndex('saves', 'bySyncState', 'pending');
  return pending
    .filter((s) => s.status === 'ready' && s.sync.nextAttemptAt <= now)
    .sort((a, b) => a.updatedAt - b.updatedAt);
}

/** Every save not yet uploaded, whatever its processing state. */
export async function countPendingUploads(): Promise<number> {
  return (await getDb()).countFromIndex('saves', 'bySyncState', 'pending');
}

/** The earliest time a waiting upload or delete may be retried, or null if nothing waits. */
export async function nextRetryAt(): Promise<number | null> {
  const db = await getDb();
  const times = [
    ...(await db.getAllFromIndex('saves', 'bySyncState', 'pending'))
      .filter((s) => s.status === 'ready')
      .map((s) => s.sync.nextAttemptAt),
    ...(await db.getAll('deletions')).map((d) => d.nextAttemptAt),
  ];
  return times.length ? Math.min(...times) : null;
}

/** Records a failed upload of the snapshot taken at `capturedAt`. */
export async function markUploadFailed(
  id: string,
  capturedAt: number,
  error: string,
  nextAttemptAt: number,
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('saves', 'readwrite');
  const record = await tx.store.get(id);
  if (record?.updatedAt === capturedAt && record.syncState === 'pending') {
    await tx.store.put({
      ...record,
      sync: { ...record.sync, attempts: record.sync.attempts + 1, nextAttemptAt, error },
    });
  }
  await tx.done;
}

/** Marks the snapshot taken at `capturedAt` as uploaded. A newer local snapshot stays pending. */
export async function markSynced(id: string, capturedAt: number, remote: RemoteRef): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('saves', 'readwrite');
  const record = await tx.store.get(id);
  if (record) {
    const current = record.updatedAt === capturedAt;
    await tx.store.put({
      ...record,
      syncState: current ? 'synced' : record.syncState,
      sync: current ? freshSync(remote) : { ...record.sync, remote },
    });
  }
  await tx.done;
}

export function remoteRef(row: RemoteSave): RemoteRef {
  return {
    capturedAt: Date.parse(row.captured_at),
    fullPath: row.image_full_path,
    cardPath: row.image_card_path,
  };
}

export interface RemoteImages {
  card: Blob | null;
  full: Blob | null;
}

/**
 * Stores the server's version of a save, replacing the local save `replaceId` (which may
 * have a different id, when two devices saved the same page). When `expectedUpdatedAt` is
 * given, does nothing if `replaceId` was re-captured in the meantime. Returns whether it wrote.
 */
export async function storeRemoteSave(
  row: RemoteSave,
  images: RemoteImages,
  {
    replaceId = null,
    expectedUpdatedAt,
  }: { replaceId?: string | null; expectedUpdatedAt?: number } = {},
): Promise<boolean> {
  const db = await getDb();
  const tx = db.transaction(['saves', 'fingerprints', 'images'], 'readwrite');
  const saves = tx.objectStore('saves');
  if (replaceId && expectedUpdatedAt !== undefined) {
    const current = await saves.get(replaceId);
    if (current?.updatedAt !== expectedUpdatedAt) {
      await tx.done;
      return false;
    }
  }
  const previous = (replaceId && (await saves.get(replaceId))) || (await saves.get(row.id));
  for (const id of new Set([replaceId, row.id])) {
    if (id) await removeSaveIn(tx, id);
  }
  const record: SaveRecord = {
    id: row.id,
    dedupeKey: row.dedupe_key,
    url: row.url,
    canonicalUrl: row.canonical_url,
    title: row.title,
    siteName: row.site_name,
    faviconUrl: row.favicon_url,
    createdAt: Date.parse(row.created_at),
    updatedAt: Date.parse(row.captured_at),
    status: images.card ? 'ready' : 'failed',
    error: images.card ? null : "This save's image is missing from your backup.",
    width: row.width ?? 0,
    height: row.height ?? 0,
    palette: row.palette,
    fonts: row.fonts,
    note: row.note ?? previous?.note ?? null,
    syncState: 'synced',
    sync: freshSync(remoteRef(row)),
  };
  await saves.put(record);
  const imageStore = tx.objectStore('images');
  if (images.card) await imageStore.put({ saveId: row.id, variant: 'card', blob: images.card });
  if (images.full) await imageStore.put({ saveId: row.id, variant: 'full', blob: images.full });
  if (row.fingerprint) {
    await tx.objectStore('fingerprints').put({ saveId: row.id, fingerprint: row.fingerprint });
  }
  await tx.done;
  return true;
}

export async function getSaveByDedupeKey(key: string): Promise<SaveRecord | undefined> {
  return (await getDb()).getFromIndex('saves', 'byDedupeKey', key);
}

/** Synced saves whose full image hasn't been downloaded yet. */
export async function listMissingFullImages(): Promise<SaveRecord[]> {
  const db = await getDb();
  const synced = await db.getAllFromIndex('saves', 'bySyncState', 'synced');
  const missing: SaveRecord[] = [];
  for (const record of synced) {
    if (!record.sync.remote?.fullPath) continue;
    if (!(await db.getKey('images', [record.id, 'full']))) missing.push(record);
  }
  return missing;
}

/** Stores a downloaded full image, unless the save was re-captured since. */
export async function storeFullImage(id: string, capturedAt: number, blob: Blob): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['saves', 'images'], 'readwrite');
  const record = await tx.objectStore('saves').get(id);
  if (record?.updatedAt === capturedAt) {
    await tx.objectStore('images').put({ saveId: id, variant: 'full', blob });
  }
  await tx.done;
}

export async function listDeletions(now: number): Promise<PendingDeletion[]> {
  return (await (await getDb()).getAll('deletions')).filter((d) => d.nextAttemptAt <= now);
}

export async function countDeletions(): Promise<number> {
  return (await getDb()).count('deletions');
}

export async function removeDeletion(id: string): Promise<void> {
  await (await getDb()).delete('deletions', id);
}

export async function markDeletionFailed(
  id: string,
  error: string,
  nextAttemptAt: number,
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('deletions', 'readwrite');
  const pending = await tx.store.get(id);
  if (pending) {
    await tx.store.put({ ...pending, attempts: pending.attempts + 1, nextAttemptAt, error });
  }
  await tx.done;
}

/**
 * Called when a different account signs in on this device. Saves that came from the
 * previous account are removed (they're safe on the server); saves never uploaded stay and
 * will upload to the new account.
 */
export async function resetForNewAccount(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['saves', 'fingerprints', 'images', 'deletions'], 'readwrite');
  const saves = tx.objectStore('saves');
  for (const record of await saves.getAll()) {
    if (record.syncState === 'synced') await removeSaveIn(tx, record.id);
    else await saves.put({ ...record, sync: freshSync(null) });
  }
  await tx.objectStore('deletions').clear();
  await tx.done;
}
