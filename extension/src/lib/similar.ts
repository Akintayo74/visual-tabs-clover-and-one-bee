import { familiesOf } from './filters';
import type { SaveRecord } from './types';
import { displayDomain } from './url';

/** How many saves "More like this" shows. */
export const SIMILAR_COUNT = 24;

export type SimilarMessage = { type: 'similar'; id: string };

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared++;
  return shared / (a.size + b.size - shared);
}

const lower = (items: string[]) => new Set(items.map((i) => i.trim().toLowerCase()));

/** How alike two saves look from what this device knows: tags, fonts, colours and site. */
export function localSimilarity(a: SaveRecord, b: SaveRecord): number {
  return (
    3 * jaccard(lower(a.understanding?.tags ?? []), lower(b.understanding?.tags ?? [])) +
    2 * jaccard(lower(a.fonts), lower(b.fonts)) +
    1.5 * jaccard(familiesOf(a), familiesOf(b)) +
    (displayDomain(a.url) === displayDomain(b.url) ? 1 : 0)
  );
}

/**
 * "More like this" without the server (signed out, offline, or not described yet): the
 * saves sharing the most tags, fonts and colours with `source`, best first.
 */
export function localSimilar(source: SaveRecord, saves: SaveRecord[]): SaveRecord[] {
  return saves
    .filter((s) => s.id !== source.id)
    .map((save, index) => ({ save, index, score: localSimilarity(source, save) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, SIMILAR_COUNT)
    .map((r) => r.save);
}
