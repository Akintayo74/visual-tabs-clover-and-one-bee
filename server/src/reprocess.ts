/**
 * "Reprocess all": after a prompt change bumps PROMPT_VERSION, re-describes every save made
 * with an older version (or never described), for every user. Existing descriptions stay
 * searchable until their replacements are written. Safe to stop and run again.
 *
 *   SUPABASE_URL=https://<project>.supabase.co SUPABASE_SECRET_KEY=sb_secret_... \
 *     pnpm --filter server reprocess [--force]
 *
 * --force re-describes everything, whatever its prompt version.
 */
import { createClient } from '@supabase/supabase-js';
import { PROMPT_VERSION } from '../../supabase/functions/_shared/prompt.ts';

interface ProcessResponse {
  outcomes?: { id: string; result: string; error?: string }[];
  waiting?: number;
  nextDue?: string | null;
  error?: string;
}

const url = process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
if (!url || !secretKey) {
  console.error('Set SUPABASE_URL and SUPABASE_SECRET_KEY (Project Settings > API Keys).');
  process.exit(1);
}
const force = process.argv.includes('--force');

const admin = createClient(url, secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { data: queued, error } = (await admin.rpc('request_reprocess', {
  // Every version is below the largest int, so --force queues everything.
  current_version: force ? 2_147_483_647 : PROMPT_VERSION,
})) as { data: number | null; error: { message: string } | null };
if (error) {
  console.error(`Couldn't queue saves: ${error.message}`);
  process.exit(1);
}
console.log(`Queued ${String(queued)} saves for prompt version ${String(PROMPT_VERSION)}.`);

const counts: Record<string, number> = {};
let idleRounds = 0;
for (;;) {
  let body: ProcessResponse;
  try {
    const response = await fetch(`${url}/functions/v1/process-save`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secretKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ all: true }),
    });
    body = (await response.json()) as ProcessResponse;
    if (!response.ok) throw new Error(body.error ?? `HTTP ${String(response.status)}`);
  } catch (failure) {
    console.error(
      `process-save failed: ${failure instanceof Error ? failure.message : String(failure)}; retrying in 30s`,
    );
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    continue;
  }
  for (const outcome of body.outcomes ?? []) {
    counts[outcome.result] = (counts[outcome.result] ?? 0) + 1;
    if (outcome.error) console.log(`  ${outcome.id}: ${outcome.result} (${outcome.error})`);
  }
  console.log(`Done so far: ${JSON.stringify(counts)}; waiting: ${String(body.waiting ?? 0)}`);
  if (!body.waiting) break;
  if (!body.outcomes?.length) {
    // Everything left is waiting for a retry later, or held by another worker.
    idleRounds++;
    if (idleRounds >= 3) {
      console.log(
        `The rest is waiting for retries (next at ${body.nextDue ?? 'unknown'}). Run again later.`,
      );
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20_000));
  } else {
    idleRounds = 0;
  }
}
