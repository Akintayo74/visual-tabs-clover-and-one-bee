import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { VoyageOptions } from './models.ts';

export const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}

export type Env = (name: string) => string | undefined;

function firstKey(env: Env, listName: string, legacyName: string): string {
  // Newer projects expose { "default": "sb_..." } maps; older ones the legacy JWT keys.
  const list = env(listName);
  if (list) {
    try {
      const keys = Object.values(JSON.parse(list) as Record<string, string>);
      if (keys[0]) return keys[0];
    } catch {
      // Fall through to the legacy key.
    }
  }
  const legacy = env(legacyName);
  if (!legacy) throw new Error(`${listName} and ${legacyName} are both missing.`);
  return legacy;
}

export function supabaseUrl(env: Env): string {
  const url = env('SUPABASE_URL');
  if (!url) throw new Error('SUPABASE_URL is missing.');
  return url;
}

export function secretKey(env: Env): string {
  return firstKey(env, 'SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
}

function allSecretKeys(env: Env): string[] {
  const keys: string[] = [];
  const list = env('SUPABASE_SECRET_KEYS');
  if (list) {
    try {
      keys.push(...Object.values(JSON.parse(list) as Record<string, string>));
    } catch {
      // Ignore a malformed list; the legacy key below may still match.
    }
  }
  const legacy = env('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) keys.push(legacy);
  return keys.filter(Boolean);
}

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };

export function adminClient(env: Env): SupabaseClient {
  return createClient(supabaseUrl(env), secretKey(env), noSession);
}

export type Caller =
  /** Called with the project's secret key: the reprocess job and tests. */
  | { kind: 'operator' }
  /** A signed-in user; `client` acts as them, so row-level security applies. */
  | { kind: 'user'; userId: string; client: SupabaseClient };

/** Works out who is calling from the Authorization header, or returns null. */
export async function identify(request: Request, env: Env): Promise<Caller | null> {
  const token = request.headers
    .get('authorization')
    ?.replace(/^Bearer\s+/i, '')
    .trim();
  if (!token) return null;
  if (allSecretKeys(env).includes(token)) return { kind: 'operator' };
  const client = createClient(
    supabaseUrl(env),
    firstKey(env, 'SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY'),
    { ...noSession, global: { headers: { Authorization: `Bearer ${token}` } } },
  );
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) {
    console.warn('[auth] rejected a session:', error?.message ?? 'no user');
    return null;
  }
  return { kind: 'user', userId: data.user.id, client };
}

/** Model keys come only from Edge Function secrets. Returns null when one is missing. */
export function voyageOptions(env: Env): VoyageOptions | null {
  const apiKey = env('VOYAGE_API_KEY');
  if (!apiKey) return null;
  return { apiKey, baseUrl: env('VOYAGE_BASE_URL') || undefined };
}
