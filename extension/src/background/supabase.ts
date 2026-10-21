import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * The project's URL and publishable key. Both are public: the publishable key only reaches
 * what row-level security allows a signed-in user. Model API keys never come here; they
 * live in Edge Function secrets.
 */
const url = import.meta.env.WXT_SUPABASE_URL as string | undefined;
const key = import.meta.env.WXT_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const syncConfigured = Boolean(url && key);

/** e2e only: makes every request to Supabase fail as if the network were down. */
let simulateOffline = false;
export function setSimulatedOffline(offline: boolean): void {
  simulateOffline = offline;
}

const fetchWithOffline: typeof fetch = (input, init) =>
  simulateOffline ? Promise.reject(new TypeError('Failed to fetch')) : fetch(input, init);

// The service worker has no localStorage; chrome.storage.local survives restarts.
const authStorage = {
  async getItem(name: string): Promise<string | null> {
    const value = (await browser.storage.local.get(name))[name];
    return typeof value === 'string' ? value : null;
  },
  async setItem(name: string, value: string): Promise<void> {
    await browser.storage.local.set({ [name]: value });
  },
  async removeItem(name: string): Promise<void> {
    await browser.storage.local.remove(name);
  },
};

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!url || !key) throw new Error("Backup isn't set up in this build.");
  client ??= createClient(url, key, {
    auth: {
      storage: authStorage,
      persistSession: true,
      autoRefreshToken: true,
      // There's no page URL to read a session from; sign-in uses an emailed code.
      detectSessionInUrl: false,
    },
    global: { fetch: fetchWithOffline },
  });
  return client;
}

/** True when an error means Supabase couldn't be reached, rather than that it refused. */
export function isNetworkError(error: unknown): boolean {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  const text =
    error instanceof Error
      ? `${error.name} ${error.message} ${cause}`
      : typeof error === 'object' && error !== null && 'message' in error
        ? String(error.message)
        : String(error);
  return /failed to fetch|networkerror|network request failed|load failed|fetch failed|ERR_INTERNET_DISCONNECTED|ECONNREFUSED/i.test(
    text,
  );
}
