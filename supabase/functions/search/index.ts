/**
 * Hybrid search over the signed-in user's saves.
 *
 * POST { "query": "a one-page site with huge links" }
 * Responds { results: [{ id, score }], degraded: [] }, best match first. Logs the query to
 * search_events.
 */
import { corsHeaders, identify, json, voyageOptions } from '../_shared/http.ts';
import { runSearch } from '../_shared/search.ts';

const env = (name: string) => Deno.env.get(name);

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  const caller = await identify(request, env);
  if (caller?.kind !== 'user') return json({ error: 'Sign in first.' }, 401);

  const body = (await request.json().catch(() => ({}))) as { query?: unknown; log?: unknown };
  if (typeof body.query !== 'string') return json({ error: 'Pass a query.' }, 400);

  try {
    // Without a Voyage key the search still runs, on keywords alone.
    const response = await runSearch(caller.client, voyageOptions(env), body.query);
    if (body.log !== false && body.query.trim()) {
      const { error } = await caller.client
        .from('search_events')
        .insert({ query: body.query.trim().slice(0, 500) });
      if (error) console.error('[search] could not log the query', error.message);
    }
    return json(response);
  } catch (error) {
    console.error('[search]', error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
