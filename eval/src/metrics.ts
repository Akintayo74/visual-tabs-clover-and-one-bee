export interface EvalQuery {
  query: string;
  /** Save ids or page URLs; a hit is any of them. */
  expected: string[];
  set: string;
}

export interface QueryResult extends EvalQuery {
  /** 1-based rank of the first expected save, or null if it wasn't returned. */
  rank: number | null;
  top: string[];
}

export interface SetSummary {
  set: string;
  count: number;
  hitAt1: number;
  hitAt3: number;
  hitAt5: number;
  /** Mean reciprocal rank. */
  mrr: number;
}

/** The PLAN.md bar, on real queries: right site first ~70% of the time, in the top 5 ~90%. */
export const TARGETS = { hitAt1: 0.7, hitAt5: 0.9 };

export function rankOf(results: string[], isExpected: (id: string) => boolean): number | null {
  const index = results.findIndex(isExpected);
  return index === -1 ? null : index + 1;
}

export function summarize(results: QueryResult[]): SetSummary[] {
  const sets = [...new Set(results.map((r) => r.set))];
  return sets.map((set) => {
    const rows = results.filter((r) => r.set === set);
    const share = (k: number) =>
      rows.filter((r) => r.rank !== null && r.rank <= k).length / rows.length;
    return {
      set,
      count: rows.length,
      hitAt1: share(1),
      hitAt3: share(3),
      hitAt5: share(5),
      mrr: rows.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / rows.length,
    };
  });
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(5);

export function formatSummary(summaries: SetSummary[]): string {
  const lines = ['set        queries  hit@1  hit@3  hit@5   MRR'];
  for (const s of summaries) {
    lines.push(
      `${s.set.padEnd(10)} ${String(s.count).padStart(7)}  ${pct(s.hitAt1)}  ${pct(s.hitAt3)}  ${pct(s.hitAt5)}  ${s.mrr.toFixed(2)}`,
    );
  }
  const real = summaries.find((s) => s.set === 'real');
  if (real) {
    const ok = real.hitAt1 >= TARGETS.hitAt1 && real.hitAt5 >= TARGETS.hitAt5;
    lines.push(
      '',
      `Target on real queries: hit@1 ≥ ${pct(TARGETS.hitAt1).trim()}, hit@5 ≥ ${pct(TARGETS.hitAt5).trim()}: ${ok ? 'met' : 'not met'}`,
    );
  }
  return lines.join('\n');
}
