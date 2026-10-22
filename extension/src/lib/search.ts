import type { SaveRecord } from './types';
import { displayDomain } from './url';

/** The semantic layer's answer: save ids, best first, and any steps the server skipped. */
export interface SearchResults {
  ids: string[];
  degraded: string[];
}

export type SearchMessage =
  | { type: 'search'; query: string }
  | { type: 'search-click'; query: string; id: string; rank: number }
  | { type: 'retry-understanding'; id: string };

const STOP_WORDS = new Set(
  (
    'a an and any are as at be but by do does for from had has have i in into is it its just ' +
    'like me my of on one or some that the their them there this to was were where which ' +
    'with you your site website page'
  ).split(' '),
);
// "one" and "page"/"site" are everywhere in memory-style queries but rarely tell saves apart;
// "one-page" still matches as a whole word below.

/** Lowercase words, with very common suffixes trimmed so "typographic" matches "typography". */
export function stem(word: string): string {
  if (word.length <= 4) return word;
  for (const suffix of ['ically', 'ical', 'ies', 'ing', 'ic', 'es', 'ed', 'al', 'ly', 'y', 's']) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? [];
}

/** The query's meaningful words, stemmed. */
export function queryTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const word of words(query)) {
    if (word.length < 2 || STOP_WORDS.has(word)) continue;
    terms.add(stem(word));
    // "one-page" also counts as "one" and "page" for matching hyphen-less text.
    if (word.includes('-')) {
      for (const part of word.split('-')) {
        if (part.length >= 2 && !STOP_WORDS.has(part)) terms.add(stem(part));
      }
    }
  }
  return [...terms];
}

interface Field {
  words: string[];
  weight: number;
}

const fieldCache = new WeakMap<SaveRecord, Field[]>();

function fieldsOf(save: SaveRecord): Field[] {
  let fields = fieldCache.get(save);
  if (fields) return fields;
  const u = save.understanding;
  const field = (text: string, weight: number): Field => ({
    words: [...new Set(words(text).flatMap((w) => [stem(w), ...w.split('-').map(stem)]))],
    weight,
  });
  fields = [
    field(`${save.title} ${save.siteName}`, 3),
    field(displayDomain(save.url), 2),
    field(u?.recallPhrases.join(' ') ?? '', 3),
    field(u?.tags.join(' ') ?? '', 2),
    field(save.note ?? '', 2),
    field(save.fonts.join(' '), 1),
    field(u?.description ?? '', 1),
  ];
  fieldCache.set(save, fields);
  return fields;
}

/** True when a and b differ by at most one insertion, deletion or substitution. */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** How well one query term matches a list of words: 1 for a word or prefix, 0.6 for a typo. */
function termMatch(term: string, fieldWords: string[]): number {
  let best = 0;
  for (const word of fieldWords) {
    if (word === term || (term.length >= 3 && word.startsWith(term))) return 1;
    if (best < 0.6 && term.length >= 5 && word[0] === term[0] && withinOneEdit(term, word)) {
      best = 0.6;
    }
  }
  return best;
}

/** How well a save matches the query terms; 0 when nothing matches. */
export function localScore(save: SaveRecord, terms: string[]): number {
  if (!terms.length) return 0;
  const fields = fieldsOf(save);
  let score = 0;
  let matched = 0;
  for (const term of terms) {
    let best = 0;
    for (const field of fields) best = Math.max(best, field.weight * termMatch(term, field.words));
    if (best > 0) matched++;
    score += best;
  }
  // Saves matching more of the query's words come first.
  return matched ? score * (matched / terms.length) : 0;
}

/**
 * The instant layer: keyword matching over the saves on this device, typo-tolerant, as the
 * user types. Best first; ties keep the wall's order (most recent first).
 */
export function localSearch(saves: SaveRecord[], query: string): SaveRecord[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  return saves
    .map((save, index) => ({ save, index, score: localScore(save, terms) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((r) => r.save);
}

/**
 * Orders the saves on this device by the server's ranking. Saves the server doesn't know yet
 * (not uploaded) but that match locally are kept, after the ranked ones.
 */
export function applyRemoteOrder(
  saves: SaveRecord[],
  remote: SearchResults,
  local: SaveRecord[],
): SaveRecord[] {
  const byId = new Map(saves.map((s) => [s.id, s]));
  const ranked = remote.ids.map((id) => byId.get(id)).filter((s): s is SaveRecord => !!s);
  const seen = new Set(ranked.map((s) => s.id));
  const unsynced = local.filter((s) => !seen.has(s.id) && s.syncState === 'pending');
  return [...ranked, ...unsynced];
}
