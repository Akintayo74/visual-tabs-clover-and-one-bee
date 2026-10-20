import type { ImportMessage } from './import-state';

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
export type WorkerMessage = { type: 'retry'; id: string } | ImportMessage;
