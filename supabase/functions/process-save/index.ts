/**
 * Describes saves with Claude, embeds them with Voyage and writes the results back.
 *
 * POST {}                 as a user: processes their due saves (a few per call).
 * POST { "id": "<uuid>" } as a user: processes that save if it's due.
 * POST { "all": true }    with the secret key: processes anyone's due saves (reprocess job).
 *
 * Responds { outcomes, waiting, nextDue }. Callers repeat while `waiting` saves are due now.
 */
import Anthropic from '@anthropic-ai/sdk';
import { adminClient, corsHeaders, identify, json, voyageOptions } from '../_shared/http.ts';
import { backlog, claim, processClaimed, type Outcome } from '../_shared/process.ts';

/** Each description takes a while; a few per call keeps well inside the function time limit. */
const PER_CALL = 3;
const env = (name: string) => Deno.env.get(name);

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  const caller = await identify(request, env);
  if (!caller) return json({ error: 'Sign in first.' }, 401);

  const body = (await request.json().catch(() => ({}))) as { id?: unknown; all?: unknown };
  const saveId = typeof body.id === 'string' ? body.id : null;
  const userId = caller.kind === 'user' ? caller.userId : null;
  if (caller.kind === 'operator' && body.all !== true && !saveId) {
    return json({ error: 'Pass { "all": true } or an id.' }, 400);
  }

  const voyage = voyageOptions(env);
  const anthropicKey = env('ANTHROPIC_API_KEY');
  if (!voyage || !anthropicKey) {
    // Nothing is claimed, so saves keep waiting rather than burning their retries.
    return json({ error: 'Processing is not set up: model API keys are missing.' }, 503);
  }

  const admin = adminClient(env);
  const anthropic = new Anthropic({
    apiKey: anthropicKey,
    baseURL: env('ANTHROPIC_BASE_URL') || undefined,
    timeout: 120_000,
    maxRetries: 2,
  });

  try {
    const claimed = await claim(admin, { userId, saveId, max: saveId ? 1 : PER_CALL });
    const outcomes: Outcome[] = [];
    for (const save of claimed) {
      outcomes.push(await processClaimed({ admin, anthropic, voyage }, save));
    }
    const { waiting, nextDue } = await backlog(admin, userId);
    return json({ outcomes, waiting, nextDue });
  } catch (error) {
    console.error('[process-save]', error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
