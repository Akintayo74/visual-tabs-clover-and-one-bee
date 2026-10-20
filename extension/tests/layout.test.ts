import { describe, expect, it } from 'vitest';
import { columnsForWidth, computeLayout, nextIndex, visibleRows } from '@/src/newtab/layout';

const options = { width: 1000, columns: 3, gap: 20, metaHeight: 50, maxAspect: 1.25 };

describe('columnsForWidth', () => {
  it('uses 3 columns around 1440px and 4 on larger screens', () => {
    expect(columnsForWidth(1440)).toBe(3);
    expect(columnsForWidth(1920)).toBe(4);
    expect(columnsForWidth(800)).toBe(2);
    expect(columnsForWidth(400)).toBe(1);
  });
});

describe('computeLayout', () => {
  it('places cards in rows as tall as their tallest image', () => {
    const layout = computeLayout(
      [{ aspect: 0.5 }, { aspect: 0.75 }, { aspect: 0.5 }, { aspect: 0.5 }],
      options,
    );
    expect(layout.rows).toHaveLength(2);
    const [first, second] = layout.rows;
    expect(first?.cards.map((c) => c.left)).toEqual([0, 340, 680]);
    expect(first?.cards.every((c) => c.width === 320 && c.imageHeight === 240)).toBe(true);
    expect(first?.height).toBe(290);
    expect(second?.top).toBe(310);
    expect(second?.cards[0]?.imageHeight).toBe(160);
    expect(layout.totalHeight).toBe(310 + 210);
  });

  it('caps very tall images instead of stretching the row', () => {
    const layout = computeLayout([{ aspect: 5 }], options);
    expect(layout.rows[0]?.cards[0]?.imageHeight).toBe(400);
  });

  it('handles an empty wall', () => {
    expect(computeLayout([], options)).toEqual({ columns: 3, rows: [], totalHeight: 0 });
  });
});

describe('visibleRows', () => {
  const layout = computeLayout(
    Array.from({ length: 30 }, () => ({ aspect: 0.5 })),
    options,
  );

  it('returns only rows near the viewport', () => {
    // Rows are 210px tall with a 20px gap: 230px per row.
    expect(visibleRows(layout, 0, 500, 0)).toEqual({ first: 0, last: 2 });
    expect(visibleRows(layout, 1000, 500, 0)).toEqual({ first: 4, last: 6 });
    expect(visibleRows(layout, 1000, 500, 500)).toEqual({ first: 2, last: 8 });
  });

  it('returns nothing past the end', () => {
    expect(visibleRows(layout, 100000, 500, 0)).toEqual({ first: 0, last: -1 });
  });
});

describe('nextIndex', () => {
  // 3 columns, 7 cards: rows [0 1 2] [3 4 5] [6]
  it('moves within the grid', () => {
    expect(nextIndex(-1, 'ArrowDown', 3, 7)).toBe(0);
    expect(nextIndex(0, 'ArrowRight', 3, 7)).toBe(1);
    expect(nextIndex(1, 'ArrowDown', 3, 7)).toBe(4);
    expect(nextIndex(4, 'ArrowUp', 3, 7)).toBe(1);
    expect(nextIndex(3, 'ArrowLeft', 3, 7)).toBe(2);
    expect(nextIndex(2, 'End', 3, 7)).toBe(6);
    expect(nextIndex(6, 'Home', 3, 7)).toBe(0);
  });

  it('stays put at the edges', () => {
    expect(nextIndex(0, 'ArrowLeft', 3, 7)).toBe(0);
    expect(nextIndex(1, 'ArrowUp', 3, 7)).toBe(1);
    expect(nextIndex(6, 'ArrowRight', 3, 7)).toBe(6);
    expect(nextIndex(6, 'ArrowDown', 3, 7)).toBe(6);
  });

  it('drops onto the last card from above a short last row', () => {
    expect(nextIndex(5, 'ArrowDown', 3, 7)).toBe(6);
  });

  it('returns -1 for an empty wall', () => {
    expect(nextIndex(-1, 'ArrowRight', 3, 0)).toBe(-1);
  });
});
