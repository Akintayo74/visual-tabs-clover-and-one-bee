import { describe, expect, it } from 'vitest';
import {
  applyFilters,
  colourFamily,
  colourOptions,
  fontOptions,
  hasFilters,
  NO_FILTERS,
} from '@/src/lib/filters';
import { localSimilar } from '@/src/lib/similar';
import type { SaveRecord } from '@/src/lib/types';
import { columnsFor } from '@/src/newtab/layout';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1000 * DAY;

function save(id: string, fields: Partial<SaveRecord> = {}, tags: string[] = []): SaveRecord {
  return {
    id,
    dedupeKey: `https://${id}.test/`,
    url: `https://${id}.test/`,
    canonicalUrl: null,
    title: id,
    siteName: id,
    faviconUrl: null,
    createdAt: NOW,
    updatedAt: NOW,
    status: 'ready',
    error: null,
    width: 2400,
    height: 1500,
    palette: [],
    fonts: [],
    note: null,
    syncState: 'synced',
    sync: { attempts: 0, nextAttemptAt: 0, error: null, remote: null },
    understanding: { status: 'ready', error: null, description: null, recallPhrases: [], tags },
    ...fields,
  };
}

describe('colourFamily', () => {
  it.each([
    ['#ffffff', 'white'],
    ['#fafaf8', 'white'],
    ['#000', 'black'],
    ['#18181b', 'black'],
    ['#808080', 'grey'],
    ['#c8c8c8', 'grey'],
    ['#ecebe7', 'white'],
    ['#d93a2b', 'red'],
    ['#ff7a00', 'orange'],
    ['#f5d000', 'yellow'],
    ['#2e9e4f', 'green'],
    ['#1fb5ad', 'teal'],
    ['#2f6fed', 'blue'],
    ['#0a1f5c', 'blue'],
    ['#7f4fd6', 'purple'],
    ['#ff5fa2', 'pink'],
    ['#6b4226', 'brown'],
  ])('%s is %s', (hex, family) => {
    expect(colourFamily(hex)).toBe(family);
  });

  it('ignores values it cannot read', () => {
    expect(colourFamily('rgb(1,2,3)')).toBeNull();
    expect(colourFamily('')).toBeNull();
  });
});

describe('filters', () => {
  const blue = save('blue', { palette: ['#ffffff', '#2f6fed'], fonts: ['Inter'] });
  const red = save('red', {
    palette: ['#111111', '#d93a2b'],
    fonts: ['Neue Haas Grotesk', 'inter'],
    createdAt: NOW - 40 * DAY,
  });
  const old = save('old', {
    palette: ['#f5d000'],
    fonts: ['Garamond'],
    createdAt: NOW - 200 * DAY,
    // Re-saved yesterday, but first saved long ago.
    updatedAt: NOW - DAY,
  });
  const all = [blue, red, old];

  it('lets everything through when none is set', () => {
    expect(hasFilters(NO_FILTERS)).toBe(false);
    expect(applyFilters(all, NO_FILTERS, NOW)).toBe(all);
  });

  it('filters by colour among the most prominent colours', () => {
    const ids = (colour: Parameters<typeof colourFamily>[0]) =>
      applyFilters(all, { ...NO_FILTERS, colour: colourFamily(colour) }, NOW).map((s) => s.id);
    expect(ids('#2f6fed')).toEqual(['blue']);
    expect(ids('#000000')).toEqual(['red']);
    const late = save('late', { palette: ['#fff', '#eee', '#ddd', '#ccc', '#bbb', '#d93a2b'] });
    expect(applyFilters([late], { ...NO_FILTERS, colour: 'red' }, NOW)).toEqual([]);
  });

  it('filters by font, ignoring case', () => {
    const ids = applyFilters(all, { ...NO_FILTERS, font: 'Inter' }, NOW).map((s) => s.id);
    expect(ids).toEqual(['blue', 'red']);
  });

  it('filters by when the site was first saved', () => {
    const ids = (saved: (typeof NO_FILTERS)['saved']) =>
      applyFilters(all, { ...NO_FILTERS, saved }, NOW).map((s) => s.id);
    expect(ids('week')).toEqual(['blue']);
    expect(ids('quarter')).toEqual(['blue', 'red']);
    expect(ids('older')).toEqual(['old']);
  });

  it('combines filters', () => {
    expect(applyFilters(all, { colour: 'red', font: 'inter', saved: 'week' }, NOW)).toEqual([]);
    expect(applyFilters(all, { colour: 'red', font: 'inter', saved: 'month' }, NOW)).toEqual([]);
    expect(applyFilters(all, { colour: 'red', font: 'inter', saved: 'quarter' }, NOW)).toEqual([
      red,
    ]);
  });

  it('offers the fonts and colours the library has, most used fonts first', () => {
    expect(fontOptions(all)).toEqual([
      { font: 'Inter', count: 2 },
      { font: 'Garamond', count: 1 },
      { font: 'Neue Haas Grotesk', count: 1 },
    ]);
    expect(colourOptions(all)).toEqual(['red', 'yellow', 'blue', 'black', 'white']);
  });
});

describe('localSimilar', () => {
  const source = save('source', { fonts: ['Inter'], palette: ['#000'] }, ['portfolio', 'grid']);
  const sameTags = save('same-tags', {}, ['grid', 'Portfolio']);
  const sameFont = save('same-font', { fonts: ['inter'] }, ['shop']);
  const nothing = save('nothing', { fonts: ['Garamond'], palette: ['#f5d000'] }, ['blog']);

  it('ranks by shared tags, then fonts and colours, and leaves out the source', () => {
    expect(localSimilar(source, [source, nothing, sameFont, sameTags]).map((s) => s.id)).toEqual([
      'same-tags',
      'same-font',
    ]);
  });
});

describe('columnsFor', () => {
  it('fits the window by default and follows the chosen density when there is room', () => {
    expect(columnsFor(1440, null, 24)).toBe(3);
    expect(columnsFor(1440, 2, 24)).toBe(2);
    expect(columnsFor(1440, 4, 24)).toBe(4);
  });

  it('never makes cards too narrow', () => {
    expect(columnsFor(500, 4, 24)).toBe(2);
    expect(columnsFor(200, 3, 24)).toBe(1);
  });
});
