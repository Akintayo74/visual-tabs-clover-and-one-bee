import type { Browser } from 'wxt/browser';
import { processSave, resumeProcessing, saveTab } from '@/src/background/save';
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
    void saveTab(tab, { close: false });
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

  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.id !== browser.runtime.id) return;
    const msg = message as Partial<WorkerMessage> | null;
    if (msg?.type === 'retry' && typeof msg.id === 'string') void processSave(msg.id);
  });

  void resumeProcessing();

  if (import.meta.env.MODE === 'e2e') {
    Object.assign(globalThis, { __visualMemory: { saveTab } });
  }
});
