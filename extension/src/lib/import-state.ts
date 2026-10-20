/** State of an "Import my open tabs" run, shared by the service worker and the new tab. */
export type ImportItemStatus = 'pending' | 'saved' | 'skipped' | 'failed';

export interface ImportItem {
  tabId: number;
  url: string;
  title: string;
  status: ImportItemStatus;
  /** Why the tab was skipped or failed. */
  reason: string | null;
  saveId: string | null;
}

export type ImportPhase = 'running' | 'cancelling' | 'done' | 'cancelled' | 'interrupted';

export interface ImportState {
  windowId: number;
  /** The tab the import was started from; it is reactivated at the end. */
  originalTabId: number;
  startedAt: number;
  finishedAt: number | null;
  phase: ImportPhase;
  items: ImportItem[];
  closedTabs?: number;
  keptTabs?: number;
}

export function summarize(state: ImportState) {
  const count = (status: ImportItemStatus) =>
    state.items.filter((item) => item.status === status).length;
  const saved = count('saved');
  const skipped = count('skipped');
  const failed = count('failed');
  return {
    total: state.items.length,
    done: saved + skipped + failed,
    saved,
    skipped,
    failed,
  };
}

const CHANNEL = 'visual-memory:import';

export function publishImport(state: ImportState | null): void {
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage(state);
  channel.close();
}

export function subscribeImport(listener: (state: ImportState | null) => void): () => void {
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (message: MessageEvent<ImportState | null>) => {
    listener(message.data);
  };
  return () => {
    channel.close();
  };
}

/** Messages from extension pages to the service worker about imports. */
export type ImportMessage =
  | { type: 'import-start'; windowId: number; originalTabId: number }
  | { type: 'import-status' }
  | { type: 'import-resume' }
  | { type: 'import-cancel' }
  | { type: 'import-close-saved' }
  | { type: 'import-dismiss' };
