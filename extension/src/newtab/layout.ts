export interface LayoutInput {
  /** Image height divided by width. */
  aspect: number;
}

export interface CardBox {
  index: number;
  left: number;
  top: number;
  width: number;
  imageHeight: number;
}

export interface Row {
  top: number;
  height: number;
  cards: CardBox[];
}

export interface Layout {
  columns: number;
  rows: Row[];
  totalHeight: number;
}

export interface LayoutOptions {
  width: number;
  columns: number;
  gap: number;
  /** Height of the text below each image. */
  metaHeight: number;
  /** Tallest an image may be relative to its width; taller ones are letterboxed, never cropped. */
  maxAspect: number;
}

/** 3 columns around 1440px wide, 4 on larger screens (PLAN.md). */
export function columnsForWidth(width: number): number {
  if (width >= 1800) return 4;
  if (width >= 1000) return 3;
  if (width >= 600) return 2;
  return 1;
}

/** Cards per row the density toggle offers; null means "fit the window" (columnsForWidth). */
export type Density = 2 | 3 | 4 | null;
export const DENSITIES: Exclude<Density, null>[] = [2, 3, 4];
/** Cards never get narrower than this, whatever density is chosen. */
const MIN_CARD_WIDTH = 220;

/** Columns for a chosen density, fewer when the window is too narrow to fit them. */
export function columnsFor(width: number, density: Density, gap: number): number {
  if (density === null) return columnsForWidth(width);
  const fit = Math.max(1, Math.floor((width + gap) / (MIN_CARD_WIDTH + gap)));
  return Math.min(density, fit);
}

/** Positions every card. Rows are as tall as their tallest image. */
export function computeLayout(items: LayoutInput[], options: LayoutOptions): Layout {
  const { width, gap, metaHeight, maxAspect } = options;
  const columns = Math.max(1, options.columns);
  const cardWidth = Math.max(0, (width - gap * (columns - 1)) / columns);
  const rows: Row[] = [];
  let top = 0;
  for (let start = 0; start < items.length; start += columns) {
    const cards: CardBox[] = [];
    let imageHeight = 0;
    for (let col = 0; col < columns && start + col < items.length; col++) {
      const aspect = Math.min(items[start + col]?.aspect || 0.625, maxAspect);
      imageHeight = Math.max(imageHeight, Math.round(cardWidth * aspect));
      cards.push({
        index: start + col,
        left: col * (cardWidth + gap),
        top,
        width: cardWidth,
        imageHeight: 0,
      });
    }
    for (const card of cards) card.imageHeight = imageHeight;
    const height = imageHeight + metaHeight;
    rows.push({ top, height, cards });
    top += height + gap;
  }
  return { columns, rows, totalHeight: Math.max(0, top - gap) };
}

/** Indexes of the rows that intersect the viewport, plus `overscan` pixels either side. */
export function visibleRows(
  layout: Layout,
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
): { first: number; last: number } {
  const from = scrollTop - overscan;
  const to = scrollTop + viewportHeight + overscan;
  let first = layout.rows.findIndex((row) => row.top + row.height >= from);
  if (first === -1) return { first: 0, last: -1 };
  let last = first;
  while (last + 1 < layout.rows.length && (layout.rows[last + 1]?.top ?? Infinity) <= to) last++;
  first = Math.max(0, first);
  return { first, last };
}

export type NavKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

/** Where keyboard focus moves in the grid. Stays put at the edges. */
export function nextIndex(current: number, key: NavKey, columns: number, count: number): number {
  if (count === 0) return -1;
  if (current < 0 || current >= count) return 0;
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, current - 1);
    case 'ArrowRight':
      return Math.min(count - 1, current + 1);
    case 'ArrowUp':
      return current - columns >= 0 ? current - columns : current;
    case 'ArrowDown': {
      if (current + columns < count) return current + columns;
      // From a row above a shorter last row, land on the last card.
      const lastRow = Math.floor((count - 1) / columns);
      return Math.floor(current / columns) < lastRow ? count - 1 : current;
    }
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
  }
}
