/**
 * Keeps the eval runnable: runs it end to end against the local stack, with the Edge
 * Functions served against the mock models (see server/functions.test.env). The numbers
 * here only prove the plumbing; real numbers need real models and the trial user's saves.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockModels } from '../../server/src/mock-models.ts';
import { sameSite, splitOf, type EvalConfig } from '../src/common.ts';
import { formatSummary, summarize } from '../src/metrics.ts';
import { loadQueries, runEval } from '../src/run.ts';

function localStack(): Record<string, string> {
  const out = execFileSync('pnpm', ['exec', 'supabase', 'status', '-o', 'env'], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    encoding: 'utf8',
  });
  return Object.fromEntries(
    [...out.matchAll(/^([A-Z_]+)="?([^"\n]*)"?$/gm)].map((m) => [m[1] ?? '', m[2] ?? '']),
  );
}

const env = localStack();
const config: EvalConfig = {
  url: env.API_URL ?? '',
  secretKey: env.SECRET_KEY ?? '',
  publishableKey: env.PUBLISHABLE_KEY ?? '',
  email: `eval-${String(Date.now())}@example.com`,
};
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
let mock: Server;

async function addSite(
  client: SupabaseClient,
  userId: string,
  url: string,
  title: string,
  largestText: string[],
): Promise<void> {
  const id = crypto.randomUUID();
  const path = `${userId}/${id}/1-full.webp`;
  const upload = await client.storage
    .from('screenshots')
    .upload(path, new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' }), {
      contentType: 'image/webp',
    });
  if (upload.error) throw upload.error;
  const now = new Date().toISOString();
  const { error } = await client.rpc('upsert_save', {
    snapshot: {
      id,
      dedupe_key: url,
      url,
      title,
      site_name: title,
      created_at: now,
      captured_at: now,
      image_full_path: path,
      image_card_path: path,
      width: 2400,
      height: 1500,
      fingerprint: {
        version: 1,
        largestText: largestText.map((text) => ({ text, fontSize: 100, isLink: true, href: null })),
      },
      palette: [],
      fonts: [],
    },
  });
  if (error) throw new Error(error.message);
}

beforeAll(async () => {
  mock = await startMockModels(54399);
  const admin = createClient(config.url, config.secretKey, noSession);
  const password = `pw-${Math.random().toString(36)}`;
  const created = await admin.auth.admin.createUser({
    email: config.email,
    password,
    email_confirm: true,
  });
  if (created.error) throw created.error;
  const client = createClient(config.url, config.publishableKey, noSession);
  const session = await client.auth.signInWithPassword({ email: config.email, password });
  if (session.error) throw session.error;
  const userId = created.data.user.id;
  await addSite(client, userId, 'https://index.test/', 'Index', ['Projects', 'Journal', 'Contact']);
  await addSite(client, userId, 'https://shop.test/', 'Ceramics', ['Bowls', 'Plates']);
  for (let i = 0; i < 3; i++) {
    await fetch(`${config.url}/functions/v1/process-save`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.data.session.access_token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
  }
}, 120_000);

afterAll(() => {
  mock.close();
});

describe('the eval harness', () => {
  it('signs in as the user, runs each query through search and scores it', async () => {
    const queries = [
      { query: 'journal and contact links', expected: ['https://index.test'], set: 'real' },
      { query: 'bowls and plates shop', expected: ['https://www.shop.test/'], set: 'real' },
      { query: 'something not saved', expected: ['https://nope.test/'], set: 'real' },
    ];
    const { results, unknown } = await runEval(config, queries);
    expect(unknown).toHaveLength(1);
    expect(results.map((r) => r.rank)).toEqual([1, 1]);
    const [real] = summarize(results);
    expect(real).toMatchObject({ set: 'real', count: 2, hitAt1: 1, hitAt5: 1, mrr: 1 });
    expect(formatSummary(summarize(results))).toContain('met');
  }, 60_000);

  it('reads real and generated query files, skipping real ones without a site yet', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-'));
    writeFileSync(
      path.join(dir, 'queries.json'),
      JSON.stringify({
        queries: [
          { query: 'a', expected: [] },
          { query: 'b', expected: ['https://b.test/'] },
        ],
      }),
    );
    writeFileSync(
      path.join(dir, 'generated-queries.json'),
      JSON.stringify({ queries: [{ query: 'c', expected: ['id-1'], split: 'holdout' }] }),
    );
    expect(loadQueries(dir).map((q) => `${q.set}:${q.query}`)).toEqual(['real:b', 'holdout:c']);
  });

  it('compares sites loosely and splits saves stably', () => {
    expect(sameSite('https://www.Site.test/work/', 'http://site.test/work?x=1')).toBe(true);
    expect(sameSite('https://site.test/a', 'https://site.test/b')).toBe(false);
    expect(splitOf('abc')).toBe(splitOf('abc'));
    const splits = Array.from({ length: 200 }, (_, i) => splitOf(crypto.randomUUID() + String(i)));
    const holdout = splits.filter((s) => s === 'holdout').length / splits.length;
    expect(holdout).toBeGreaterThan(0.15);
    expect(holdout).toBeLessThan(0.45);
  });
});
