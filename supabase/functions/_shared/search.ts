import type { SupabaseClient } from '@supabase/supabase-js';
import { embedQuery, rerank, type VoyageOptions } from './models.ts';
import { searchText } from './prompt.ts';

/** Candidates from each of vector and keyword search (PLAN.md: top ~50). */
export const CANDIDATES = 50;
/** How many fused candidates the reranker reorders (PLAN.md: top ~30). */
export const RERANK_TOP = 30;
export const MAX_QUERY_LENGTH = 500;

/** A row of public.search_saves. */
export interface Candidate {
  id: string;
  score: number;
  vector_rank: number | null;
  keyword_rank: number | null;
  title: string;
  site_name: string;
  url: string;
  description: string | null;
  recall_phrases: string[] | null;
  tags: string[] | null;
  note: string | null;
}

export interface SearchResult {
  id: string;
  /** The reranker's relevance score when reranked, else the fused score. */
  score: number;
}

export interface SearchResponse {
  results: SearchResult[];
  /** Steps that failed and were skipped, so results are still returned (e.g. "rerank"). */
  degraded: string[];
}

/** The text the reranker compares with the query: description, recall phrases, tags and note. */
export function rerankDocument(candidate: Candidate): string {
  return searchText({
    title: candidate.title,
    siteName: candidate.site_name,
    description: candidate.description,
    recallPhrases: candidate.recall_phrases,
    tags: candidate.tags,
    note: candidate.note,
  });
}

/**
 * Final order: the reranked top candidates, then the rest in fused order. Saves without a
 * description yet stay in the reranked group at their fused position relative to each other.
 */
export function mergeRanking(
  candidates: Candidate[],
  reranked: { index: number; score: number }[] | null,
): SearchResult[] {
  if (!reranked) return candidates.map((c) => ({ id: c.id, score: c.score }));
  const top = reranked
    .map(({ index, score }) => {
      const candidate = candidates[index];
      return candidate ? { id: candidate.id, score } : null;
    })
    .filter((r): r is SearchResult => r !== null);
  const seen = new Set(top.map((r) => r.id));
  const rest = candidates.filter((c) => !seen.has(c.id)).map((c) => ({ id: c.id, score: c.score }));
  return [...top, ...rest];
}

/**
 * Hybrid search over the signed-in user's saves (PLAN.md "Search pipeline", step 2).
 * `client` carries the user's session, so row-level security limits it to their saves.
 * If the embedding or reranking step fails, the search still answers from what worked.
 */
export async function runSearch(
  client: SupabaseClient,
  voyage: VoyageOptions | null,
  rawQuery: string,
): Promise<SearchResponse> {
  const query = rawQuery.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH);
  if (!query) return { results: [], degraded: [] };
  const degraded: string[] = [];

  let embedding: number[] | null = null;
  if (!voyage) degraded.push('embedding');
  else {
    try {
      embedding = await embedQuery({ ...voyage, timeoutMs: voyage.timeoutMs ?? 10_000 }, query);
    } catch (error) {
      console.error('[search] embedding failed', error);
      degraded.push('embedding');
    }
  }

  const { data, error } = await client.rpc('search_saves', {
    query_text: query,
    query_embedding: embedding ? JSON.stringify(embedding) : null,
    match_count: CANDIDATES,
  });
  if (error) throw new Error(`Search failed: ${error.message}`);
  const candidates = (data ?? []) as Candidate[];

  let reranked: { index: number; score: number }[] | null = null;
  const top = candidates.slice(0, RERANK_TOP);
  if (!voyage) degraded.push('rerank');
  else if (top.length > 1) {
    try {
      reranked = await rerank(
        { ...voyage, timeoutMs: voyage.timeoutMs ?? 10_000 },
        query,
        top.map(rerankDocument),
      );
    } catch (error) {
      console.error('[search] rerank failed', error);
      degraded.push('rerank');
    }
  }
  return { results: mergeRanking(candidates, reranked), degraded };
}
