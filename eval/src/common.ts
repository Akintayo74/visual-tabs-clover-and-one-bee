import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface EvalConfig {
  url: string;
  /** Project secret key: only to sign in as the eval user. Never shipped anywhere. */
  secretKey: string;
  publishableKey: string;
  /** Whose saves the queries are about (the trial user). */
  email: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): EvalConfig {
  const missing = [
    'SUPABASE_URL',
    'SUPABASE_SECRET_KEY',
    'SUPABASE_PUBLISHABLE_KEY',
    'EVAL_USER_EMAIL',
  ].filter((name) => !env[name]);
  if (missing.length) {
    throw new Error(
      `Set ${missing.join(', ')}. See README "Search evaluation" (keys: Project Settings > API Keys).`,
    );
  }
  return {
    url: env.SUPABASE_URL ?? '',
    secretKey: env.SUPABASE_SECRET_KEY ?? '',
    publishableKey: env.SUPABASE_PUBLISHABLE_KEY ?? '',
    email: env.EVAL_USER_EMAIL ?? '',
  };
}

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };

/**
 * A client signed in as the eval user, so searches run exactly as the extension's do (same
 * function, same row-level security). Uses a one-time sign-in link minted with the secret key;
 * no email is sent.
 */
export async function signInAs(
  config: EvalConfig,
): Promise<{ client: SupabaseClient; token: string; userId: string }> {
  const admin = createClient(config.url, config.secretKey, noSession);
  const link = await admin.auth.admin.generateLink({ type: 'magiclink', email: config.email });
  if (link.error) throw new Error(`Couldn't sign in as ${config.email}: ${link.error.message}`);
  const client = createClient(config.url, config.publishableKey, noSession);
  const verified = await client.auth.verifyOtp({
    token_hash: link.data.properties.hashed_token,
    type: 'email',
  });
  if (verified.error || !verified.data.session) {
    throw new Error(
      `Couldn't sign in as ${config.email}: ${verified.error?.message ?? 'no session'}`,
    );
  }
  return {
    client,
    token: verified.data.session.access_token,
    userId: verified.data.session.user.id,
  };
}

export interface SavedSite {
  id: string;
  url: string;
  title: string;
  site_name: string;
  status: string;
  image_card_path: string | null;
  image_full_path: string | null;
}

export async function listSaves(client: SupabaseClient): Promise<SavedSite[]> {
  const { data, error } = (await client
    .from('saves')
    .select('id,url,title,site_name,status,image_card_path,image_full_path')
    .is('deleted_at', null)
    .order('captured_at', { ascending: false })) as {
    data: SavedSite[] | null;
    error: { message: string } | null;
  };
  if (error) throw new Error(`Couldn't list saves: ${error.message}`);
  return data ?? [];
}

/** Ranked save ids for a query, from the deployed `search` function. Not logged as a real search. */
export async function search(config: EvalConfig, token: string, query: string): Promise<string[]> {
  const response = await fetch(`${config.url}/functions/v1/search`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: config.publishableKey,
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, log: false }),
  });
  const body = (await response.json()) as {
    results?: { id: string }[];
    degraded?: string[];
    error?: string;
  };
  if (!response.ok)
    throw new Error(`search failed (${String(response.status)}): ${body.error ?? ''}`);
  if (body.degraded?.length) {
    throw new Error(`search ran without ${body.degraded.join(' and ')}; fix that before measuring`);
  }
  return (body.results ?? []).map((r) => r.id);
}

/** Compares sites by host and path, ignoring protocol, "www.", a trailing slash and the query. */
export function sameSite(a: string, b: string): boolean {
  const norm = (value: string) => {
    try {
      const u = new URL(value);
      return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
    } catch {
      return value.trim().toLowerCase();
    }
  };
  return norm(a) === norm(b);
}

/** A stable 70/30 split by save, so a save's queries are either tuned on or held out. */
export function splitOf(saveId: string): 'tune' | 'holdout' {
  let h = 0;
  for (const ch of saveId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 10 < 7 ? 'tune' : 'holdout';
}
