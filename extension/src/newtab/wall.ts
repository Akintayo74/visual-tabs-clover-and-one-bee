import { getDisplayImage } from '@/src/lib/db';
import type { SaveRecord } from '@/src/lib/types';
import { displayDomain } from '@/src/lib/url';
import {
  columnsForWidth,
  computeLayout,
  nextIndex,
  visibleRows,
  type Layout,
  type NavKey,
} from './layout';

const GAP = 24;
const META_HEIGHT = 52;
const MAX_ASPECT = 1.25;
const OVERSCAN_VIEWPORTS = 1;

export interface WallCallbacks {
  onOpen(save: SaveRecord): void;
  onRetry(save: SaveRecord): void;
}

interface Mounted {
  el: HTMLElement;
  /** Changes whenever the card needs redrawing. */
  version: string;
  objectUrl: string | null;
}

export function faviconUrl(pageUrl: string, size = 32): string {
  // Chrome serves cached favicons to extension pages with the "favicon" permission.
  const url = new URL('/_favicon/', location.origin);
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', String(size));
  return url.toString();
}

function versionOf(save: SaveRecord, signedIn: boolean): string {
  const sync = signedIn ? `${save.syncState}:${save.sync.error ?? ''}` : '';
  return `${String(save.updatedAt)}:${save.status}:${sync}`;
}

/** Shown on a card while signed in and its current snapshot isn't uploaded yet. */
export function syncBadge(save: SaveRecord, signedIn: boolean): string | null {
  if (!signedIn || save.syncState !== 'pending' || save.status !== 'ready') return null;
  return save.sync.error ? 'Backup failed, retrying' : 'Waiting to back up';
}

/**
 * The virtualised grid. Only rows near the viewport exist in the DOM, and card images
 * are read from IndexedDB when their card mounts.
 */
export class Wall {
  private saves: SaveRecord[] = [];
  private layout: Layout = { columns: 1, rows: [], totalHeight: 0 };
  private readonly mounted = new Map<string, Mounted>();
  private focusedIndex = -1;
  private frame = 0;
  private signedIn = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly callbacks: WallCallbacks,
  ) {
    window.addEventListener(
      'scroll',
      () => {
        this.schedule();
      },
      { passive: true },
    );
    new ResizeObserver(() => {
      this.relayout();
    }).observe(container);
    container.addEventListener('focusin', (event) => {
      const card = (event.target as HTMLElement).closest<HTMLElement>('[data-index]');
      if (card) this.focusedIndex = Number(card.dataset.index);
    });
  }

  setSaves(saves: SaveRecord[]): void {
    const focusedId = this.saves[this.focusedIndex]?.id;
    this.saves = saves;
    this.focusedIndex = focusedId ? saves.findIndex((s) => s.id === focusedId) : -1;
    const ids = new Set(saves.map((s) => s.id));
    for (const id of [...this.mounted.keys()]) {
      if (!ids.has(id)) this.unmount(id);
    }
    this.relayout();
  }

  /** Cards only show backup state while signed in; signed out, the status line covers it. */
  setSignedIn(signedIn: boolean): void {
    if (signedIn === this.signedIn) return;
    this.signedIn = signedIn;
    this.render();
  }

  get count(): number {
    return this.saves.length;
  }

  /** Moves keyboard focus between cards, scrolling the target into view. */
  navigate(key: NavKey): void {
    const index = nextIndex(this.focusedIndex, key, this.layout.columns, this.saves.length);
    if (index < 0) return;
    this.focusedIndex = index;
    const row = this.layout.rows[Math.floor(index / this.layout.columns)];
    if (row) {
      const rowTop = this.container.offsetTop + row.top;
      if (
        rowTop < window.scrollY + 16 ||
        rowTop + row.height > window.scrollY + window.innerHeight
      ) {
        window.scrollTo({ top: Math.max(0, rowTop - 96) });
      }
    }
    this.render();
    const id = this.saves[index]?.id;
    if (id)
      this.mounted
        .get(id)
        ?.el.querySelector<HTMLElement>('.card-hit')
        ?.focus({ preventScroll: true });
  }

  focusFirstIfNone(): boolean {
    if (this.container.contains(document.activeElement)) return false;
    this.navigate('Home');
    return true;
  }

  private relayout(): void {
    const width = this.container.clientWidth;
    this.layout = computeLayout(
      this.saves.map((s) => ({ aspect: s.width > 0 ? s.height / s.width : 0 })),
      {
        width,
        columns: columnsForWidth(width),
        gap: GAP,
        metaHeight: META_HEIGHT,
        maxAspect: MAX_ASPECT,
      },
    );
    this.container.style.height = `${String(this.layout.totalHeight)}px`;
    this.render();
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render(): void {
    const offset = this.container.offsetTop;
    const { first, last } = visibleRows(
      this.layout,
      window.scrollY - offset,
      window.innerHeight,
      window.innerHeight * OVERSCAN_VIEWPORTS,
    );
    const wanted = new Set<string>();
    const ordered: HTMLElement[] = [];
    for (let r = first; r <= last; r++) {
      for (const box of this.layout.rows[r]?.cards ?? []) {
        const save = this.saves[box.index];
        if (!save) continue;
        wanted.add(save.id);
        let mounted = this.mounted.get(save.id);
        if (mounted?.version !== versionOf(save, this.signedIn)) {
          if (mounted) this.unmount(save.id);
          mounted = this.mount(save);
        }
        const el = mounted.el;
        ordered.push(el);
        el.dataset.index = String(box.index);
        el.style.transform = `translate(${String(box.left)}px, ${String(box.top)}px)`;
        el.style.width = `${String(box.width)}px`;
        el.querySelector<HTMLElement>('.card-image')?.style.setProperty(
          'height',
          `${String(box.imageHeight)}px`,
        );
      }
    }
    for (const id of [...this.mounted.keys()]) {
      if (!wanted.has(id)) this.unmount(id);
    }
    // Keep DOM order equal to grid order so Tab and screen readers follow the wall.
    ordered.forEach((el, i) => {
      if (this.container.children[i] !== el) {
        this.container.insertBefore(el, this.container.children[i] ?? null);
      }
    });
  }

  private mount(save: SaveRecord): Mounted {
    const el = document.createElement('div');
    el.className = `card is-${save.status}`;
    el.dataset.id = save.id;
    el.dataset.testid = 'card';

    const hit = document.createElement('button');
    hit.className = 'card-hit';
    hit.type = 'button';
    hit.setAttribute('aria-label', `${save.title} (${displayDomain(save.url)})`);
    hit.addEventListener('click', () => {
      this.callbacks.onOpen(save);
    });

    const image = document.createElement('div');
    image.className = 'card-image';
    if (save.palette[0]) image.style.backgroundColor = save.palette[0];
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    image.append(img);

    if (save.status !== 'ready') {
      const badge = document.createElement('span');
      badge.className = 'card-status';
      badge.textContent = save.status === 'processing' ? 'Processing…' : 'Failed';
      if (save.error) badge.title = save.error;
      image.append(badge);
    }

    const backup = syncBadge(save, this.signedIn);
    if (backup) {
      const badge = document.createElement('span');
      badge.className = 'card-sync';
      badge.dataset.testid = 'card-sync';
      badge.textContent = backup;
      if (save.sync.error) badge.title = save.sync.error;
      image.append(badge);
    }

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    const icon = document.createElement('img');
    icon.className = 'card-favicon';
    icon.src = faviconUrl(save.url);
    icon.alt = '';
    icon.width = 16;
    icon.height = 16;
    const text = document.createElement('div');
    text.className = 'card-text';
    const site = document.createElement('div');
    site.className = 'card-site';
    site.textContent = save.siteName || save.title;
    const domain = document.createElement('div');
    domain.className = 'card-domain';
    domain.textContent = displayDomain(save.url);
    text.append(site, domain);
    meta.append(icon, text);

    hit.append(image, meta);
    el.append(hit);

    if (save.status === 'failed') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'card-retry';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => {
        this.callbacks.onRetry(save);
      });
      el.append(retry);
    }

    const mounted: Mounted = { el, version: versionOf(save, this.signedIn), objectUrl: null };
    this.mounted.set(save.id, mounted);
    this.container.append(el);

    void getDisplayImage(save.id, 'card').then((blob) => {
      if (!blob || this.mounted.get(save.id) !== mounted) return;
      mounted.objectUrl = URL.createObjectURL(blob);
      img.src = mounted.objectUrl;
    });
    return mounted;
  }

  private unmount(id: string): void {
    const mounted = this.mounted.get(id);
    if (!mounted) return;
    if (mounted.objectUrl) URL.revokeObjectURL(mounted.objectUrl);
    mounted.el.remove();
    this.mounted.delete(id);
  }
}
