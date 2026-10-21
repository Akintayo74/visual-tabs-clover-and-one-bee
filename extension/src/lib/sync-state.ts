/** Backup state, shown at the top of the new tab. */
export interface SyncStatus {
  /** False when this build has no Supabase project configured. */
  configured: boolean;
  email: string | null;
  phase: 'signed-out' | 'syncing' | 'idle' | 'offline' | 'error';
  /** Saves whose current snapshot isn't uploaded yet. */
  pendingUploads: number;
  pendingDeletions: number;
  lastSyncedAt: number | null;
  error: string | null;
}

export type SyncMessage =
  | { type: 'sync-status' }
  | { type: 'sync-now' }
  | { type: 'auth-send-code'; email: string }
  | { type: 'auth-verify'; email: string; code: string }
  | { type: 'auth-sign-out' }
  /** Downloads any full images not on this device yet, so an export has everything. */
  | { type: 'download-missing-images' };

const CHANNEL = 'visual-memory:sync';

export function publishSync(status: SyncStatus): void {
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage(status);
  channel.close();
}

export function subscribeSync(listener: (status: SyncStatus) => void): () => void {
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (message: MessageEvent<SyncStatus>) => {
    listener(message.data);
  };
  return () => {
    channel.close();
  };
}

/** Wait before retry number `attempts` (1-based): 5s, 10s, 20s… up to 15 minutes, ±20%. */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 15 * 60_000);
  return Math.round(base * (0.8 + random() * 0.4));
}
