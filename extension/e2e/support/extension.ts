import {
  chromium,
  test as base,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import path from 'node:path';
import { startSites, type SiteServer } from './sites';

/** The e2e build: like production, plus standing host access because tests can't press shortcuts. */
export const extensionPath = path.resolve(import.meta.dirname, '../../.output/chrome-mv3-e2e');

export interface SaveResult {
  ok: boolean;
  id?: string;
  reason?: string;
  timings?: Record<string, number>;
}

interface Fixtures {
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
  sites: SiteServer;
  /** Saves the active tab the way the shortcut does and reports when the toast appeared. */
  save: (
    page: Page,
    options?: { close?: boolean },
  ) => Promise<SaveResult & { toastMs: number | null; savedToastMs: number | null }>;
  openWall: () => Promise<Page>;
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    await use(context);
    await context.close();
  },
  worker: async ({ context }, use) => {
    await use(context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker')));
  },
  extensionId: async ({ worker }, use) => {
    await use(new URL(worker.url()).host);
  },
  // eslint-disable-next-line no-empty-pattern
  sites: async ({}, use) => {
    const sites = await startSites();
    await use(sites);
    await sites.close();
  },
  save: async ({ worker }, use) => {
    await use(async (page, options = {}) => {
      await page.bringToFront();
      await page
        .evaluate(() => {
          const w = window as unknown as { __toast: { appear?: number; saved?: number } };
          w.__toast = {};
          new MutationObserver(() => {
            const host = document.getElementById('visual-memory-toast');
            if (host && !w.__toast.appear) w.__toast.appear = Date.now();
            if (host?.dataset.state === 'saved' && !w.__toast.saved) w.__toast.saved = Date.now();
          }).observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
          });
        })
        .catch(() => undefined);
      const start = Date.now();
      const result = await worker.evaluate(async (close) => {
        const api = (globalThis as unknown as { chrome: typeof browser }).chrome;
        const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
        const hook = (
          globalThis as unknown as {
            __visualMemory: {
              saveTab: (tab: unknown, options: { close: boolean }) => Promise<SaveResult>;
            };
          }
        ).__visualMemory;
        return hook.saveTab(tab, { close });
      }, options.close ?? false);
      let toastMs: number | null = null;
      let savedToastMs: number | null = null;
      if (!options.close && !page.isClosed()) {
        const times = await page
          .evaluate(
            () => (window as unknown as { __toast?: { appear?: number; saved?: number } }).__toast,
          )
          .catch(() => undefined);
        toastMs = times?.appear ? times.appear - start : null;
        savedToastMs = times?.saved ? times.saved - start : null;
      }
      return { ...result, toastMs, savedToastMs };
    });
  },
  openWall: async ({ context, extensionId }, use) => {
    await use(async () => {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/newtab.html`);
      // The browser opens with a blank tab; close it so imports see only the tabs a test opens.
      for (const other of context.pages()) {
        if (other !== page && other.url() === 'about:blank') await other.close();
      }
      return page;
    });
  },
});

/** Status of every save, read straight from IndexedDB (the wall only renders visible cards). */
export function statuses(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('visual-memory');
        open.onerror = () => {
          reject(new Error('could not open the database'));
        };
        open.onsuccess = () => {
          const request = open.result.transaction('saves').objectStore('saves').getAll();
          request.onsuccess = () => {
            resolve((request.result as { status: string }[]).map((s) => s.status));
            open.result.close();
          };
        };
      }),
  );
}

export { expect } from '@playwright/test';
