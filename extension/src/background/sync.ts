import {
  countDeletions,
  countPendingUploads,
  deleteSave,
  getFingerprint,
  getImage,
  getSave,
  getSaveByDedupeKey,
  listDeletions,
  listMissingFullImages,
  listPendingNotes,
  listUploadQueue,
  markDeletionFailed,
  markSynced,
  markUploadFailed,
  nextRetryAt,
  remoteRef,
  removeDeletion,
  resetForNewAccount,
  settleNote,
  storeFullImage,
  storeRemoteNote,
  storeRemoteSave,
  storeUnderstanding,
  type RemoteImages,
} from '@/src/lib/db';
import { publish } from '@/src/lib/events';
import {
  imagePath,
  REMOTE_COLUMNS,
  SCREENSHOT_BUCKET,
  sameUnderstanding,
  understandingOf,
  type NoteResult,
  type RemoteSave,
  type UpsertResult,
} from '@/src/lib/remote';
import { backoffMs, publishSync, type SyncStatus } from '@/src/lib/sync-state';
import type { SaveRecord } from '@/src/lib/types';
import { isNetworkError, supabase, syncConfigured } from './supabase';
import { requestProcessing } from './understand';

const CURSOR_KEY = 'syncCursor';
const ACCOUNT_KEY = 'syncAccount';
const RETRY_ALARM = 'sync-retry';
export const PULL_ALARM = 'sync-pull';
/** How often to check for changes from other devices while the browser is open. */
export const PULL_PERIOD_MINUTES = 5;
/** Re-read this much before the cursor, in case a slower transaction committed late. */
const CURSOR_OVERLAP_MS = 60_000;
const PULL_PAGE = 100;
/** Chrome won't fire an alarm sooner than this; shorter waits use a timer while the worker lives. */
const MIN_ALARM_MS = 30_000;
/** While offline, check back this often. */
const OFFLINE_RETRY_MS = 30_000;

class OfflineError extends Error {}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String(error.message);
  }
  return String(error);
}

/** Throws OfflineError for network failures so the whole run stops instead of burning retries. */
function check<T>(result: { data: T; error: null } | { data: unknown; error: unknown }): T {
  if (result.error) {
    if (isNetworkError(result.error)) throw new OfflineError(errorMessage(result.error));
    throw new Error(errorMessage(result.error));
  }
  return result.data as T;
}

let status: SyncStatus = {
  configured: syncConfigured,
  email: null,
  phase: 'signed-out',
  pendingUploads: 0,
  pendingDeletions: 0,
  lastSyncedAt: null,
  error: null,
};

async function setStatus(next: Partial<SyncStatus>): Promise<void> {
  status = {
    ...status,
    ...next,
    pendingUploads: await countPendingUploads(),
    pendingDeletions: await countDeletions(),
  };
  publishSync(status);
}

export async function getSyncStatus(): Promise<SyncStatus> {
  if (!syncConfigured) return { ...status, phase: 'signed-out' };
  if (!running) {
    const { data } = await supabase().auth.getSession();
    const email = data.session?.user.email ?? null;
    if (!data.session) await setStatus({ phase: 'signed-out', email: null, error: null });
    else if (status.phase === 'signed-out') await setStatus({ phase: 'idle', email });
    else await setStatus({ email });
  }
  return status;
}

// ---- Scheduling --------------------------------------------------------------------------

let running: Promise<void> | null = null;
let again = false;
// requestSync sets the flag while runSync awaits; a function keeps TypeScript from narrowing it.
const runAgain = (): boolean => again;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

/** Runs a sync now, or straight after the one in progress. Never rejects. */
export function requestSync(): Promise<void> {
  if (!syncConfigured) return Promise.resolve();
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      await runSync();
    } while (runAgain());
  })().finally(() => {
    running = null;
  });
  return running;
}

async function scheduleRetry(at: number | null): Promise<void> {
  clearTimeout(retryTimer);
  await browser.alarms.clear(RETRY_ALARM);
  if (at === null) return;
  const wait = Math.max(0, at - Date.now());
  // A timer covers short waits while the worker is alive; the alarm survives it stopping.
  retryTimer = setTimeout(() => void requestSync(), wait);
  await browser.alarms.create(RETRY_ALARM, { when: Date.now() + Math.max(wait, MIN_ALARM_MS) });
}

export function isSyncAlarm(name: string): boolean {
  return name === RETRY_ALARM || name === PULL_ALARM;
}

// ---- The run -----------------------------------------------------------------------------

async function runSync(): Promise<void> {
  let userId: string;
  try {
    const { data } = await supabase().auth.getSession();
    if (!data.session) {
      await setStatus({ phase: 'signed-out', email: null, error: null });
      return;
    }
    userId = data.session.user.id;
    await setStatus({ phase: 'syncing', email: data.session.user.email ?? null });
    await ensureAccount(userId);
  } catch (error) {
    await setStatus({ phase: 'error', error: errorMessage(error) });
    return;
  }

  try {
    await pushDeletions();
    await pushUploads(userId);
    await pushNotes();
    await pull(userId);
    await downloadMissingFullImages();
    await setStatus({ phase: 'idle', error: null, lastSyncedAt: Date.now() });
    await scheduleRetry(await nextRetryAt());
    // Asks the server to describe anything new; runs apart so it never holds up uploads.
    void requestProcessing();
  } catch (error) {
    if (error instanceof OfflineError || isNetworkError(error)) {
      await setStatus({ phase: 'offline', error: null });
      await scheduleRetry(Date.now() + OFFLINE_RETRY_MS);
    } else {
      console.error('[sync] failed', error);
      await setStatus({ phase: 'error', error: errorMessage(error) });
      await scheduleRetry(Date.now() + backoffMs(3));
    }
  }
}

/** A different account on this device starts from its own saves, not the last account's. */
async function ensureAccount(userId: string): Promise<void> {
  const stored = (await browser.storage.local.get(ACCOUNT_KEY))[ACCOUNT_KEY];
  if (stored === userId) return;
  if (typeof stored === 'string') {
    await resetForNewAccount();
    publish({ type: 'changed', id: '*' });
  }
  await browser.storage.local.set({ [ACCOUNT_KEY]: userId });
  await browser.storage.local.remove(CURSOR_KEY);
}

async function removeObjects(paths: string[]): Promise<void> {
  if (!paths.length) return;
  // Leftover files only cost space, so a failure here never fails the sync.
  const { error } = await supabase().storage.from(SCREENSHOT_BUCKET).remove(paths);
  if (error) console.warn('[sync] could not remove old images', paths, error);
}

async function download(path: string | null): Promise<Blob | null> {
  if (!path) return null;
  const result = await supabase().storage.from(SCREENSHOT_BUCKET).download(path);
  if (result.error) {
    if (isNetworkError(result.error)) throw new OfflineError(errorMessage(result.error));
    // The file is gone (or never arrived); keep the save and show it as missing its image.
    console.warn('[sync] could not download', path, result.error);
    return null;
  }
  return result.data;
}

// ---- Upload ------------------------------------------------------------------------------

async function pushDeletions(): Promise<void> {
  for (const pending of await listDeletions(Date.now())) {
    try {
      const paths = check<string[] | null>(
        await supabase().rpc('delete_save', { save_id: pending.id }),
      );
      await removeObjects(paths ?? []);
      await removeDeletion(pending.id);
    } catch (error) {
      if (error instanceof OfflineError) throw error;
      await markDeletionFailed(
        pending.id,
        errorMessage(error),
        Date.now() + backoffMs(pending.attempts + 1),
      );
    }
  }
}

async function pushUploads(userId: string): Promise<void> {
  for (const save of await listUploadQueue(Date.now())) {
    try {
      await upload(userId, save);
    } catch (error) {
      if (error instanceof OfflineError) throw error;
      console.warn('[sync] upload failed', save.url, error);
      await markUploadFailed(
        save.id,
        save.updatedAt,
        errorMessage(error),
        Date.now() + backoffMs(save.sync.attempts + 1),
      );
    }
    publish({ type: 'changed', id: save.id });
    await setStatus({});
  }
}

async function upload(userId: string, save: SaveRecord): Promise<void> {
  const [card, full] = await Promise.all([getImage(save.id, 'card'), getImage(save.id, 'full')]);
  if (!card || !full) throw new Error('The processed images are missing; retry the save.');
  const cardPath = imagePath(userId, save.id, save.updatedAt, 'card');
  const fullPath = imagePath(userId, save.id, save.updatedAt, 'full');
  const bucket = supabase().storage.from(SCREENSHOT_BUCKET);
  // upsert, so a retry after a partly finished upload succeeds.
  const options = { contentType: 'image/webp', upsert: true, cacheControl: '31536000' };
  check(await bucket.upload(cardPath, card, options));
  check(await bucket.upload(fullPath, full, options));

  const result = check<UpsertResult>(
    await supabase().rpc('upsert_save', {
      snapshot: {
        id: save.id,
        dedupe_key: save.dedupeKey,
        url: save.url,
        canonical_url: save.canonicalUrl,
        title: save.title,
        site_name: save.siteName,
        favicon_url: save.faviconUrl,
        created_at: new Date(save.createdAt).toISOString(),
        captured_at: new Date(save.updatedAt).toISOString(),
        image_full_path: fullPath,
        image_card_path: cardPath,
        width: save.width,
        height: save.height,
        fingerprint: (await getFingerprint(save.id)) ?? null,
        palette: save.palette,
        fonts: save.fonts,
      },
    }),
  );
  await removeObjects(result.replaced_paths);

  if (result.deleted) {
    // Deleted on another device after this snapshot was taken.
    await removeObjects([cardPath, fullPath]);
    await deleteSave(save.id, { tombstone: false });
    publish({ type: 'deleted', id: save.id });
    return;
  }
  const { row } = result;
  if (result.applied && row.id === save.id) {
    await markSynced(save.id, save.updatedAt, remoteRef(row));
    await storeUnderstanding(save.id, understandingOf(row));
    return;
  }
  // The server kept another device's save of this page (same page, different id) or a
  // newer snapshot. Adopt the server's version so both devices agree.
  const images: RemoteImages = result.applied
    ? { card, full }
    : { card: await download(row.image_card_path), full: null };
  if (!result.applied) await removeObjects([cardPath, fullPath]);
  await storeRemoteSave(row, images, { replaceId: save.id, expectedUpdatedAt: save.updatedAt });
  if (row.id !== save.id) publish({ type: 'deleted', id: save.id });
}

/**
 * Uploads note edits. The latest edit wins across devices, so an edit that lost to a later
 * one from another device takes that one instead.
 */
async function pushNotes(): Promise<void> {
  for (const save of await listPendingNotes()) {
    const editedAt = save.noteUpdatedAt ?? Date.now();
    try {
      const result = check<NoteResult>(
        await supabase().rpc('set_note', {
          save_id: save.id,
          new_note: save.note ?? '',
          edited_at: new Date(editedAt).toISOString(),
        }),
      );
      const server = result.found
        ? {
            note: result.note,
            noteUpdatedAt: result.note_updated_at ? Date.parse(result.note_updated_at) : null,
          }
        : null;
      if (await settleNote(save.id, editedAt, server)) publish({ type: 'changed', id: save.id });
    } catch (error) {
      if (error instanceof OfflineError) throw error;
      // Stays pending; the next sync (at the latest the periodic one) tries again.
      console.warn('[sync] note upload failed', save.url, error);
    }
  }
}

// ---- Download ----------------------------------------------------------------------------

interface Cursor {
  userId: string;
  at: string;
}

async function pull(userId: string): Promise<void> {
  const stored = (await browser.storage.local.get(CURSOR_KEY))[CURSOR_KEY] as Cursor | undefined;
  let since =
    stored?.userId === userId
      ? new Date(Date.parse(stored.at) - CURSOR_OVERLAP_MS).toISOString()
      : null;
  for (;;) {
    let query = supabase()
      .from('saves')
      .select(REMOTE_COLUMNS)
      .order('updated_at', { ascending: true })
      .limit(PULL_PAGE);
    if (since) query = query.gt('updated_at', since);
    const rows = check<RemoteSave[]>(await query);
    for (const row of rows) {
      await applyPulled(row);
      since = row.updated_at;
    }
    if (since) {
      await browser.storage.local.set({ [CURSOR_KEY]: { userId, at: since } satisfies Cursor });
    }
    if (rows.length < PULL_PAGE) return;
  }
}

/** Decides what a row from the server means for this device. Exported for tests. */
export function pullAction(
  row: Pick<RemoteSave, 'id' | 'captured_at' | 'deleted_at'>,
  local: Pick<SaveRecord, 'id' | 'updatedAt' | 'syncState'> | undefined,
  sameKey: Pick<SaveRecord, 'id' | 'syncState'> | undefined,
): 'delete-local' | 'store' | 'replace-same-key' | 'skip' {
  if (row.deleted_at) {
    if (!local) return 'skip';
    // A local snapshot taken after the delete wins, and its upload brings the save back.
    const keep = local.syncState === 'pending' && local.updatedAt > Date.parse(row.deleted_at);
    return keep ? 'skip' : 'delete-local';
  }
  if (local) {
    // A local snapshot not yet uploaded is reconciled by its upload instead.
    if (local.syncState === 'pending') return 'skip';
    return Date.parse(row.captured_at) > local.updatedAt ? 'store' : 'skip';
  }
  if (sameKey && sameKey.id !== row.id) {
    return sameKey.syncState === 'pending' ? 'skip' : 'replace-same-key';
  }
  return 'store';
}

async function applyPulled(row: RemoteSave): Promise<void> {
  const local = await getSave(row.id);
  const sameKey = row.deleted_at ? undefined : await getSaveByDedupeKey(row.dedupe_key);
  const action = pullAction(row, local, sameKey);
  if (action === 'skip') {
    // The snapshot is the same, but the server may have described it, or another device
    // edited its note, since.
    if (!local || row.deleted_at) return;
    let changed = false;
    if (!sameUnderstanding(local.understanding, understandingOf(row))) {
      await storeUnderstanding(row.id, understandingOf(row));
      changed = true;
    }
    if (await storeRemoteNote(row.id, row)) changed = true;
    if (changed) publish({ type: 'changed', id: row.id });
    return;
  }
  if (action === 'delete-local') {
    await deleteSave(row.id, { tombstone: false });
    publish({ type: 'deleted', id: row.id });
    return;
  }
  // The full image follows in downloadMissingFullImages, so the wall fills in quickly.
  const card = await download(row.image_card_path);
  const replaceId = action === 'replace-same-key' ? (sameKey?.id ?? null) : null;
  await storeRemoteSave(row, { card, full: null }, { replaceId });
  if (replaceId) publish({ type: 'deleted', id: replaceId });
  publish({ type: 'changed', id: row.id });
}

/** Downloads full images for synced saves that only have their card image here. */
export async function downloadMissingFullImages(): Promise<void> {
  for (const save of await listMissingFullImages()) {
    const remote = save.sync.remote;
    if (!remote?.fullPath) continue;
    const blob = await download(remote.fullPath);
    if (blob) await storeFullImage(save.id, save.updatedAt, blob);
  }
}

// ---- Sign-in -----------------------------------------------------------------------------

export async function sendCode(email: string): Promise<void> {
  const { error } = await supabase().auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true },
  });
  if (error) throw new Error(friendlyAuthError(error));
}

export async function verifyCode(email: string, code: string): Promise<SyncStatus> {
  const { error } = await supabase().auth.verifyOtp({ email, token: code, type: 'email' });
  if (error) throw new Error(friendlyAuthError(error));
  void requestSync();
  return getSyncStatus();
}

export async function signOut(): Promise<SyncStatus> {
  // Local saves stay; they're also on the server.
  await supabase().auth.signOut({ scope: 'local' });
  await scheduleRetry(null);
  return getSyncStatus();
}

function friendlyAuthError(error: unknown): string {
  if (isNetworkError(error)) return "Couldn't reach the server. Check your connection.";
  const message = errorMessage(error);
  if (/expired|invalid/i.test(message)) return 'That code is wrong or has expired.';
  if (/rate limit|security purposes/i.test(message)) {
    return 'Too many codes requested. Wait a minute and try again.';
  }
  return message;
}
