import type { SaveRecord } from './types';

/** The colour families the colour filter offers, in the order they're shown. */
export const COLOUR_FAMILIES = [
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
  'brown',
  'black',
  'grey',
  'white',
] as const;
export type ColourFamily = (typeof COLOUR_FAMILIES)[number];

/** A representative swatch for each family, for the filter buttons. */
export const FAMILY_SWATCH: Record<ColourFamily, string> = {
  red: '#d93a2b',
  orange: '#ef8a2a',
  yellow: '#f2cf3a',
  green: '#3ea85a',
  teal: '#22a7a0',
  blue: '#2f6fed',
  purple: '#7f4fd6',
  pink: '#e26aa8',
  brown: '#8a5a35',
  black: '#111111',
  grey: '#9a9a9a',
  white: '#ffffff',
};

/** Only a page's most prominent colours count; the tail is mostly borders and icons. */
const PROMINENT_COLOURS = 5;

function parseHex(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match?.[1]) return null;
  const digits = match[1].length === 3 ? match[1].replace(/./g, '$&$&') : match[1];
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

/** Hue (0–360), saturation and lightness (0–1). */
function toHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

/** The family a colour belongs to, or null if it isn't a colour we can read. */
export function colourFamily(hex: string): ColourFamily | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [h, s, l] = toHsl(rgb);
  if (l < 0.12) return 'black';
  if (l > 0.94) return 'white';
  if (s < 0.15 || (s < 0.25 && (l < 0.2 || l > 0.85))) {
    return l < 0.2 ? 'black' : l > 0.88 ? 'white' : 'grey';
  }
  if (h >= 15 && h < 45 && l < 0.42) return 'brown';
  if (h < 12 || h >= 345) return 'red';
  if (h < 40) return 'orange';
  if (h < 66) return 'yellow';
  if (h < 160) return 'green';
  if (h < 195) return 'teal';
  if (h < 255) return 'blue';
  if (h < 290) return 'purple';
  return 'pink';
}

const familyCache = new WeakMap<SaveRecord, Set<ColourFamily>>();

/** The colour families among a save's most prominent colours. */
export function familiesOf(save: SaveRecord): Set<ColourFamily> {
  let families = familyCache.get(save);
  if (!families) {
    families = new Set(
      save.palette
        .slice(0, PROMINENT_COLOURS)
        .map(colourFamily)
        .filter((f): f is ColourFamily => f !== null),
    );
    familyCache.set(save, families);
  }
  return families;
}

export type SavedWithin = 'any' | 'week' | 'month' | 'quarter' | 'older';

export const SAVED_WITHIN_LABELS: Record<SavedWithin, string> = {
  any: 'Any time',
  week: 'Past week',
  month: 'Past month',
  quarter: 'Past 3 months',
  older: 'Over 3 months ago',
};

const DAY_MS = 24 * 60 * 60 * 1000;
const WITHIN_MS: Record<Exclude<SavedWithin, 'any' | 'older'>, number> = {
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  quarter: 91 * DAY_MS,
};

export interface Filters {
  colour: ColourFamily | null;
  /** A font family name, matched case-insensitively. */
  font: string | null;
  saved: SavedWithin;
}

export const NO_FILTERS: Filters = { colour: null, font: null, saved: 'any' };

export function hasFilters(filters: Filters): boolean {
  return filters.colour !== null || filters.font !== null || filters.saved !== 'any';
}

export function matchesFilters(save: SaveRecord, filters: Filters, now: number): boolean {
  if (filters.colour && !familiesOf(save).has(filters.colour)) return false;
  if (filters.font) {
    const font = filters.font.toLowerCase();
    if (!save.fonts.some((f) => f.toLowerCase() === font)) return false;
  }
  if (filters.saved !== 'any') {
    // When the site was first saved; re-saving it doesn't make it new.
    const age = now - save.createdAt;
    if (filters.saved === 'older') {
      if (age < WITHIN_MS.quarter) return false;
    } else if (age > WITHIN_MS[filters.saved]) {
      return false;
    }
  }
  return true;
}

/** Keeps the saves that pass every filter, in the order given. */
export function applyFilters(saves: SaveRecord[], filters: Filters, now: number): SaveRecord[] {
  if (!hasFilters(filters)) return saves;
  return saves.filter((save) => matchesFilters(save, filters, now));
}

/** Fonts used across the library, most used first, for the font filter. */
export function fontOptions(saves: SaveRecord[]): { font: string; count: number }[] {
  const counts = new Map<string, { font: string; count: number }>();
  for (const save of saves) {
    for (const font of new Set(save.fonts.map((f) => f.trim()).filter(Boolean))) {
      const key = font.toLowerCase();
      const entry = counts.get(key);
      if (entry) entry.count++;
      else counts.set(key, { font, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.font.localeCompare(b.font));
}

/** Colour families present in the library, in display order, for the colour filter. */
export function colourOptions(saves: SaveRecord[]): ColourFamily[] {
  const present = new Set<ColourFamily>();
  for (const save of saves) for (const family of familiesOf(save)) present.add(family);
  return COLOUR_FAMILIES.filter((f) => present.has(f));
}
