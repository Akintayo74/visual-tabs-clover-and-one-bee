import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPObjectStore,
  type StoreNames,
} from 'idb';
import type { Fingerprint, ImageVariant, SaveRecord } from './types';
import { dedupeKey } from './url';

export const DB_NAME = 'visual-memory';
const DB_VERSION = 2;

interface ImageRow {
  saveId: string;
  variant: ImageVariant;
  blob: Blob;
}

interface Schema extends DBSchema {
  saves: {
    key: string;
    value: SaveRecord;
    indexes: { byDedupeKey: string; byUpdatedAt: number; byStatus: string };
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

/**
 * Version 1 keyed saves on the canonical URL. Re-keys them on the page URL, which is what
 * new saves use. A save whose new key another save already has keeps its old key, so the
 * migration never merges or drops saves.
 */
async function rekeyByPageUrl(
  saves: IDBPObjectStore<Schema, ArrayLike<StoreNames<Schema>>, 'saves', 'versionchange'>,
): Promise<void> {
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
      if (oldVersion === 1) {
        // Only IndexedDB requests are awaited inside, so the upgrade transaction stays open.
        void rekeyByPageUrl(tx.objectStore('saves'));
      }
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

export async function deleteSave(id: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['saves', 'fingerprints', 'images'], 'readwrite');
  const images = tx.objectStore('images');
  for (const key of await images.index('bySaveId').getAllKeys(id)) {
    await images.delete(key);
  }
  await tx.objectStore('fingerprints').delete(id);
  await tx.objectStore('saves').delete(id);
  await tx.done;
}
