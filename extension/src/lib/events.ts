import type { ImportMessage } from './import-state';
import type { SearchMessage } from './search';
import type { SyncMessage } from './sync-state';

/** Tells open new tabs that saves changed. Works between the service worker and extension pages. */
const CHANNEL = 'visual-memory:saves';

export type SavesEvent = { type: 'changed'; id: string } | { type: 'deleted'; id: string };

export function publish(event: SavesEvent): void {
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage(event);
  channel.close();
}

export function subscribe(listener: (event: SavesEvent) => void): () => void {
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (message: MessageEvent<SavesEvent>) => {
    listener(message.data);
  };
  return () => {
    channel.close();
  };
}

/** Messages from extension pages to the service worker. */
export type WorkerMessage =
  { type: 'retry'; id: string } | ImportMessage | SyncMessage | SearchMessage;

type Response<T> = { ok: true; result: T } | { ok: false; error: string };

/** Sends a message to the service worker and returns its result, or throws its error. */
export async function sendToWorker<T>(message: WorkerMessage): Promise<T> {
  const response = await browser.runtime.sendMessage<WorkerMessage, Response<T> | undefined>(
    message,
  );
  if (!response) throw new Error('The extension did not respond.');
  if (!response.ok) throw new Error(response.error);
  return response.result;
}
