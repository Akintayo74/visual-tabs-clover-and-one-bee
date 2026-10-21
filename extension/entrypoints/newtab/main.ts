import { listSaves } from '@/src/lib/db';
import { sendToWorker, subscribe, type WorkerMessage } from '@/src/lib/events';
import type { SaveRecord } from '@/src/lib/types';
import { AccountPanel } from '@/src/newtab/account-panel';
import { Detail } from '@/src/newtab/detail';
import { ImportPanel } from '@/src/newtab/import-panel';
import type { NavKey } from '@/src/newtab/layout';
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
const countEl = document.querySelector<HTMLElement>('.count');
if (!wallEl || !emptyEl || !countEl) throw new Error('new tab markup is missing');
const empty = emptyEl;
const importTrigger = document.querySelector<HTMLButtonElement>('.import-trigger');
const importPanel = document.querySelector<HTMLElement>('.import');
if (importTrigger && importPanel) new ImportPanel(importTrigger, importPanel);
const count = countEl;

function retry(save: SaveRecord): void {
  void browser.runtime.sendMessage({ type: 'retry', id: save.id } satisfies WorkerMessage);
}

const detail = new Detail({
  onRetry: retry,
  onDeleted: () => {
    // Tell the server (and so other devices) about the delete.
    void sendToWorker({ type: 'sync-now' }).catch(() => undefined);
  },
});
const wall = new Wall(wallEl, {
  onOpen: (save) => {
    void detail.show(save);
  },
  onRetry: retry,
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
      alert(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      exportTrigger.disabled = false;
      exportTrigger.textContent = 'Export';
    }
  })();
});

async function emptyMessage(): Promise<string> {
  const commands = await browser.commands.getAll();
  const save = commands.find((c) => c.name === 'save-page')?.shortcut;
  const close = commands.find((c) => c.name === 'save-and-close')?.shortcut;
  const keys = [save && `${save} to save a page`, close && `${close} to save and close it`].filter(
    Boolean,
  );
  return keys.length
    ? `Nothing saved yet. Press ${keys.join(', or ')}. You can also click the toolbar button, or import all your open tabs.`
    : 'Nothing saved yet. Click the toolbar button on any site to save it.';
}

async function load(): Promise<void> {
  const saves = await listSaves();
  wall.setSaves(saves);
  count.textContent = saves.length ? `${String(saves.length)} saved` : '';
  empty.hidden = saves.length > 0;
  if (!saves.length) empty.textContent = await emptyMessage();
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
  if (NAV_KEYS.has(event.key)) {
    event.preventDefault();
    if (wall.focusFirstIfNone()) return;
    wall.navigate(event.key as NavKey);
  }
});

void load();
