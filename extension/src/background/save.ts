import type { Browser } from 'wxt/browser';
import { extractFingerprint } from '@/src/fingerprint/extract';
import {
  completeProcessing,
  getImage,
  getSave,
  listSavesWithStatus,
  setStatus,
  upsertSnapshot,
} from '@/src/lib/db';
import { publish } from '@/src/lib/events';
import type { Fingerprint } from '@/src/lib/types';
import { dedupeKey, displayDomain, unsupportedReason } from '@/src/lib/url';
import { imageSize, makeVariants } from './images';
import { renderToast, TOAST_HOST_ID, type ToastState } from './toast';

const FINGERPRINT_TIMEOUT_MS = 2000;
// Injected scripts run on the page's main thread, which a busy page can block for seconds.
const TOAST_TIMEOUT_MS = 1000;
const CAPTURE_RETRY_DELAY_MS = 600;
const CAPTURE_RETRIES = 3;

export type SaveOutcome =
  { ok: true; id: string; timings: Record<string, number> } | { ok: false; reason: string };

class UnsupportedPageError extends Error {}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Chrome allows two captures per second. Spacing them out keeps quick successive saves
// (and Phase 2's tab import) inside the quota; retries cover anything that still collides.
const MIN_CAPTURE_INTERVAL_MS = 550;
let nextCaptureAt = 0;

async function capture(windowId: number): Promise<string> {
  const options = { format: 'jpeg', quality: 92 } as const;
  for (let attempt = 0; ; attempt++) {
    const wait = nextCaptureAt - Date.now();
    nextCaptureAt = Math.max(nextCaptureAt, Date.now()) + MIN_CAPTURE_INTERVAL_MS;
    if (wait > 0) await delay(wait);
    try {
      return await browser.tabs.captureVisibleTab(windowId, options);
    } catch (error) {
      const quota = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(errorMessage(error));
      if (!quota || attempt >= CAPTURE_RETRIES) throw error;
      await delay(CAPTURE_RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

async function fingerprint(tabId: number): Promise<Fingerprint | null> {
  const injection = browser.scripting
    .executeScript({
      target: { tabId },
      world: 'MAIN',
      func: extractFingerprint,
      args: [`#${TOAST_HOST_ID}`],
    })
    .then((results) => results[0]?.result ?? null)
    .catch((error: unknown) => {
      // Chrome refuses to script PDFs, other extensions' pages and other protected pages.
      throw new UnsupportedPageError(errorMessage(error));
    });
  const timeout = delay(FINGERPRINT_TIMEOUT_MS).then(() => null);
  return Promise.race([injection, timeout]);
}

/** Never waits longer than TOAST_TIMEOUT_MS, so a busy page can't hold up a save. */
async function toast(tabId: number, state: ToastState, message: string): Promise<void> {
  const injection = browser.scripting
    .executeScript({
      target: { tabId },
      func: renderToast,
      args: [TOAST_HOST_ID, state, message],
    })
    .then(() => undefined)
    .catch(() => {
      // The toast is a courtesy; the badge and notifications still report the outcome.
    });
  await Promise.race([injection, delay(TOAST_TIMEOUT_MS)]);
}

let badgeTimer: ReturnType<typeof setTimeout> | undefined;

/** Shows `text` on the toolbar icon. Unlike the toast, this doesn't depend on the page. */
async function flashBadge(text: string, color: string, { sticky = false } = {}): Promise<void> {
  clearTimeout(badgeTimer);
  try {
    await browser.action.setBadgeBackgroundColor({ color });
    await browser.action.setBadgeText({ text });
    if (!sticky) {
      badgeTimer = setTimeout(() => {
        void browser.action.setBadgeText({ text: '' });
      }, 2500);
    }
  } catch (error) {
    console.warn('[save] could not set the badge', error);
  }
}

async function notifyFailure(title: string, message: string): Promise<void> {
  await flashBadge('!', '#d93025');
  try {
    await browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('/icon/128.png'),
      title,
      message,
    });
  } catch (error) {
    console.warn('[save] could not show a notification', error);
  }
}

/**
 * Saves a tab: captures the visible viewport, reads the page fingerprint, writes everything
 * to IndexedDB, then shows feedback. Image processing continues afterwards. With
 * `close`, the tab closes only once the save is safely stored.
 */
export async function saveTab(
  tab: Browser.tabs.Tab,
  { close }: { close: boolean },
): Promise<SaveOutcome> {
  const start = performance.now();
  const timings: Record<string, number> = {};
  const mark = (name: string) => (timings[name] = Math.round(performance.now() - start));

  const reason = unsupportedReason(tab.url);
  if (reason || tab.id === undefined || !tab.url) {
    const why = reason ?? "Browser pages can't be saved.";
    await notifyFailure("Can't save this page", why);
    return { ok: false, reason: why };
  }
  const tabId = tab.id;
  const url = tab.url;

  try {
    const dataUrl = await capture(tab.windowId);
    mark('captured');

    // Feedback goes up only after the capture so it never appears in the screenshot. The
    // badge is immediate; the toast needs the page's main thread, so the save never waits on it.
    void flashBadge('…', '#5f6368', { sticky: true });
    void toast(tabId, 'saving', 'Saving…');
    const [fp, raw] = await Promise.all([
      fingerprint(tabId),
      fetch(dataUrl).then((response) => response.blob()),
    ]);
    mark('fingerprinted');
    const size = await imageSize(raw);

    const canonicalUrl = fp?.canonicalUrl ?? null;
    const record = await upsertSnapshot({
      dedupeKey: dedupeKey(url, canonicalUrl),
      url,
      canonicalUrl,
      title: fp?.title || tab.title || displayDomain(url),
      siteName: fp?.siteName || fp?.title || tab.title || displayDomain(url),
      faviconUrl: tab.favIconUrl ?? fp?.faviconUrl ?? null,
      width: size.width,
      height: size.height,
      palette: fp?.palette ?? [],
      fonts: fp ? [...new Set([...fp.fonts.headings, ...fp.fonts.body])] : [],
      fingerprint: fp,
      raw,
      now: Date.now(),
    });
    mark('stored');
    publish({ type: 'changed', id: record.id });

    void processSave(record.id);
    // The save is stored. From here, a failure only affects feedback, never the save.
    try {
      void flashBadge('✓', '#188038');
      if (close) await browser.tabs.remove(tabId);
      else await toast(tabId, 'saved', 'Saved');
    } catch (error) {
      console.warn('[save] stored, but feedback or closing the tab failed', error);
    }
    mark('feedback');
    console.info('[save]', url, timings);
    return { ok: true, id: record.id, timings };
  } catch (error) {
    if (error instanceof UnsupportedPageError) {
      const why = "This page can't be saved. PDFs and protected pages aren't supported.";
      await notifyFailure("Can't save this page", why);
      return { ok: false, reason: why };
    }
    const why = errorMessage(error);
    console.error('[save] failed', url, error);
    await toast(tabId, 'error', `Couldn't save: ${why}`);
    await notifyFailure("Couldn't save this page", why);
    return { ok: false, reason: why };
  }
}

const inFlight = new Map<string, Promise<void>>();

/** Turns the raw capture into the stored WebP versions. Safe to call repeatedly. */
export function processSave(id: string): Promise<void> {
  const running = inFlight.get(id);
  if (running) return running;
  const job = runProcessing(id).finally(() => inFlight.delete(id));
  inFlight.set(id, job);
  return job;
}

async function runProcessing(id: string): Promise<void> {
  const record = await getSave(id);
  if (!record) return;
  try {
    const raw = await getImage(id, 'raw');
    if (!raw) {
      if (await getImage(id, 'card')) {
        await setStatus(id, 'ready');
        publish({ type: 'changed', id });
        return;
      }
      throw new Error('The capture is missing; save the page again.');
    }
    const variants = await makeVariants(raw);
    if (!(await completeProcessing(id, record.updatedAt, variants))) {
      // Re-saved while this ran: process the newer capture instead.
      const latest = await getSave(id);
      if (latest?.status === 'processing' && latest.updatedAt !== record.updatedAt) {
        await runProcessing(id);
        return;
      }
    }
  } catch (error) {
    console.error('[process] failed', id, error);
    await setStatus(id, 'failed', errorMessage(error));
  }
  publish({ type: 'changed', id });
}

/** Finishes saves interrupted by the service worker stopping. */
export async function resumeProcessing(): Promise<void> {
  for (const record of await listSavesWithStatus('processing')) {
    await processSave(record.id);
  }
}
