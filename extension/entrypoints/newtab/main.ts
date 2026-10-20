import { listSaves } from '@/src/lib/db';
import { subscribe, type WorkerMessage } from '@/src/lib/events';
import type { SaveRecord } from '@/src/lib/types';
import { Detail } from '@/src/newtab/detail';
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
const count = countEl;

function retry(save: SaveRecord): void {
  void browser.runtime.sendMessage({ type: 'retry', id: save.id } satisfies WorkerMessage);
}

const detail = new Detail({ onRetry: retry });
const wall = new Wall(wallEl, {
  onOpen: (save) => {
    void detail.show(save);
  },
  onRetry: retry,
});

async function emptyMessage(): Promise<string> {
  const commands = await browser.commands.getAll();
  const save = commands.find((c) => c.name === 'save-page')?.shortcut;
  const close = commands.find((c) => c.name === 'save-and-close')?.shortcut;
  const keys = [save && `${save} to save a page`, close && `${close} to save and close it`].filter(
    Boolean,
  );
  return keys.length
    ? `Nothing saved yet. Press ${keys.join(', or ')}. You can also click the toolbar button.`
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
