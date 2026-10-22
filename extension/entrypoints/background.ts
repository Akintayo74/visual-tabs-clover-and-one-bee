import type { Browser } from 'wxt/browser';
import {
  cancelImport,
  closeImportedTabs,
  dismissImport,
  getImportState,
  isImportRunning,
  resumeImport,
  startImport,
} from '@/src/background/import';
import { processSave, resumeProcessing, saveTab } from '@/src/background/save';
import { logSearchClick, searchRemote, similarRemote } from '@/src/background/search';
import { setSimulatedOffline } from '@/src/background/supabase';
import {
  downloadMissingFullImages,
  getSyncStatus,
  isSyncAlarm,
  PULL_ALARM,
  PULL_PERIOD_MINUTES,
  requestSync,
  sendCode,
  signOut,
  verifyCode,
} from '@/src/background/sync';
import { PROCESS_ALARM, requestProcessing, retryUnderstanding } from '@/src/background/understand';
import { getSave } from '@/src/lib/db';
import type { WorkerMessage } from '@/src/lib/events';

const SAVE_AND_CLOSE_MENU = 'save-and-close';

export default defineBackground(() => {
  async function activeTab(): Promise<Browser.tabs.Tab | undefined> {
    const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    return tab;
  }

  browser.commands.onCommand.addListener((command, tab) => {
    void (async () => {
      const target = tab ?? (await activeTab());
      if (!target) return;
      if (command === 'save-page') await saveTab(target, { close: false });
      if (command === 'save-and-close') await saveTab(target, { close: true });
    })();
  });

  browser.action.onClicked.addListener((tab) => {
    // While tabs are being imported, the toolbar button cancels the import.
    if (isImportRunning()) void cancelImport();
    else void saveTab(tab, { close: false });
  });

  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({
      id: SAVE_AND_CLOSE_MENU,
      title: 'Save and close tab',
      contexts: ['action'],
    });
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === SAVE_AND_CLOSE_MENU && tab) void saveTab(tab, { close: true });
  });

  async function handle(msg: WorkerMessage): Promise<unknown> {
    switch (msg.type) {
      case 'retry':
        void processSave(msg.id);
        return null;
      case 'import-start':
        return startImport(msg.windowId, msg.originalTabId);
      case 'import-status':
        return getImportState();
      case 'import-resume':
        return resumeImport();
      case 'import-cancel':
        await cancelImport();
        return getImportState();
      case 'import-close-saved':
        return closeImportedTabs();
      case 'import-dismiss':
        await dismissImport();
        return null;
      case 'sync-status':
        return getSyncStatus();
      case 'sync-now':
        void requestSync();
        return getSyncStatus();
      case 'auth-send-code':
        await sendCode(msg.email);
        return null;
      case 'auth-verify':
        return verifyCode(msg.email, msg.code);
      case 'auth-sign-out':
        return signOut();
      case 'download-missing-images':
        await downloadMissingFullImages();
        return null;
      case 'search':
        return searchRemote(msg.query);
      case 'similar':
        return similarRemote(msg.id);
      case 'search-click':
        await logSearchClick(msg.query, msg.id, msg.rank);
        return null;
      case 'retry-understanding': {
        const save = await getSave(msg.id);
        if (save) await retryUnderstanding(save);
        return null;
      }
    }
  }

  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id) return;
    const msg = message as Partial<WorkerMessage> | null;
    if (typeof msg?.type !== 'string') return;
    handle(msg as WorkerMessage).then(
      (result) => {
        sendResponse({ ok: true, result });
      },
      (error: unknown) => {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      },
    );
    return true; // Keeps the channel open for the async response.
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (isSyncAlarm(alarm.name)) void requestSync();
    if (alarm.name === PROCESS_ALARM) void requestProcessing();
  });
  void browser.alarms.create(PULL_ALARM, { periodInMinutes: PULL_PERIOD_MINUTES });

  void resumeProcessing();
  // Uploads anything saved while offline or while the worker was stopped, and pulls changes.
  void requestSync();
  // Marks an import cut off by a service worker restart as interrupted, so the new tab offers to resume.
  void getImportState();

  if (import.meta.env.MODE === 'e2e') {
    Object.assign(globalThis, {
      __visualMemory: {
        saveTab,
        requestSync,
        requestProcessing,
        setSimulatedOffline,
        getSyncStatus,
      },
    });
  }
});
