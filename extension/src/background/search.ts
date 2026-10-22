import type { SearchResults } from '@/src/lib/search';
import { supabase, syncConfigured } from './supabase';

interface SearchResponse {
  results: { id: string; score: number }[];
  degraded: string[];
}

/**
 * The semantic layer: the `search` Edge Function ranks the signed-in user's saves for a
 * memory-style query. Returns null when signed out (the instant local layer is all there is).
 */
export async function searchRemote(query: string): Promise<SearchResults | null> {
  if (!syncConfigured) return null;
  const { data: session } = await supabase().auth.getSession();
  if (!session.session) return null;
  const { data, error } = (await supabase().functions.invoke<SearchResponse>('search', {
    body: { query },
  })) as { data: SearchResponse | null; error: unknown };
  if (error || !data) throw new Error(error instanceof Error ? error.message : 'Search failed.');
  return { ids: data.results.map((r) => r.id), degraded: data.degraded };
}

/** Records which result was opened for a query, for tuning later. Failures are ignored. */
export async function logSearchClick(query: string, id: string, rank: number): Promise<void> {
  if (!syncConfigured) return;
  const { data: session } = await supabase().auth.getSession();
  if (!session.session) return;
  const { error } = await supabase()
    .from('search_events')
    .insert({ query: query.slice(0, 500), clicked_save_id: id, rank });
  // A save that never reached the server can't be referenced; that's fine to drop.
  if (error) console.warn('[search] could not log the click', error.message);
}
