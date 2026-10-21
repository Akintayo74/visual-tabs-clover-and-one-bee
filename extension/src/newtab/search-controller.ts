import { applyRemoteOrder, localSearch, type SearchResults } from '@/src/lib/search';
import type { SaveRecord } from '@/src/lib/types';

/** Wait after the last keystroke before asking the server (Enter asks straight away). */
export const REMOTE_DELAY_MS = 450;

export interface SearchView {
  /** null means no query: show the whole wall. `replacing` is true when ranked results replace quick ones. */
  showResults(results: SaveRecord[] | null, replacing: boolean): void;
  setStatus(text: string): void;
}

/**
 * The search pipeline as the new tab sees it (PLAN.md "Search pipeline"): instant local
 * matches on every keystroke, then the server's ranking once typing pauses. A response for
 * an older query is ignored, so results never flip back to something already typed over.
 */
export class SearchController {
  private query = '';
  private saves: SaveRecord[] = [];
  private remote: { query: string; results: SearchResults } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sequence = 0;

  constructor(
    private readonly view: SearchView,
    private readonly remoteSearch: (query: string) => Promise<SearchResults | null>,
    private readonly delayMs = REMOTE_DELAY_MS,
  ) {}

  get activeQuery(): string {
    return this.query;
  }

  /** The saves on this device changed (a save, a sync, a delete). */
  setSaves(saves: SaveRecord[]): void {
    this.saves = saves;
    this.render(false);
  }

  /** The text in the search box changed. */
  setQuery(raw: string): void {
    const query = raw.trim();
    if (query === this.query) return;
    this.query = query;
    clearTimeout(this.timer);
    this.sequence++;
    if (!query) {
      this.remote = null;
      this.view.setStatus('');
      this.render(false);
      return;
    }
    this.render(false);
    this.timer = setTimeout(() => void this.runRemote(), this.delayMs);
  }

  /** Enter: ask the server now instead of waiting for the pause. */
  submit(): void {
    if (!this.query) return;
    clearTimeout(this.timer);
    if (this.remote?.query !== this.query) void this.runRemote();
  }

  private local(): SaveRecord[] {
    return localSearch(this.saves, this.query);
  }

  private render(replacing: boolean): void {
    if (!this.query) {
      this.view.showResults(null, false);
      return;
    }
    const local = this.local();
    if (this.remote?.query === this.query) {
      this.view.showResults(applyRemoteOrder(this.saves, this.remote.results, local), replacing);
      return;
    }
    this.view.showResults(local, false);
    this.view.setStatus(local.length ? 'Quick matches. Searching…' : 'Searching…');
  }

  private async runRemote(): Promise<void> {
    const query = this.query;
    const mine = ++this.sequence;
    let results: SearchResults | null;
    try {
      results = await this.remoteSearch(query);
    } catch (error) {
      if (mine !== this.sequence) return;
      console.warn('[search] remote search failed', error);
      this.view.setStatus("Quick matches only: smart search isn't reachable right now.");
      return;
    }
    if (mine !== this.sequence) return;
    if (!results) {
      this.view.setStatus('Quick matches only. Sign in to search by description.');
      return;
    }
    this.remote = { query, results };
    this.render(true);
    const partial = results.degraded.length ? ' Smart search was partly unavailable.' : '';
    const count = applyRemoteOrder(this.saves, results, this.local()).length;
    this.view.setStatus(
      count ? `Best matches first.${partial}` : `Nothing matches that yet.${partial}`,
    );
  }
}
