import type { Browser } from 'wxt/browser';
import {
  type ImportItem,
  type ImportState,
  publishImport,
  summarize,
} from '@/src/lib/import-state';
import { normalizeUrl, unsupportedReason } from '@/src/lib/url';
import { saveTab } from './save';

/** How long to wait for a tab to finish loading before capturing it anyway. */
const LOAD_TIMEOUT_MS = 20_000;
/** Time after load for fonts, images and intro animations to settle. */
const SETTLE_MS = 1500;
const STORAGE_KEY = 'import';

let state: ImportState | null = null;
let running = false;
let cancelRequested = false;
// cancelImport sets the flag while run() awaits; a function keeps TypeScript from narrowing it.
const isCancelled = (): boolean => cancelRequested;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function persist(next: ImportState): Promise<void> {
  state = next;
  publishImport(next);
  await setProgressBadge(next);
  try {
    // Session storage survives the service worker restarting, so an interrupted import can resume.
    await browser.storage.session.set({ [STORAGE_KEY]: next });
  } catch (error) {
    console.warn('[import] could not persist progress', error);
  }
}

async function setProgressBadge(current: ImportState): Promise<void> {
  try {
    if (current.phase === 'running' || current.phase === 'cancelling') {
      const { done, total } = summarize(current);
      await browser.action.setBadgeBackgroundColor({ color: '#2f6fed' });
      await browser.action.setBadgeText({ text: `${String(done)}/${String(total)}` });
      await browser.action.setTitle({
        title: `Importing tab ${String(done + 1)} of ${String(total)}. Click to cancel.`,
      });
    } else {
      await browser.action.setBadgeText({ text: '' });
      await browser.action.setTitle({ title: 'Save this page' });
    }
  } catch (error) {
    console.warn('[import] could not update the badge', error);
  }
}

/** The current import, from memory or, after a service worker restart, from session storage. */
export async function getImportState(): Promise<ImportState | null> {
  if (state) return state;
  try {
    const stored = (await browser.storage.session.get(STORAGE_KEY))[STORAGE_KEY] as
      ImportState | undefined;
    state = stored ?? null;
  } catch {
    state = null;
  }
  // A stored "running" import whose loop isn't running here was cut off by a restart.
  if (state && !running && (state.phase === 'running' || state.phase === 'cancelling')) {
    await persist({ ...state, phase: 'interrupted' });
  }
  return state;
}

export function isImportRunning(): boolean {
  return running;
}

function waitForLoad(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(listener);
      browser.tabs.onRemoved.removeListener(onRemoved);
      resolve();
    };
    const listener = (id: number, change: Browser.tabs.OnUpdatedInfo) => {
      if (id === tabId && change.status === 'complete') finish();
    };
    const onRemoved = (id: number) => {
      if (id === tabId) finish();
    };
    const timer = setTimeout(finish, LOAD_TIMEOUT_MS);
    browser.tabs.onUpdated.addListener(listener);
    browser.tabs.onRemoved.addListener(onRemoved);
    // The tab may have finished loading before the listener was added.
    void browser.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === 'complete' && !tab.discarded) finish();
      })
      .catch(finish);
  });
}

async function importOne(item: ImportItem): Promise<ImportItem> {
  let tab: Browser.tabs.Tab;
  try {
    tab = await browser.tabs.get(item.tabId);
  } catch {
    return { ...item, status: 'skipped', reason: 'The tab was closed.' };
  }
  const early = unsupportedReason(tab.url || tab.pendingUrl);
  if (early) return { ...item, url: tab.url ?? item.url, status: 'skipped', reason: early };

  // Activating a discarded (memory-saver) tab reloads it; waitForLoad covers that.
  await browser.tabs.update(item.tabId, { active: true });
  await waitForLoad(item.tabId);
  await delay(SETTLE_MS);

  try {
    tab = await browser.tabs.get(item.tabId);
  } catch {
    return { ...item, status: 'skipped', reason: 'The tab was closed.' };
  }
  if (!tab.active) {
    // Something else took focus in this window; capturing now would save the wrong page.
    await browser.tabs.update(item.tabId, { active: true });
    await delay(300);
  }
  const outcome = await saveTab(tab, { close: false, quiet: true });
  return outcome.ok
    ? {
        ...item,
        url: tab.url ?? item.url,
        title: tab.title ?? item.title,
        status: 'saved',
        reason: null,
        saveId: outcome.id,
      }
    : {
        ...item,
        url: tab.url ?? item.url,
        status: unsupportedReason(tab.url) ? 'skipped' : 'failed',
        reason: outcome.reason,
      };
}

async function run(): Promise<void> {
  if (running || !state) return;
  running = true;
  cancelRequested = false;
  try {
    for (let i = 0; i < state.items.length; i++) {
      const item = state.items[i];
      if (item?.status !== 'pending') continue;
      if (isCancelled()) break;
      let result: ImportItem;
      try {
        result = await importOne(item);
      } catch (error) {
        console.error('[import] tab failed', item.url, error);
        result = { ...item, status: 'failed', reason: errorMessage(error) };
      }
      const items = state.items.slice();
      items[i] = result;
      await persist({ ...state, items });
    }
    try {
      await browser.tabs.update(state.originalTabId, { active: true });
    } catch {
      // The tab the import started from was closed; leave the window as it is.
    }
    await persist({
      ...state,
      phase: isCancelled() ? 'cancelled' : 'done',
      finishedAt: Date.now(),
    });
  } finally {
    running = false;
    cancelRequested = false;
  }
}

/**
 * Imports every tab in a window, one at a time: activate it, wait for it to load, capture
 * and save it. Skips pages that can't be saved and returns to `originalTabId` at the end.
 */
export async function startImport(windowId: number, originalTabId: number): Promise<ImportState> {
  const existing = await getImportState();
  if (running && existing) return existing;

  const tabs = await browser.tabs.query({ windowId });
  const items: ImportItem[] = tabs
    .filter((tab) => tab.id !== undefined && tab.id !== originalTabId)
    .map((tab) => {
      // A tab still navigating has no url yet, only pendingUrl; it's checked again on its turn.
      const url = tab.url || tab.pendingUrl || '';
      const reason = url ? unsupportedReason(url) : null;
      return {
        tabId: tab.id ?? -1,
        url,
        title: tab.title ?? '',
        status: reason ? 'skipped' : 'pending',
        reason,
        saveId: null,
      };
    });
  await persist({
    windowId,
    originalTabId,
    startedAt: Date.now(),
    finishedAt: null,
    phase: 'running',
    items,
  });
  const started = state as ImportState;
  void run();
  return started;
}

/** Picks up an interrupted import where it stopped. */
export async function resumeImport(): Promise<ImportState | null> {
  const current = await getImportState();
  if (!current || running || current.phase !== 'interrupted') return current;
  await persist({ ...current, phase: 'running' });
  void run();
  return state;
}

/** Stops after the tab being imported now, then returns to the starting tab. */
export async function cancelImport(): Promise<void> {
  const current = await getImportState();
  if (!current) return;
  if (running) {
    cancelRequested = true;
    await persist({ ...current, phase: 'cancelling' });
  } else if (current.phase === 'interrupted') {
    await persist({ ...current, phase: 'cancelled', finishedAt: Date.now() });
  }
}

/**
 * Closes the tabs that were saved. A tab is left open if it now shows a different page
 * than the one saved, so nothing unsaved is ever closed.
 */
export async function closeImportedTabs(): Promise<{ closed: number; kept: number }> {
  const current = await getImportState();
  if (!current || running) return { closed: 0, kept: 0 };
  const toClose: number[] = [];
  let kept = 0;
  for (const item of current.items) {
    if (item.status !== 'saved' || item.tabId === current.originalTabId) continue;
    try {
      const tab = await browser.tabs.get(item.tabId);
      if (tab.url && normalizeUrl(tab.url) === normalizeUrl(item.url)) toClose.push(item.tabId);
      else kept++;
    } catch {
      // Already closed.
    }
  }
  if (toClose.length) await browser.tabs.remove(toClose);
  await persist({ ...current, closedTabs: toClose.length, keptTabs: kept });
  return { closed: toClose.length, kept };
}

/** Forgets a finished import. */
export async function dismissImport(): Promise<void> {
  if (running) return;
  state = null;
  publishImport(null);
  try {
    await browser.storage.session.remove(STORAGE_KEY);
  } catch {
    // Nothing to forget.
  }
}
