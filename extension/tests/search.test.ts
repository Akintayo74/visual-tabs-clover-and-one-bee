import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyRemoteOrder,
  localScore,
  localSearch,
  queryTerms,
  stem,
  type SearchResults,
} from '@/src/lib/search';
import type { SaveRecord, Understanding } from '@/src/lib/types';
import { SearchController } from '@/src/newtab/search-controller';
import { understandingBadge } from '@/src/newtab/wall';

function save(
  id: string,
  fields: Partial<SaveRecord> = {},
  understanding?: Partial<Understanding>,
): SaveRecord {
  return {
    id,
    dedupeKey: `https://${id}.test/`,
    url: `https://${id}.test/`,
    canonicalUrl: null,
    title: id,
    siteName: id,
    faviconUrl: null,
    createdAt: 0,
    updatedAt: 0,
    status: 'ready',
    error: null,
    width: 2400,
    height: 1500,
    palette: [],
    fonts: [],
    note: null,
    syncState: 'synced',
    sync: { attempts: 0, nextAttemptAt: 0, error: null, remote: null },
    ...fields,
    ...(understanding
      ? {
          understanding: {
            status: 'ready',
            error: null,
            description: null,
            recallPhrases: [],
            tags: [],
            ...understanding,
          },
        }
      : {}),
  };
}

const index = save(
  'index',
  { title: 'Studio Index', fonts: ['Neue Haas Grotesk'] },
  {
    description: 'A one-page portfolio of oversized typographic links on white.',
    recallPhrases: ['a one-page site that is just huge typographic links to other pages'],
    tags: ['portfolio', 'one-page', 'oversized type'],
  },
);
const shop = save(
  'shop',
  { title: 'Ceramics', note: 'Nice product grid' },
  {
    description: 'A calm e-commerce site selling ceramics, with a beige palette.',
    recallPhrases: ['beige pottery shop with a product grid'],
    tags: ['e-commerce', 'beige'],
  },
);
const webgl = save('webgl', { title: 'Liquid' }, { tags: ['webgl', '3d', 'dark mode'] });
const all = [index, shop, webgl];

describe('queryTerms', () => {
  it('drops filler words and stems the rest', () => {
    expect(queryTerms('a one-page site with only one section with large text on it')).toEqual([
      'one-page',
      'only',
      'section',
      'large',
      'text',
    ]);
    expect(stem('typographic')).toBe(stem('typography'));
    expect(stem('links')).toBe('link');
  });
});

describe('localSearch', () => {
  it('matches what the model said about a save, not just its title', () => {
    expect(localSearch(all, 'huge typographic links')[0]?.id).toBe('index');
    expect(localSearch(all, 'pottery shop')[0]?.id).toBe('shop');
    expect(localSearch(all, 'dark 3d')[0]?.id).toBe('webgl');
  });

  it('matches word starts, notes and fonts', () => {
    expect(localSearch(all, 'cera')[0]?.id).toBe('shop');
    expect(localSearch(all, 'product grid')[0]?.id).toBe('shop');
    expect(localSearch(all, 'haas')[0]?.id).toBe('index');
  });

  it('tolerates a typo in longer words', () => {
    expect(localSearch(all, 'portfoilo')).toEqual([]);
    expect(localSearch(all, 'portfolo')[0]?.id).toBe('index');
  });

  it('ranks saves matching more of the query first, and keeps wall order on ties', () => {
    const both = localSearch(all, 'beige portfolio');
    expect(both.map((s) => s.id).sort()).toEqual(['index', 'shop']);
    expect(localScore(index, queryTerms('oversized portfolio'))).toBeGreaterThan(
      localScore(index, queryTerms('oversized pottery')),
    );
    const twins = [save('b', { title: 'Same' }), save('a', { title: 'Same' })];
    expect(localSearch(twins, 'same').map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('finds nothing for an empty or filler-only query', () => {
    expect(localSearch(all, '')).toEqual([]);
    expect(localSearch(all, 'a site with the')).toEqual([]);
  });
});

describe('applyRemoteOrder', () => {
  it("follows the server's order and keeps local matches the server hasn't seen yet", () => {
    const fresh = save('fresh', { syncState: 'pending' });
    const ordered = applyRemoteOrder(
      [...all, fresh],
      { ids: ['webgl', 'missing', 'index'], degraded: [] },
      [fresh, shop],
    );
    expect(ordered.map((s) => s.id)).toEqual(['webgl', 'index', 'fresh']);
  });
});

describe('understandingBadge', () => {
  it('shows describing and failed states on uploaded cards while signed in', () => {
    expect(understandingBadge(save('x', {}, { status: 'pending' }), true)).toBe('Describing…');
    expect(understandingBadge(save('x', {}, { status: 'pending', error: 'down' }), true)).toBe(
      'Describing, retrying soon',
    );
    expect(understandingBadge(save('x', {}, { status: 'failed' }), true)).toBe("Couldn't describe");
    expect(understandingBadge(save('x', {}, { status: 'ready' }), true)).toBeNull();
    expect(understandingBadge(save('x', {}, { status: 'pending' }), false)).toBeNull();
    expect(
      understandingBadge(save('x', { syncState: 'pending' }, { status: 'pending' }), true),
    ).toBeNull();
  });
});

describe('SearchController', () => {
  let shown: (string[] | null)[];
  let replaced: boolean[];
  let status: string;
  const view = {
    showResults(results: SaveRecord[] | null, replacing: boolean) {
      shown.push(results?.map((s) => s.id) ?? null);
      replaced.push(replacing);
    },
    setStatus(text: string) {
      status = text;
    },
  };

  beforeEach(() => {
    vi.useFakeTimers();
    shown = [];
    replaced = [];
    status = '';
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows quick matches at once, then the ranked results after a pause', async () => {
    const remote = vi
      .fn<(query: string) => Promise<SearchResults>>()
      .mockResolvedValue({ ids: ['shop', 'index'], degraded: [] });
    const controller = new SearchController(view, remote, 300);
    controller.setSaves(all);
    controller.setQuery('beige portfolio');
    expect(shown.at(-1)?.sort()).toEqual(['index', 'shop']);
    expect(status).toMatch(/Searching/);
    expect(remote).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(remote).toHaveBeenCalledWith('beige portfolio');
    expect(shown.at(-1)).toEqual(['shop', 'index']);
    expect(replaced.at(-1)).toBe(true);
    expect(status).toBe('Best matches first.');

    controller.setQuery('');
    expect(shown.at(-1)).toBeNull();
    expect(status).toBe('');
  });

  it('ignores an answer for a query that was typed over', async () => {
    let resolveFirst: (r: SearchResults) => void = () => undefined;
    const remote = vi
      .fn<(query: string) => Promise<SearchResults>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ ids: ['webgl'], degraded: [] });
    const controller = new SearchController(view, remote, 100);
    controller.setSaves(all);
    controller.setQuery('first');
    controller.submit();
    controller.setQuery('second query');
    controller.submit();
    await vi.advanceTimersByTimeAsync(0);
    resolveFirst({ ids: ['index'], degraded: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(shown.at(-1)).toEqual(['webgl']);
  });

  it('keeps the quick matches and says why when the server fails or the user is signed out', async () => {
    const failing = new SearchController(view, () => Promise.reject(new Error('offline')), 10);
    failing.setSaves(all);
    failing.setQuery('pottery');
    await vi.advanceTimersByTimeAsync(10);
    expect(shown.at(-1)).toEqual(['shop']);
    expect(status).toMatch(/Quick matches only/);

    const signedOut = new SearchController(view, () => Promise.resolve(null), 10);
    signedOut.setSaves(all);
    signedOut.setQuery('pottery');
    await vi.advanceTimersByTimeAsync(10);
    expect(status).toMatch(/Sign in/);
  });

  it('keeps the ranked order when saves change underneath', async () => {
    const controller = new SearchController(
      view,
      () => Promise.resolve({ ids: ['webgl', 'shop'], degraded: ['rerank'] }),
      10,
    );
    controller.setSaves(all);
    controller.setQuery('anything');
    await vi.advanceTimersByTimeAsync(10);
    expect(status).toMatch(/partly unavailable/);
    controller.setSaves([shop, webgl]);
    expect(shown.at(-1)).toEqual(['webgl', 'shop']);
    expect(replaced.at(-1)).toBe(false);
  });
});
