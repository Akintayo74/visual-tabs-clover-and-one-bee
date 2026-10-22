import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

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
export const url = env.API_URL ?? '';
export const publishableKey = env.PUBLISHABLE_KEY ?? '';
export const secretKey = env.SECRET_KEY ?? '';
export const MOCK_PORT = 54399;
export const mockUrl = `http://127.0.0.1:${String(MOCK_PORT)}`;

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };

export const admin = createClient(url, secretKey, noSession);

/** Calls a database function, with the result typed loosely for assertions. */
export async function rpc(
  client: SupabaseClient,
  name: string,
  args: Record<string, unknown>,
): Promise<{ data: unknown; error: { message: string } | null }> {
  return (await client.rpc(name, args)) as { data: unknown; error: { message: string } | null };
}

export interface TestUser {
  client: SupabaseClient;
  id: string;
  token: string;
}

export async function newUser(label: string): Promise<TestUser> {
  const email = `${label}-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const password = `pw-${Math.random().toString(36)}`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  const client = createClient(url, publishableKey, noSession);
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw signedIn.error;
  return { client, id: created.data.user.id, token: signedIn.data.session.access_token };
}

export interface SaveOptions {
  title?: string;
  largestText?: string[];
  withImage?: boolean;
  capturedAt?: string;
}

/** Uploads a screenshot (placeholder bytes) and the save row, as the extension would. */
export async function addSave(user: TestUser, options: SaveOptions = {}): Promise<string> {
  const id = crypto.randomUUID();
  const capturedAt = options.capturedAt ?? new Date().toISOString();
  const fullPath = `${user.id}/${id}/${String(Date.parse(capturedAt))}-full.webp`;
  if (options.withImage !== false) {
    const upload = await user.client.storage
      .from('screenshots')
      .upload(
        fullPath,
        new Blob([new Uint8Array([82, 73, 70, 70, 1, 2, 3])], { type: 'image/webp' }),
        {
          contentType: 'image/webp',
        },
      );
    if (upload.error) throw upload.error;
  }
  const { error } = await user.client.rpc('upsert_save', {
    snapshot: {
      id,
      dedupe_key: `https://example.com/${id}`,
      url: `https://example.com/${id}`,
      canonical_url: null,
      title: options.title ?? 'Example',
      site_name: options.title ?? 'Example',
      favicon_url: null,
      created_at: capturedAt,
      captured_at: capturedAt,
      image_full_path: fullPath,
      image_card_path: fullPath.replace('-full', '-card'),
      width: 2400,
      height: 1500,
      fingerprint: {
        version: 1,
        pageHeightViewports: 1,
        sectionCount: 1,
        largestText: (options.largestText ?? []).map((text) => ({
          text,
          fontSize: 120,
          isLink: true,
          href: null,
        })),
      },
      palette: ['#000000'],
      fonts: ['Inter'],
    },
  });
  if (error) throw new Error(error.message);
  return id;
}

export interface ProcessResponse {
  outcomes: { id: string; result: string; error?: string; retryAt?: string }[];
  waiting: number;
  nextDue: string | null;
  error?: string;
}

// T only types the parsed body, which the caller knows and the server can't promise.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export async function callFunction<T>(
  name: string,
  token: string | null,
  body: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${url}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: publishableKey,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

export async function row(id: string): Promise<Record<string, unknown>> {
  const { data, error } = (await admin.from('saves').select('*').eq('id', id).single()) as {
    data: Record<string, unknown> | null;
    error: { message: string } | null;
  };
  if (error || !data) throw new Error(error?.message ?? 'not found');
  return data;
}

export async function failNext(path: string, count: number, status: number): Promise<void> {
  await fetch(`${mockUrl}/__mock/fail`, {
    method: 'POST',
    body: JSON.stringify({ path, count, status }),
  });
}
