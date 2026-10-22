import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROMPT_VERSION } from '../../../supabase/functions/_shared/prompt.ts';
import { startMockModels } from '../../src/mock-models.ts';
import {
  addSave,
  admin,
  callFunction,
  failNext,
  MOCK_PORT,
  newUser,
  row,
  rpc,
  secretKey,
  type ProcessResponse,
  type TestUser,
} from './support.ts';

let mock: Server;

beforeAll(async () => {
  mock = await startMockModels(MOCK_PORT);
});

afterAll(() => {
  mock.close();
});

/** Lets a save that's waiting for a retry be tried now. */
async function makeDue(id: string): Promise<void> {
  const { error } = await admin
    .from('saves')
    .update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

async function process(user: TestUser, body: unknown = {}): Promise<ProcessResponse> {
  const { status, body: result } = await callFunction<ProcessResponse>(
    'process-save',
    user.token,
    body,
  );
  expect(status, result.error).toBe(200);
  return result;
}

describe('process-save', () => {
  let alice: TestUser;

  beforeAll(async () => {
    alice = await newUser('alice');
  });

  it('describes and embeds a new save, then marks it ready', async () => {
    const id = await addSave(alice, { title: 'Huge Links Studio', largestText: ['WORK', 'ABOUT'] });
    expect((await row(id)).status).toBe('pending');
    const result = await process(alice, { id });
    expect(result.outcomes).toEqual([{ id, result: 'ready' }]);
    const saved = await row(id);
    expect(saved).toMatchObject({ status: 'ready', error: null, prompt_version: PROMPT_VERSION });
    expect(saved.description).toContain('Huge Links Studio');
    expect((saved.recall_phrases as string[]).length).toBeGreaterThanOrEqual(3);
    expect(saved.tags).toContain('mock');
    expect(typeof saved.embedding).toBe('string');
    expect(saved.search_tsv).toBeTruthy();
  });

  it('processing an already processed save again does nothing', async () => {
    const id = await addSave(alice, { title: 'Twice' });
    await process(alice, { id });
    const again = await process(alice, { id });
    expect(again.outcomes).toEqual([]);
    expect((await row(id)).status).toBe('ready');
  });

  it('a model outage leaves the save waiting with the error, and a later try succeeds', async () => {
    const id = await addSave(alice, { title: 'Outage' });
    // The SDK retries twice itself, so three failures make the whole try fail.
    await failNext('/v1/messages', 3, 529);
    const first = await process(alice, { id });
    expect(first.outcomes[0]).toMatchObject({ id, result: 'retrying' });
    const waiting = await row(id);
    expect(waiting).toMatchObject({ status: 'pending', attempts: 1 });
    expect(waiting.error).toMatch(/Claude/);
    expect(Date.parse(waiting.next_attempt_at as string)).toBeGreaterThan(Date.now());

    // Not due yet, so it isn't tried again straight away.
    expect((await process(alice, { id })).outcomes).toEqual([]);

    await makeDue(id);
    expect((await process(alice, { id })).outcomes).toEqual([{ id, result: 'ready' }]);
    expect(await row(id)).toMatchObject({ status: 'ready', error: null, attempts: 0 });
  });

  it('an embedding failure is retried too', async () => {
    const id = await addSave(alice, { title: 'Embedding outage' });
    await failNext('/v1/multimodalembeddings', 1, 503);
    expect((await process(alice, { id })).outcomes[0]).toMatchObject({ result: 'retrying' });
    await makeDue(id);
    expect((await process(alice, { id })).outcomes[0]).toMatchObject({ result: 'ready' });
  });

  it("a request the model can't take fails straight away and the user can retry it", async () => {
    const id = await addSave(alice, { title: 'Bad request' });
    await failNext('/v1/messages', 1, 400);
    expect((await process(alice, { id })).outcomes[0]).toMatchObject({ result: 'failed' });
    expect((await row(id)).status).toBe('failed');

    const { data, error } = await rpc(alice.client, 'retry_save', { save_id: id });
    expect(error).toBeNull();
    expect(data).toBe(true);
    expect((await process(alice, { id })).outcomes[0]).toMatchObject({ result: 'ready' });
  });

  it('gives up after the last attempt', async () => {
    const id = await addSave(alice, { title: 'Always down' });
    await admin.from('saves').update({ attempts: 5 }).eq('id', id);
    await failNext('/v1/messages', 3, 500);
    const result = await process(alice, { id });
    expect(result.outcomes[0]).toMatchObject({ result: 'failed' });
    expect(await row(id)).toMatchObject({ status: 'failed', attempts: 6 });
  });

  it('a missing screenshot fails with a clear reason', async () => {
    const id = await addSave(alice, { title: 'No image', withImage: false });
    const result = await process(alice, { id });
    expect(result.outcomes[0]).toMatchObject({ result: 'failed' });
    expect((await row(id)).error).toMatch(/screenshot is missing/);
  });

  it('a stale claim from a crashed worker is taken over', async () => {
    const id = await addSave(alice, { title: 'Crashed' });
    await admin
      .from('saves')
      .update({
        status: 'processing',
        claim_id: crypto.randomUUID(),
        claimed_at: new Date(Date.now() - 11 * 60_000).toISOString(),
      })
      .eq('id', id);
    expect((await process(alice, { id })).outcomes).toEqual([{ id, result: 'ready' }]);
  });

  it("a newer snapshot arriving mid-processing wins over the old snapshot's result", async () => {
    const id = await addSave(alice, { title: 'Old snapshot' });
    const { data: claimed } = await rpc(admin, 'claim_saves', {
      for_user: alice.id,
      only_save: id,
      max_count: 1,
    });
    const claim = (claimed as { claim_id: string }[])[0]?.claim_id;
    expect(claim).toBeTruthy();

    const current = await row(id);
    const { error } = await rpc(alice.client, 'upsert_save', {
      snapshot: {
        ...current,
        captured_at: new Date(Date.now() + 1000).toISOString(),
        title: 'New snapshot',
      },
    });
    expect(error).toBeNull();
    expect(await row(id)).toMatchObject({ status: 'pending', attempts: 0, claim_id: null });

    const { data: wrote } = await rpc(admin, 'complete_save', {
      save_id: id,
      claim,
      new_description: 'Describes the old snapshot',
      new_recall_phrases: ['old'],
      new_tags: ['old'],
      new_prompt_version: PROMPT_VERSION,
      new_embedding: JSON.stringify(new Array(1024).fill(0.01)),
    });
    expect(wrote).toBe(false);
    expect((await row(id)).description).toBeNull();
  });

  it("one user's call never touches another user's saves", async () => {
    const bob = await newUser('bob');
    const bobs = await addSave(bob, { title: 'Bob' });
    const result = await process(alice, { id: bobs });
    expect(result.outcomes).toEqual([]);
    expect((await row(bobs)).status).toBe('pending');
  });

  it('refuses signed-out callers, and users can’t reach the queue directly', async () => {
    const { status } = await callFunction('process-save', null, {});
    expect(status).toBe(401);
    const { error } = await rpc(alice.client, 'claim_saves', {
      for_user: alice.id,
      only_save: null,
      max_count: 1,
    });
    expect(error).not.toBeNull();
    const { error: reprocessError } = await rpc(alice.client, 'request_reprocess', {
      current_version: 99,
    });
    expect(reprocessError).not.toBeNull();
  });

  it('reprocess queues saves made with an older prompt and the secret key processes them', async () => {
    const id = await addSave(alice, { title: 'Reprocess me' });
    await process(alice, { id });
    await admin
      .from('saves')
      .update({ prompt_version: PROMPT_VERSION - 1 })
      .eq('id', id);

    const { data: queued, error } = await rpc(admin, 'request_reprocess', {
      current_version: PROMPT_VERSION,
    });
    expect(error).toBeNull();
    expect(queued).toBeGreaterThanOrEqual(1);
    const pending = await row(id);
    expect(pending.status).toBe('pending');
    // The old description stays searchable until the new one replaces it.
    expect(pending.description).toContain('Reprocess me');

    const { status } = await callFunction('process-save', secretKey, { id });
    expect(status).toBe(200);
    expect(await row(id)).toMatchObject({ status: 'ready', prompt_version: PROMPT_VERSION });
  });
});

describe('search', () => {
  let carol: TestUser;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    carol = await newUser('carol');
    ids.links = await addSave(carol, {
      title: 'Typographic index',
      largestText: ['Projects', 'Journal', 'Contact'],
    });
    ids.shop = await addSave(carol, { title: 'Ceramics shop', largestText: ['Bowls', 'Plates'] });
    ids.webgl = await addSave(carol, { title: 'Liquid chrome', largestText: ['Enter'] });
    ids.waiting = await addSave(carol, { title: 'Not described yet' });
    for (const id of [ids.links, ids.shop, ids.webgl]) {
      await process(carol, { id });
    }
  });

  async function search(query: string, token = carol.token) {
    return callFunction<{ results: { id: string; score: number }[]; degraded: string[] }>(
      'search',
      token,
      { query },
    );
  }

  it('finds the save a query describes, best first', async () => {
    const { status, body } = await search('typographic site with projects journal contact links');
    expect(status).toBe(200);
    expect(body.degraded).toEqual([]);
    expect(body.results[0]?.id).toBe(ids.links);
    const shop = await search('ceramics bowls plates');
    expect(shop.body.results[0]?.id).toBe(ids.shop);
  });

  it('matches saves that are not described yet by their title', async () => {
    const { body } = await search('not described');
    expect(body.results.map((r) => r.id)).toContain(ids.waiting);
  });

  it('still answers when the embedding or reranking step fails', async () => {
    await failNext('/v1/multimodalembeddings', 1, 503);
    const noEmbedding = await search('liquid chrome');
    expect(noEmbedding.body.degraded).toEqual(['embedding']);
    expect(noEmbedding.body.results[0]?.id).toBe(ids.webgl);

    await failNext('/v1/rerank', 1, 500);
    const noRerank = await search('ceramics shop');
    expect(noRerank.body.degraded).toEqual(['rerank']);
    expect(noRerank.body.results[0]?.id).toBe(ids.shop);
  });

  it('logs the query', async () => {
    const query = `logged query ${crypto.randomUUID()}`;
    await search(query);
    const { data } = await carol.client.from('search_events').select('query').eq('query', query);
    expect(data).toHaveLength(1);
  });

  it("only searches the caller's saves and refuses signed-out callers", async () => {
    const dave = await newUser('dave');
    const { body } = await search('typographic index projects', dave.token);
    expect(body.results).toEqual([]);
    expect((await search('anything', '')).status).toBe(401);
  });
});
