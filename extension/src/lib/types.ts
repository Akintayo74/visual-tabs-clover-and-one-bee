/** Structural facts about a page that the screenshot can't show. See PLAN.md "Page fingerprint". */
export interface Fingerprint {
  version: 1;
  url: string;
  canonicalUrl: string | null;
  title: string;
  siteName: string | null;
  faviconUrl: string | null;
  viewport: { width: number; height: number; devicePixelRatio: number };
  /** Document height divided by viewport height. */
  pageHeightViewports: number;
  sectionCount: number;
  hasHeader: boolean;
  hasNav: boolean;
  hasFooter: boolean;
  /** Largest visible text on the page, biggest first. */
  largestText: LargeText[];
  links: { total: number; internal: number; external: number };
  fonts: { headings: string[]; body: string[] };
  /** Hex colours, most prominent first. */
  palette: string[];
  signals: {
    webgl: boolean;
    largeCanvas: boolean;
    videoBackground: boolean;
    scrollAnimation: boolean;
    libraries: string[];
  };
  /** True when the page was too large to inspect every element. */
  truncated: boolean;
}

export interface LargeText {
  text: string;
  fontSize: number;
  isLink: boolean;
  href: string | null;
}

export type SaveStatus = 'processing' | 'ready' | 'failed';

/**
 * One saved site. Kept small so the new tab can load every record at once;
 * the fingerprint and images live in their own stores.
 */
export interface SaveRecord {
  id: string;
  /** Normalised page URL (see dedupeKey). Re-saving the same key replaces the snapshot. */
  dedupeKey: string;
  url: string;
  canonicalUrl: string | null;
  title: string;
  siteName: string;
  faviconUrl: string | null;
  createdAt: number;
  /** When the current snapshot was taken. The wall sorts by this. */
  updatedAt: number;
  status: SaveStatus;
  error: string | null;
  /** Size of the full image (or the raw capture until it is processed). */
  width: number;
  height: number;
  palette: string[];
  fonts: string[];
  note: string | null;
  /** When the note was last edited (ms). Absent for saves whose note was never edited. */
  noteUpdatedAt?: number | null;
  /** True while a note edit made on this device hasn't reached the server. */
  notePending?: boolean;
  /** 'pending' until the current snapshot is uploaded; indexed so the upload queue is cheap to list. */
  syncState: SyncState;
  sync: SyncInfo;
  /** What the model made of the save, from the server. Absent until the save has been uploaded. */
  understanding?: Understanding;
}

/** The server's processing of a save (Phase 4): description, recall phrases and tags. */
export interface Understanding {
  status: 'pending' | 'processing' | 'ready' | 'failed';
  error: string | null;
  description: string | null;
  recallPhrases: string[];
  tags: string[];
}

export type SyncState = 'pending' | 'synced';

export interface SyncInfo {
  /** Failed upload attempts for the current snapshot. */
  attempts: number;
  /** Don't retry before this time (ms). */
  nextAttemptAt: number;
  error: string | null;
  /** What the server holds for this save, once any snapshot of it has been uploaded. */
  remote: RemoteRef | null;
}

export interface RemoteRef {
  /** captured_at of the snapshot stored on the server (ms). */
  capturedAt: number;
  fullPath: string | null;
  cardPath: string | null;
}

/**
 * raw: the capture as taken, kept until the WebP versions exist so a failed
 * or interrupted save can always be retried.
 */
export type ImageVariant = 'raw' | 'full' | 'card';
