import { describe as group, expect, it } from 'vitest';
import {
  accountProblem,
  describe,
  embedQuery,
  embedSave,
  ModelError,
  rerank,
  retryableStatus,
} from '../../../supabase/functions/_shared/models.ts';
import { retryDelayMs, toBase64 } from '../../../supabase/functions/_shared/process.ts';
import {
  factsText,
  parseUnderstanding,
  searchText,
} from '../../../supabase/functions/_shared/prompt.ts';
import { mergeRanking, type Candidate } from '../../../supabase/functions/_shared/search.ts';

const fingerprint = {
  version: 1,
  viewport: { width: 1440, height: 900 },
  pageHeightViewports: 1,
  sectionCount: 1,
  hasHeader: false,
  hasNav: false,
  hasFooter: false,
  largestText: [
    { text: 'Work', fontSize: 180, isLink: true, href: 'https://x.test/work' },
    { text: 'About', fontSize: 180, isLink: true, href: 'https://x.test/about' },
  ],
  links: { total: 2, internal: 2, external: 0 },
  fonts: { headings: ['Neue Haas'], body: ['Inter'] },
  palette: ['#000000', '#ffffff'],
  signals: {
    webgl: false,
    largeCanvas: false,
    videoBackground: false,
    scrollAnimation: false,
    libraries: [],
  },
  truncated: false,
};

group('factsText', () => {
  it('spells out the structure the screenshot cannot show', () => {
    const text = factsText({ url: 'https://x.test/', title: 'X', siteName: 'X', fingerprint });
    expect(text).toContain('Page height: 1 screens');
    expect(text).toContain('Sections: 1');
    expect(text).toContain('"Work" (180px, a link to https://x.test/work)');
    expect(text).toContain('Fonts: headings Neue Haas; body Inter');
    expect(text).toContain('Detected: nothing notable');
  });

  it('copes with a save that has no fingerprint', () => {
    const text = factsText({ url: 'https://x.test/', title: '', siteName: '', fingerprint: null });
    expect(text).toContain('No page measurements');
  });
});

group('parseUnderstanding', () => {
  const valid = {
    description: 'A one-page portfolio made of huge black links on white.',
    recall_phrases: [
      'huge links',
      'Huge links',
      ' one page of big words ',
      'black and white index',
    ],
    tags: ['Portfolio', 'one-page', 'portfolio'],
  };

  it('trims, de-duplicates and lowercases tags', () => {
    expect(parseUnderstanding(valid)).toEqual({
      description: valid.description,
      recallPhrases: ['huge links', 'one page of big words', 'black and white index'],
      tags: ['portfolio', 'one-page'],
    });
  });

  it('caps the counts', () => {
    const many = {
      ...valid,
      recall_phrases: Array.from({ length: 20 }, (_, i) => `phrase ${String(i)}`),
    };
    expect(parseUnderstanding(many).recallPhrases).toHaveLength(8);
  });

  it('rejects answers that would make a useless search entry', () => {
    expect(() => parseUnderstanding({ ...valid, description: '' })).toThrow();
    expect(() => parseUnderstanding({ ...valid, recall_phrases: ['one'] })).toThrow();
    expect(() => parseUnderstanding(null)).toThrow();
  });
});

group('searchText', () => {
  it('puts the name, recall phrases, tags and description together', () => {
    const text = searchText({
      title: 'Home',
      siteName: 'Studio',
      description: 'Desc.',
      recallPhrases: ['a', 'b'],
      tags: ['t'],
    });
    expect(text).toBe('Studio — Home\n\na\nb\n\nTags: t\n\nDesc.');
  });

  it("adds the user's note after the name when there is one", () => {
    const text = searchText({
      title: 'Home',
      siteName: '',
      description: null,
      recallPhrases: null,
      tags: null,
      note: 'the one Tolu sent',
    });
    expect(text).toBe('Home\n\nNote: the one Tolu sent');
  });
});

function fakeClient(response: unknown, error?: Error) {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      beta: {
        messages: {
          create: (params: unknown) => {
            calls.push(params);
            return error ? Promise.reject(error) : Promise.resolve(response);
          },
        },
      },
    } as never,
  };
}

const input = {
  url: 'https://x.test/',
  title: 'X',
  siteName: 'X',
  fingerprint,
  imageBase64: 'AAAA',
  mediaType: 'image/webp' as const,
};

group('describe', () => {
  it('sends the screenshot and facts with structured output and the fallback', async () => {
    const { client, calls } = fakeClient({
      stop_reason: 'end_turn',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            description: 'A long enough description.',
            recall_phrases: ['a b', 'c d', 'e f'],
            tags: ['x'],
          }),
        },
      ],
    });
    const result = await describe(client, input);
    expect(result.recallPhrases).toEqual(['a b', 'c d', 'e f']);
    expect(calls[0]).toMatchObject({
      model: 'claude-sonnet-5-5',
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
      output_config: { format: { type: 'json_schema' } },
    });
  });

  it('a refusal is not retried; running out of tokens is', async () => {
    const refused = fakeClient({ stop_reason: 'refusal', content: [] });
    await expect(describe(refused.client, input)).rejects.toMatchObject({ retryable: false });
    const cut = fakeClient({ stop_reason: 'max_tokens', content: [] });
    await expect(describe(cut.client, input)).rejects.toMatchObject({ retryable: true });
  });

  it('API errors are retried only when retrying can help', async () => {
    const overloaded = fakeClient(null, Object.assign(new Error('overloaded'), { status: 529 }));
    await expect(describe(overloaded.client, input)).rejects.toMatchObject({ retryable: true });
    const bad = fakeClient(null, Object.assign(new Error('bad'), { status: 400 }));
    await expect(describe(bad.client, input)).rejects.toMatchObject({ retryable: false });
  });
});

function fakeFetch(status: number, body: unknown) {
  const requests: { url: string; body: unknown }[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(init.body as string) });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as unknown as typeof fetch;
  return { requests, fetchFn };
}

group('Voyage calls', () => {
  const vector = new Array<number>(1024).fill(0.5);

  it('embeds a save as one interleaved text-and-image input', async () => {
    const { requests, fetchFn } = fakeFetch(200, { data: [{ embedding: vector, index: 0 }] });
    await embedSave(
      { apiKey: 'k', fetch: fetchFn },
      { text: 'hello', imageBase64: 'AAAA', mediaType: 'image/webp' },
    );
    expect(requests[0]).toEqual({
      url: 'https://api.voyageai.com/v1/multimodalembeddings',
      body: {
        model: 'voyage-multimodal-3.5',
        input_type: 'document',
        inputs: [
          {
            content: [
              { type: 'text', text: 'hello' },
              { type: 'image_base64', image_base64: 'data:image/webp;base64,AAAA' },
            ],
          },
        ],
      },
    });
  });

  it('embeds queries in query mode and checks the size', async () => {
    const { requests, fetchFn } = fakeFetch(200, { data: [{ embedding: vector }] });
    await embedQuery({ apiKey: 'k', fetch: fetchFn }, 'q');
    expect(requests[0]?.body).toMatchObject({ input_type: 'query' });
    const short = fakeFetch(200, { data: [{ embedding: [1, 2] }] });
    await expect(embedQuery({ apiKey: 'k', fetch: short.fetchFn }, 'q')).rejects.toBeInstanceOf(
      ModelError,
    );
  });

  it('reranks best first and maps HTTP errors', async () => {
    const { fetchFn } = fakeFetch(200, {
      data: [
        { index: 1, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.2 },
      ],
    });
    expect(await rerank({ apiKey: 'k', fetch: fetchFn }, 'q', ['a', 'b'])).toEqual([
      { index: 1, score: 0.9 },
      { index: 0, score: 0.2 },
    ]);
    const limited = fakeFetch(429, { detail: 'slow down' });
    await expect(rerank({ apiKey: 'k', fetch: limited.fetchFn }, 'q', ['a'])).rejects.toMatchObject(
      {
        retryable: true,
      },
    );
  });
});

group('helpers', () => {
  it('classifies retryable statuses', () => {
    expect([408, 409, 429, 500, 529, undefined].every(retryableStatus)).toBe(true);
    expect([400, 401, 403, 404, 413].some(retryableStatus)).toBe(false);
  });

  it('treats account problems as fixable, not as a bad save', () => {
    expect(accountProblem(400, 'Your credit balance is too low to access the Anthropic API.')).toBe(
      true,
    );
    expect([401, 402, 403].every((s) => accountProblem(s, ''))).toBe(true);
    expect(accountProblem(400, 'messages: image too large')).toBe(false);
    expect(accountProblem(404, 'not found')).toBe(false);
  });

  it('backs off from a minute to six hours', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(retryDelayMs)).toEqual([
      60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 21_600_000, 21_600_000,
    ]);
  });

  it('base64-encodes large images', () => {
    const bytes = new Uint8Array(200_000).map((_, i) => i % 256);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('puts reranked results first, then the rest in fused order', () => {
    const c = (id: string, score: number): Candidate => ({
      id,
      score,
      vector_rank: null,
      keyword_rank: null,
      title: id,
      site_name: '',
      url: '',
      description: null,
      recall_phrases: null,
      tags: null,
      note: null,
    });
    const candidates = [c('a', 0.3), c('b', 0.2), c('c', 0.1)];
    expect(
      mergeRanking(candidates, [
        { index: 1, score: 0.9 },
        { index: 0, score: 0.1 },
      ]),
    ).toEqual([
      { id: 'b', score: 0.9 },
      { id: 'a', score: 0.1 },
      { id: 'c', score: 0.1 },
    ]);
    expect(mergeRanking(candidates, null).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});
