/**
 * Writes eval/generated-queries.json: for each described save, a few search queries the way a
 * designer might type them from memory, written by a model that sees only the screenshot.
 *
 *   pnpm eval:generate   (env as for `pnpm eval`, plus ANTHROPIC_API_KEY)
 *
 * Kept apart from the pipeline on purpose, so the test isn't the pipeline grading itself:
 * a different model, a different prompt, and no access to the description, recall phrases,
 * tags or page measurements. Saves are split 70/30 into "tune" and "holdout" by id.
 * Existing queries are kept; only saves without any get new ones (pass --fresh to redo all).
 */
import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configFromEnv, listSaves, signInAs, splitOf } from './common.ts';
import { EVAL_DIR } from './run.ts';

const MODEL = 'claude-opus-5-5';
const GENERATOR_VERSION = 1;
const FILE = path.join(EVAL_DIR, 'generated-queries.json');

export const GENERATOR_PROMPT = `You're helping test a search engine for a web designer's library of saved websites.

You see a screenshot of one saved site. Imagine the designer saved it weeks ago and now wants it back, but only half-remembers it. Write the search queries they might type.

Write exactly three queries, each in a different style:
1. "vague": a loose, short impression (5 to 10 words), like "that dark site with the floating 3d thing".
2. "structural": about the layout or how it's built (8 to 20 words), like "a one-page site with only one section with large text on it. Each text takes you to a particular page."
3. "misremembered": mostly right but with one detail slightly wrong or swapped, the way memory drifts (for example the wrong colour of a minor element, or "serif" for a slab font), 6 to 15 words.

Rules: don't use the site's name, its URL or any exact words shown on the page. Write casually, as a person types into a search box, lowercase is fine. Describe only what's visible.`;

const SCHEMA = {
  type: 'object',
  properties: {
    vague: { type: 'string' },
    structural: { type: 'string' },
    misremembered: { type: 'string' },
  },
  required: ['vague', 'structural', 'misremembered'],
  additionalProperties: false,
} as const;

export interface GeneratedQuery {
  query: string;
  expected: string[];
  url: string;
  split: 'tune' | 'holdout';
  style: string;
}

interface GeneratedFile {
  generator: { model: string; version: number };
  queries: GeneratedQuery[];
}

async function main(): Promise<void> {
  const config = configFromEnv();
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY.');
  const anthropic = new Anthropic();
  const fresh = process.argv.includes('--fresh');
  const existing =
    !fresh && existsSync(FILE)
      ? (JSON.parse(readFileSync(FILE, 'utf8')) as GeneratedFile).queries
      : [];
  const done = new Set(existing.flatMap((q) => q.expected));

  const { client } = await signInAs(config);
  const saves = (await listSaves(client)).filter((s) => s.status === 'ready' && !done.has(s.id));
  console.log(`Writing queries for ${String(saves.length)} saves…`);
  const queries = [...existing];
  for (const save of saves) {
    const imagePath = save.image_card_path ?? save.image_full_path;
    if (!imagePath) continue;
    const download = await client.storage.from('screenshots').download(imagePath);
    if (download.error) {
      console.warn(`  skipped ${save.url}: ${download.error.message}`);
      continue;
    }
    const data = Buffer.from(await download.data.arrayBuffer()).toString('base64');
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: GENERATOR_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/webp', data } },
            { type: 'text', text: 'Write the three queries for this saved site.' },
          ],
        },
      ],
    });
    if (response.stop_reason === 'refusal') {
      console.warn(`  skipped ${save.url}: declined`);
      continue;
    }
    const text = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const written = JSON.parse(text) as Record<string, string>;
    for (const style of ['vague', 'structural', 'misremembered']) {
      const query = written[style]?.trim();
      if (query) {
        queries.push({ query, expected: [save.id], url: save.url, split: splitOf(save.id), style });
      }
    }
    console.log(`  ${save.url}`);
    // Saved as it goes, so an interrupted run keeps what it wrote.
    const file: GeneratedFile = {
      generator: { model: MODEL, version: GENERATOR_VERSION },
      queries,
    };
    writeFileSync(FILE, `${JSON.stringify(file, null, 2)}\n`);
  }
  console.log(`${String(queries.length)} queries in ${path.relative(process.cwd(), FILE)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
