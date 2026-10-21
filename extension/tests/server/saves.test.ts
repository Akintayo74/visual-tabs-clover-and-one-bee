import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RemoteSave, UpsertResult } from '@/src/lib/remote';

/** Reads the running local stack's URL and keys, so nothing is hard-coded or committed. */
function localStack(): Record<string, string> {
  const out = execFileSync('pnpm', ['exec', 'supabase', 'status', '-o', 'env'], {
    cwd: path.resolve(import.meta.dirname, '../../..'),
    encoding: 'utf8',
  });
  return Object.fromEntries(
    [...out.matchAll(/^([A-Z_]+)="?([^"\n]*)"?$/gm)].map((m) => [m[1] ?? '', m[2] ?? '']),
  );
}

const env = localStack();
const url = env.API_URL ?? '';
const publishableKey = env.PUBLISHABLE_KEY ?? '';
const secretKey = env.SECRET_KEY ?? '';

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };

async function newUser(label: string): Promise<{ client: SupabaseClient; id: string }> {
  const admin = createClient(url, secretKey, noSession);
  const email = `${label}-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const password = `pw-${Math.random().toString(36)}`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  const client = createClient(url, publishableKey, noSession);
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw signedIn.error;
  return { client, id: created.data.user.id };
}

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    dedupe_key: `https://example.com/${crypto.randomUUID()}`,
    url: 'https://example.com/',
    canonical_url: null,
    title: 'Example',
    site_name: 'Example',
    favicon_url: null,
    created_at: '2026-10-01T10:00:00Z',
    captured_at: '2026-10-01T10:00:00Z',
    image_full_path: 'a/full.webp',
    image_card_path: 'a/card.webp',
    width: 2400,
    height: 1500,
    fingerprint: { version: 1 },
    palette: ['#000000'],
    fonts: ['Inter'],
    ...overrides,
  };
}

async function upsert(
  client: SupabaseClient,
  snap: Record<string, unknown>,
): Promise<UpsertResult> {
  const { data, error } = (await client.rpc('upsert_save', { snapshot: snap })) as {
    data: unknown;
    error: { message: string } | null;
  };
  if (error) throw new Error(error.message);
  return data as UpsertResult;
}

describe('upsert_save and delete_save', () => {
  let alice: { client: SupabaseClient; id: string };

  beforeAll(async () => {
    alice = await newUser('alice');
  });

  it('inserts a new save for the signed-in user, waiting for processing', async () => {
    const snap = snapshot();
    const result = await upsert(alice.client, snap);
    expect(result).toMatchObject({ applied: true, deleted: false, replaced_paths: [] });
    expect(result.row).toMatchObject({ id: snap.id, palette: ['#000000'], fonts: ['Inter'] });
    expect((result.row as RemoteSave & { user_id: string }).user_id).toBe(alice.id);
    expect((result.row as RemoteSave & { status: string }).status).toBe('pending');
  });

  it('a newer snapshot replaces the old one and reports the old images', async () => {
    const snap = snapshot();
    const first = await upsert(alice.client, snap);
    const second = await upsert(alice.client, {
      ...snap,
      captured_at: '2026-10-02T10:00:00Z',
      image_full_path: 'b/full.webp',
      image_card_path: 'b/card.webp',
      title: 'Example (new)',
    });
    expect(second.applied).toBe(true);
    expect(second.replaced_paths.sort()).toEqual(['a/card.webp', 'a/full.webp']);
    expect(second.row).toMatchObject({ title: 'Example (new)', image_card_path: 'b/card.webp' });
    expect(Date.parse(second.row.updated_at)).toBeGreaterThan(Date.parse(first.row.updated_at));
  });

  it('an older snapshot leaves the newer one in place', async () => {
    const snap = snapshot({ captured_at: '2026-10-05T10:00:00Z' });
    await upsert(alice.client, snap);
    const older = await upsert(alice.client, {
      ...snap,
      captured_at: '2026-10-03T10:00:00Z',
      title: 'Older',
    });
    expect(older.applied).toBe(false);
    expect(older.row.title).toBe('Example');
    expect(older.row.captured_at).toBe('2026-10-05T10:00:00+00:00');
  });

  it('the same page saved on another device merges into one save', async () => {
    const key = `https://example.com/${crypto.randomUUID()}`;
    const first = snapshot({ dedupe_key: key });
    await upsert(alice.client, first);
    const merged = await upsert(
      alice.client,
      snapshot({ dedupe_key: key, captured_at: '2026-10-09T10:00:00Z', title: 'Device B' }),
    );
    expect(merged).toMatchObject({ applied: true });
    expect(merged.row).toMatchObject({ id: first.id, title: 'Device B' });
    const { data } = await alice.client.from('saves').select('id').eq('dedupe_key', key);
    expect(data).toHaveLength(1);
  });

  it('a delete wins over snapshots taken before it, and a later save brings it back', async () => {
    const snap = snapshot();
    await upsert(alice.client, snap);
    const { data: paths, error } = (await alice.client.rpc('delete_save', {
      save_id: snap.id,
    })) as { data: unknown; error: unknown };
    expect(error).toBeNull();
    expect((paths as string[]).sort()).toEqual(['a/card.webp', 'a/full.webp']);

    const stale = await upsert(alice.client, snap);
    expect(stale).toMatchObject({ applied: false, deleted: true });
    expect(stale.row.deleted_at).not.toBeNull();

    const later = await upsert(alice.client, {
      ...snap,
      captured_at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(later).toMatchObject({ applied: true, deleted: false });
    expect(later.row.deleted_at).toBeNull();
  });

  it('a deleted page can be saved again under a new id', async () => {
    const key = `https://example.com/${crypto.randomUUID()}`;
    const first = snapshot({ dedupe_key: key });
    await upsert(alice.client, first);
    await alice.client.rpc('delete_save', { save_id: first.id });
    const again = await upsert(alice.client, snapshot({ dedupe_key: key }));
    expect(again.applied).toBe(true);
    expect(again.row.id).not.toBe(first.id);
  });

  it('deleting an unknown or already deleted save does nothing', async () => {
    const { data, error } = (await alice.client.rpc('delete_save', {
      save_id: crypto.randomUUID(),
    })) as { data: unknown; error: unknown };
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});

describe('row-level security', () => {
  let alice: { client: SupabaseClient; id: string };
  let mallory: { client: SupabaseClient; id: string };
  const aliceSave = snapshot();

  beforeAll(async () => {
    alice = await newUser('alice');
    mallory = await newUser('mallory');
    await upsert(alice.client, aliceSave);
    const upload = await alice.client.storage
      .from('screenshots')
      .upload(`${alice.id}/x/1-card.webp`, new Blob(['img'], { type: 'image/webp' }), {
        contentType: 'image/webp',
      });
    if (upload.error) throw upload.error;
  });

  it("other users can't read, change or delete someone's saves", async () => {
    const { data } = await mallory.client.from('saves').select('id').eq('id', aliceSave.id);
    expect(data).toEqual([]);
    await expect(
      upsert(mallory.client, { ...aliceSave, captured_at: '2027-01-01T00:00:00Z' }),
    ).rejects.toThrow();
    await mallory.client.rpc('delete_save', { save_id: aliceSave.id });
    const { data: still } = await alice.client
      .from('saves')
      .select('deleted_at')
      .eq('id', aliceSave.id);
    expect(still).toEqual([{ deleted_at: null }]);
  });

  it("other users can't read or write someone's screenshots", async () => {
    const read = await mallory.client.storage
      .from('screenshots')
      .download(`${alice.id}/x/1-card.webp`);
    expect(read.error).not.toBeNull();
    const write = await mallory.client.storage
      .from('screenshots')
      .upload(`${alice.id}/y/1-card.webp`, new Blob(['img'], { type: 'image/webp' }), {
        contentType: 'image/webp',
      });
    expect(write.error).not.toBeNull();
    const own = await alice.client.storage
      .from('screenshots')
      .download(`${alice.id}/x/1-card.webp`);
    expect(own.error).toBeNull();
  });

  it('signed-out requests see nothing and can’t call the functions', async () => {
    const anon = createClient(url, publishableKey, noSession);
    const { data } = await anon.from('saves').select('id');
    expect(data).toEqual([]);
    const { error } = await anon.rpc('upsert_save', { snapshot: snapshot() });
    expect(error).not.toBeNull();
  });

  it('only webp images are accepted', async () => {
    const { error } = await alice.client.storage
      .from('screenshots')
      .upload(`${alice.id}/z/1-card.png`, new Blob(['img'], { type: 'image/png' }), {
        contentType: 'image/png',
      });
    expect(error).not.toBeNull();
  });
});
