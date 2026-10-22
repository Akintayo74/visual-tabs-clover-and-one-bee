import { applyRemoteOrder, localSearch, type SearchResults } from '@/src/lib/search';
import { localSimilar } from '@/src/lib/similar';
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
  /** "More like this": the save whose look-alikes are shown, and the server's answer for it. */
  private similar: SaveRecord | null = null;
  private remoteSimilarIds: { id: string; ids: string[] } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sequence = 0;

  constructor(
    private readonly view: SearchView,
    private readonly remoteSearch: (query: string) => Promise<SearchResults | null>,
    private readonly delayMs = REMOTE_DELAY_MS,
    private readonly remoteSimilar: (id: string) => Promise<string[] | null> = () =>
      Promise.resolve(null),
  ) {}

  get activeQuery(): string {
    return this.query;
  }

  /** The save "More like this" is showing look-alikes of, if any. */
  get similarTo(): SaveRecord | null {
    return this.similar;
  }

  /**
   * Shows saves that look like `save`: at once from what this device knows (tags, fonts,
   * colours), then by the server's embeddings. null goes back to the wall or the query.
   */
  showSimilar(save: SaveRecord | null): void {
    clearTimeout(this.timer);
    this.sequence++;
    this.similar = save;
    this.remoteSimilarIds = null;
    if (!save) {
      this.view.setStatus('');
      this.render(false);
      return;
    }
    this.query = '';
    this.remote = null;
    this.render(false);
    void this.runSimilar(save);
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
    // Typing a search leaves "More like this".
    if (query) this.similar = null;
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

  private similarResults(source: SaveRecord): SaveRecord[] {
    const local = localSimilar(source, this.saves);
    if (this.remoteSimilarIds?.id !== source.id || !this.remoteSimilarIds.ids.length) return local;
    const byId = new Map(this.saves.map((s) => [s.id, s]));
    const ranked = this.remoteSimilarIds.ids
      .map((id) => byId.get(id))
      .filter((s): s is SaveRecord => !!s);
    const seen = new Set(ranked.map((s) => s.id));
    // Saves the server hasn't described yet can still look alike here.
    const extra = local.filter((s) => !seen.has(s.id) && s.understanding?.status !== 'ready');
    return [...ranked, ...extra];
  }

  private render(replacing: boolean): void {
    if (this.similar) {
      // A deleted source save ends "More like this".
      const source = this.saves.find((s) => s.id === this.similar?.id);
      if (!source) {
        this.similar = null;
        this.view.setStatus('');
      } else {
        this.similar = source;
        this.view.showResults(this.similarResults(source), replacing);
        return;
      }
    }
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

  private async runSimilar(save: SaveRecord): Promise<void> {
    const mine = this.sequence;
    const described = save.understanding?.status === 'ready';
    const localNote = described
      ? ''
      : ' Matched by tags, fonts and colours until this save is described.';
    this.view.setStatus(`Looking for saves like this…`);
    let ids: string[] | null;
    try {
      ids = await this.remoteSimilar(save.id);
    } catch (error) {
      if (mine !== this.sequence) return;
      console.warn('[similar] remote failed', error);
      this.view.setStatus(
        "Matched by tags, fonts and colours: the server isn't reachable right now.",
      );
      return;
    }
    if (mine !== this.sequence) return;
    if (ids === null) {
      this.view.setStatus('Matched by tags, fonts and colours. Sign in for closer matches.');
      return;
    }
    this.remoteSimilarIds = { id: save.id, ids };
    this.render(ids.length > 0);
    const count = this.similarResults(save).length;
    this.view.setStatus(
      count
        ? ids.length
          ? 'Closest first.'
          : `Closest first.${localNote}`
        : `Nothing similar yet.${localNote}`,
    );
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
