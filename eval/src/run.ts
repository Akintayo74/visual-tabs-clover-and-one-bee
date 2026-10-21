/**
 * Search evaluation: runs every query through the deployed `search` function as the trial
 * user and reports hit@1, hit@3, hit@5 and MRR per query set.
 *
 *   pnpm eval            (env: SUPABASE_URL, SUPABASE_SECRET_KEY, SUPABASE_PUBLISHABLE_KEY,
 *                         EVAL_USER_EMAIL; see README "Search evaluation")
 *
 * Sets: "real" from eval/queries.json (the user's own queries, by site URL), and "tune" and
 * "holdout" from eval/generated-queries.json (written by `pnpm eval:generate`). Tune prompts
 * on "tune"; "holdout" checks the gains carry over; "real" is what the targets apply to.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  configFromEnv,
  listSaves,
  sameSite,
  search,
  signInAs,
  type EvalConfig,
  type SavedSite,
} from './common.ts';
import { formatSummary, rankOf, summarize, type EvalQuery, type QueryResult } from './metrics.ts';

export const EVAL_DIR = path.resolve(import.meta.dirname, '..');

interface QueryFile {
  queries: { query: string; expected: string[]; note?: string }[];
}

interface GeneratedFile {
  queries: { query: string; expected: string[]; split: 'tune' | 'holdout' }[];
}

function readJson(file: string): unknown {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

export function loadQueries(dir = EVAL_DIR): EvalQuery[] {
  const queries: EvalQuery[] = [];
  const real = readJson(path.join(dir, 'queries.json')) as QueryFile | null;
  for (const q of real?.queries ?? []) {
    if (q.expected.length) queries.push({ query: q.query, expected: q.expected, set: 'real' });
  }
  const generated = readJson(path.join(dir, 'generated-queries.json')) as GeneratedFile | null;
  for (const q of generated?.queries ?? []) {
    queries.push({ query: q.query, expected: q.expected, set: q.split });
  }
  return queries;
}

/** Expected entries are save ids or page URLs. */
function matcher(expected: string[], saves: SavedSite[]): (id: string) => boolean {
  const ids = new Set(expected);
  for (const save of saves) {
    if (expected.some((e) => e.includes('/') && sameSite(e, save.url))) ids.add(save.id);
  }
  return (id) => ids.has(id);
}

export async function runEval(
  config: EvalConfig,
  queries: EvalQuery[],
): Promise<{ results: QueryResult[]; unknown: string[] }> {
  const { client, token } = await signInAs(config);
  const saves = await listSaves(client);
  const titles = new Map(saves.map((s) => [s.id, s.site_name || s.title || s.url]));
  const results: QueryResult[] = [];
  const unknown: string[] = [];
  for (const q of queries) {
    const isExpected = matcher(q.expected, saves);
    if (!saves.some((s) => isExpected(s.id))) {
      unknown.push(`${q.query} → ${q.expected.join(', ')}`);
      continue;
    }
    const ranked = await search(config, token, q.query);
    results.push({
      ...q,
      rank: rankOf(ranked, isExpected),
      top: ranked.slice(0, 3).map((id) => titles.get(id) ?? id),
    });
  }
  return { results, unknown };
}

async function main(): Promise<void> {
  const config = configFromEnv();
  const queries = loadQueries();
  if (!queries.length) {
    console.log(
      'No queries yet. Add real ones to eval/queries.json, or run `pnpm eval:generate` first.',
    );
    return;
  }
  const { results, unknown } = await runEval(config, queries);
  console.log(formatSummary(summarize(results)));

  const misses = results.filter((r) => r.rank === null || r.rank > 1);
  if (misses.length) {
    console.log('\nNot ranked first:');
    for (const m of misses) {
      console.log(
        `  [${m.set}] #${m.rank === null ? '—' : String(m.rank)} "${m.query}"  (top: ${m.top.join(' | ')})`,
      );
    }
  }
  if (unknown.length) {
    console.log(`\nSkipped ${String(unknown.length)} queries whose site isn't saved:`);
    for (const u of unknown) console.log(`  ${u}`);
  }
  const out = path.join(EVAL_DIR, 'results');
  mkdirSync(out, { recursive: true });
  const file = path.join(out, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ summary: summarize(results), results }, null, 2));
  console.log(`\nDetails: ${path.relative(process.cwd(), file)}`);
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
