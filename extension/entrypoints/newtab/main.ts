import { listSaves } from '@/src/lib/db';
import { applyFilters, hasFilters, NO_FILTERS, type Filters } from '@/src/lib/filters';
import type { SearchResults } from '@/src/lib/search';
import { sendToWorker, subscribe } from '@/src/lib/events';
import type { SaveRecord } from '@/src/lib/types';
import { AccountPanel } from '@/src/newtab/account-panel';
import { Detail } from '@/src/newtab/detail';
import { FilterBar } from '@/src/newtab/filter-bar';
import { currentShortcuts, HelpPanel } from '@/src/newtab/help-panel';
import { ImportPanel } from '@/src/newtab/import-panel';
import { DENSITIES, type Density, type NavKey } from '@/src/newtab/layout';
import { SearchController } from '@/src/newtab/search-controller';
import { Wall } from '@/src/newtab/wall';
import './style.css';

performance.mark('newtab-start');

const NAV_KEYS = new Set<string>([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
]);

const wallEl = document.querySelector<HTMLElement>('.wall');
const emptyEl = document.querySelector<HTMLElement>('.empty');
const emptyTextEl = document.querySelector<HTMLElement>('.empty-text');
const emptyActionEl = document.querySelector<HTMLButtonElement>('.empty-action');
const countEl = document.querySelector<HTMLElement>('.count');
const noticeEl = document.querySelector<HTMLElement>('.notice');
if (!wallEl || !emptyEl || !emptyTextEl || !emptyActionEl || !countEl || !noticeEl) {
  throw new Error('new tab markup is missing');
}
const empty = emptyEl;
const emptyText = emptyTextEl;
const emptyAction = emptyActionEl;
const notice = noticeEl;

/** A problem the person should know about, shown above the wall until dismissed or replaced. */
function showNotice(text: string | null): void {
  notice.textContent = text ?? '';
  notice.hidden = !text;
}
const importTrigger = document.querySelector<HTMLButtonElement>('.import-trigger');
const importPanel = document.querySelector<HTMLElement>('.import');
if (importTrigger && importPanel) new ImportPanel(importTrigger, importPanel);
const count = countEl;

function retry(save: SaveRecord): void {
  void sendToWorker({ type: 'retry', id: save.id }).catch((error: unknown) => {
    console.warn('[retry] failed', error);
  });
}

function retryUnderstanding(save: SaveRecord): void {
  void sendToWorker({ type: 'retry-understanding', id: save.id }).catch((error: unknown) => {
    console.warn('[retry] failed', error);
  });
}

const detail = new Detail({
  onRetry: retry,
  onRetryUnderstanding: retryUnderstanding,
  onDeleted: () => {
    // Tell the server (and so other devices) about the delete.
    void sendToWorker({ type: 'sync-now' }).catch(() => undefined);
  },
  onNoteSaved: () => {
    void sendToWorker({ type: 'sync-now' }).catch(() => undefined);
  },
  onMoreLikeThis: (save) => {
    if (searchInput) searchInput.value = '';
    lastQuery = '';
    window.scrollTo({ top: 0 });
    search.showSimilar(save);
  },
});
const wall = new Wall(wallEl, {
  onOpen: (save, index) => {
    const query = search.activeQuery;
    if (query && index >= 0) {
      void sendToWorker({ type: 'search-click', query, id: save.id, rank: index + 1 }).catch(
        () => undefined,
      );
    }
    void detail.show(save);
  },
  onRetry: retry,
  onRetryUnderstanding: retryUnderstanding,
});

const searchInput = document.querySelector<HTMLInputElement>('.search-input');
const searchStatus = document.querySelector<HTMLElement>('.search-status');
const similarBanner = document.querySelector<HTMLElement>('.similar-banner');
const similarLabel = document.querySelector<HTMLElement>('.similar-label');
let allSaves: SaveRecord[] = [];
let onboarding = '';
let loaded = false;
let filters: Filters = NO_FILTERS;
/** What search or "More like this" last asked to show; null is the whole wall. */
let results: SaveRecord[] | null = null;

const plural = (n: number, one: string, many = `${one}s`) => `${String(n)} ${n === 1 ? one : many}`;

function setEmpty(text: string, action: { label: string; run: () => void } | null = null): void {
  emptyText.textContent = text;
  emptyAction.hidden = !action;
  emptyAction.textContent = action?.label ?? '';
  emptyAction.onclick = action
    ? () => {
        action.run();
      }
    : null;
}

/** Puts what search asked for, narrowed by the filters, on the wall. */
function render(): void {
  const base = results ?? allSaves;
  const shown = applyFilters(base, filters, Date.now());
  wall.setSaves(shown);

  const similar = search.similarTo;
  if (similarBanner && similarLabel) {
    similarBanner.hidden = !similar;
    similarLabel.textContent = similar ? `More like ${similar.siteName || similar.title}` : '';
  }

  const filtered = hasFilters(filters);
  if (!allSaves.length) count.textContent = '';
  else if (similar) count.textContent = plural(shown.length, 'similar site', 'similar sites');
  else if (results) {
    count.textContent = filtered
      ? `${String(shown.length)} of ${plural(base.length, 'match', 'matches')}`
      : plural(shown.length, 'match', 'matches');
  } else {
    count.textContent = filtered
      ? `${String(shown.length)} of ${String(allSaves.length)} saved`
      : `${String(allSaves.length)} saved`;
  }

  empty.hidden = !loaded || shown.length > 0;
  if (!allSaves.length) setEmpty(onboarding);
  else if (base.length && filtered) {
    setEmpty('No saves match these filters.', {
      label: 'Clear filters',
      run: () => {
        filterBar?.clear();
      },
    });
  } else if (similar) {
    setEmpty('Nothing similar yet.', { label: 'Back to everything', run: exitSimilar });
  } else if (results) {
    setEmpty(
      `No matches for “${search.activeQuery}”. Try describing it another way: the layout, colours, type or kind of site.`,
    );
  } else setEmpty('');
}

const search = new SearchController(
  {
    showResults(next, replacing) {
      if (replacing) {
        // Ranked results replace the quick ones in place, with a short fade instead of a jump.
        wallEl.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
      }
      results = next;
      render();
    },
    setStatus(text) {
      if (searchStatus) searchStatus.textContent = text;
    },
  },
  (query) => sendToWorker<SearchResults | null>({ type: 'search', query }),
  undefined,
  (id) => sendToWorker<string[] | null>({ type: 'similar', id }),
);

function exitSimilar(): void {
  search.showSimilar(null);
  searchInput?.focus();
}
document.querySelector('.similar-exit')?.addEventListener('click', exitSimilar);

const filtersEl = document.querySelector<HTMLElement>('.filters');
const filterBar = filtersEl
  ? new FilterBar(filtersEl, (next) => {
      filters = next;
      window.scrollTo({ top: 0 });
      render();
    })
  : null;

// ---- Density: cards per row, remembered on this computer ----------------------------------

const DENSITY_KEY = 'visual-memory:density';

function storedDensity(): Density {
  try {
    const value = Number(localStorage.getItem(DENSITY_KEY));
    return (DENSITIES as number[]).includes(value) ? (value as Density) : null;
  } catch {
    return null;
  }
}

const densityEl = document.querySelector<HTMLElement>('.density');
function setDensity(density: Density): void {
  wall.setDensity(density);
  try {
    if (density === null) localStorage.removeItem(DENSITY_KEY);
    else localStorage.setItem(DENSITY_KEY, String(density));
  } catch {
    // Not remembered; it still applies to this tab.
  }
  for (const button of densityEl?.querySelectorAll<HTMLButtonElement>('button') ?? []) {
    button.setAttribute('aria-pressed', String(button.dataset.density === String(density)));
  }
}
if (densityEl) {
  const options: [Density, string, string][] = [
    [null, 'Auto', 'Fit the window'],
    ...DENSITIES.map((n): [Density, string, string] => [n, String(n), `${String(n)} per row`]),
  ];
  for (const [density, label, title] of options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'density-button';
    button.textContent = label;
    button.title = title;
    button.dataset.density = String(density);
    button.addEventListener('click', () => {
      setDensity(density);
    });
    densityEl.append(button);
  }
}
setDensity(storedDensity());

let lastQuery = '';
searchInput?.addEventListener('input', () => {
  // A new query starts at the top of the results.
  if (searchInput.value.trim() !== lastQuery) window.scrollTo({ top: 0 });
  lastQuery = searchInput.value.trim();
  search.setQuery(searchInput.value);
});
searchInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    search.submit();
  } else if (event.key === 'Escape' && searchInput.value) {
    event.preventDefault();
    searchInput.value = '';
    lastQuery = '';
    search.setQuery('');
  } else if (event.key === 'Escape' && search.similarTo) {
    event.preventDefault();
    exitSimilar();
  }
});

const accountTrigger = document.querySelector<HTMLButtonElement>('.account-trigger');
const accountPanel = document.querySelector<HTMLElement>('.account');
const syncStatus = document.querySelector<HTMLElement>('.sync-status');
if (accountTrigger && accountPanel && syncStatus) {
  new AccountPanel(accountTrigger, accountPanel, syncStatus, (status) => {
    wall.setSignedIn(status.email !== null);
  });
}

const exportTrigger = document.querySelector<HTMLButtonElement>('.export-trigger');
exportTrigger?.addEventListener('click', () => {
  void (async () => {
    exportTrigger.disabled = true;
    exportTrigger.textContent = 'Preparing export…';
    showNotice(null);
    try {
      // Full images of saves synced from another computer may not be downloaded yet.
      await sendToWorker({ type: 'download-missing-images' }).catch(() => undefined);
      // Loaded on demand so the zip code doesn't slow down opening a new tab.
      const { buildExport, exportFileName } = await import('@/src/newtab/export');
      const blob = await buildExport();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = exportFileName();
      link.click();
      setTimeout(() => {
        URL.revokeObjectURL(link.href);
      }, 60_000);
    } catch (error) {
      console.error('[export] failed', error);
      showNotice(
        `Export failed: ${error instanceof Error ? error.message : String(error)}. Your saves are untouched; try again.`,
      );
    } finally {
      exportTrigger.disabled = false;
      exportTrigger.textContent = 'Export';
    }
  })();
});

const helpTrigger = document.querySelector<HTMLButtonElement>('.help-trigger');
const helpPanel = document.querySelector<HTMLElement>('.help');
if (helpTrigger && helpPanel) new HelpPanel(helpTrigger, helpPanel);

async function emptyMessage(): Promise<string> {
  const { save, close } = await currentShortcuts();
  const keys = [save && `${save} to save a page`, close && `${close} to save and close it`].filter(
    Boolean,
  );
  return keys.length
    ? `Nothing saved yet. Press ${keys.join(', or ')}. You can also click the toolbar button, or import all your open tabs.`
    : 'Nothing saved yet. Click the toolbar button on any site to save it.';
}

async function load(): Promise<void> {
  let saves: SaveRecord[];
  try {
    saves = await listSaves();
  } catch (error) {
    console.error('[newtab] could not read saves', error);
    showNotice(
      `Couldn't open your saves on this computer: ${error instanceof Error ? error.message : String(error)}. Nothing has been deleted. Reload this tab to try again; if it keeps happening, check that your disk isn't full.`,
    );
    return;
  }
  allSaves = saves;
  if (!saves.length && !onboarding) onboarding = await emptyMessage();
  loaded = true;
  filterBar?.setSaves(saves);
  search.setSaves(saves);
  performance.mark('wall-rendered');
  // Keep an open detail view in sync with the record it shows.
  const openId = detail.openId;
  if (openId) {
    const current = saves.find((s) => s.id === openId);
    if (!current) detail.close();
  }
}

let reloadQueued = false;
subscribe(() => {
  if (reloadQueued) return;
  reloadQueued = true;
  queueMicrotask(() => {
    reloadQueued = false;
    void load();
  });
});

document.addEventListener('keydown', (event) => {
  if (detail.isOpen || event.altKey || event.ctrlKey || event.metaKey) return;
  if (searchInput && event.target === searchInput) {
    // Arrow down leaves the search box for the results; with nothing typed, any arrow does.
    if (event.key === 'ArrowDown' || (!searchInput.value && NAV_KEYS.has(event.key))) {
      event.preventDefault();
      wall.focusFirstIfNone();
    }
    return;
  }
  if (
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLSelectElement ||
    event.target instanceof HTMLTextAreaElement
  ) {
    return;
  }
  if (event.key === 'Escape' && search.similarTo) {
    event.preventDefault();
    exitSimilar();
    return;
  }
  if (event.key === '/' && searchInput) {
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
    return;
  }
  if (NAV_KEYS.has(event.key)) {
    event.preventDefault();
    if (wall.focusFirstIfNone()) return;
    wall.navigate(event.key as NavKey);
  }
});

void load();
