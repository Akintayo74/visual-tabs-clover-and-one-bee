import { describe, expect, it } from 'vitest';
import { pullAction } from '@/src/background/sync';
import { isNetworkError } from '@/src/background/supabase';
import { imagePath } from '@/src/lib/remote';
import { backoffMs, type SyncStatus } from '@/src/lib/sync-state';
import type { SaveRecord } from '@/src/lib/types';
import { describeSync } from '@/src/newtab/account-panel';
import { syncBadge } from '@/src/newtab/wall';

const T = (iso: string) => Date.parse(iso);

describe('pullAction', () => {
  const row = { id: 'r', captured_at: '2026-10-02T00:00:00Z', deleted_at: null };

  it('stores rows new to this device', () => {
    expect(pullAction(row, undefined, undefined)).toBe('store');
  });

  it('stores a newer snapshot over a synced one, and ignores the same or older', () => {
    const local = { id: 'r', syncState: 'synced' as const, updatedAt: T('2026-10-01T00:00:00Z') };
    expect(pullAction(row, local, undefined)).toBe('store');
    expect(pullAction(row, { ...local, updatedAt: T(row.captured_at) }, undefined)).toBe('skip');
  });

  it('leaves saves waiting to upload for their upload to reconcile', () => {
    const local = { id: 'r', syncState: 'pending' as const, updatedAt: 0 };
    expect(pullAction(row, local, undefined)).toBe('skip');
    expect(pullAction(row, undefined, { id: 'other', syncState: 'pending' })).toBe('skip');
  });

  it('replaces a synced local save of the same page that the server merged away', () => {
    expect(pullAction(row, undefined, { id: 'other', syncState: 'synced' })).toBe(
      'replace-same-key',
    );
  });

  it('deletes locally unless this device captured the page after the delete', () => {
    const deleted = { ...row, deleted_at: '2026-10-05T00:00:00Z' };
    const synced = { id: 'r', syncState: 'synced' as const, updatedAt: T('2026-10-02T00:00:00Z') };
    expect(pullAction(deleted, synced, undefined)).toBe('delete-local');
    expect(pullAction(deleted, { ...synced, syncState: 'pending' }, undefined)).toBe(
      'delete-local',
    );
    expect(
      pullAction(
        deleted,
        { ...synced, syncState: 'pending', updatedAt: T('2026-10-06T00:00:00Z') },
        undefined,
      ),
    ).toBe('skip');
    expect(pullAction(deleted, undefined, undefined)).toBe('skip');
  });
});

describe('backoffMs', () => {
  it('doubles from 5 seconds up to 15 minutes, with jitter', () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4].map((n) => backoffMs(n, mid))).toEqual([5000, 10000, 20000, 40000]);
    expect(backoffMs(30, mid)).toBe(15 * 60_000);
    expect(backoffMs(1, () => 0)).toBe(4000);
    expect(backoffMs(1, () => 1)).toBe(6000);
  });
});

describe('isNetworkError', () => {
  it('tells "couldn\'t reach the server" apart from "the server said no"', () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isNetworkError({ message: 'TypeError: Failed to fetch' })).toBe(true);
    expect(isNetworkError(new Error('new row violates row-level security policy'))).toBe(false);
  });
});

describe('imagePath', () => {
  it("puts each user's images in their own folder, apart per snapshot", () => {
    expect(imagePath('u', 's', 123, 'card')).toBe('u/s/123-card.webp');
  });
});

describe('describeSync', () => {
  const base: SyncStatus = {
    configured: true,
    email: 'a@b.c',
    phase: 'idle',
    pendingUploads: 0,
    pendingDeletions: 0,
    lastSyncedAt: null,
    error: null,
  };
  it('says what state backups are in', () => {
    expect(describeSync(base)).toBe('All saves backed up');
    expect(describeSync({ ...base, phase: 'syncing', pendingUploads: 2 })).toBe(
      'Backing up 2 saves…',
    );
    expect(describeSync({ ...base, phase: 'offline', pendingUploads: 1 })).toBe(
      "Offline. 1 save will back up when you're online",
    );
    expect(describeSync({ ...base, phase: 'signed-out', email: null, pendingUploads: 3 })).toBe(
      'Not backed up: 3 saves only on this computer',
    );
    expect(describeSync({ ...base, phase: 'error', error: 'boom' })).toBe(
      'Backup paused, retrying soon: boom',
    );
  });
});

describe('syncBadge', () => {
  const save = {
    status: 'ready',
    syncState: 'pending',
    sync: { error: null },
  } as unknown as SaveRecord;
  it('shows on processed saves not yet uploaded, only while signed in', () => {
    expect(syncBadge(save, true)).toBe('Waiting to back up');
    expect(syncBadge({ ...save, sync: { ...save.sync, error: 'x' } }, true)).toBe(
      'Backup failed, retrying',
    );
    expect(syncBadge(save, false)).toBeNull();
    expect(syncBadge({ ...save, syncState: 'synced' }, true)).toBeNull();
    expect(syncBadge({ ...save, status: 'processing' }, true)).toBeNull();
  });
});
