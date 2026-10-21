import type { Fingerprint, Understanding } from './types';

/** A row of public.saves as the client reads it (see supabase/migrations). */
export interface RemoteSave {
  id: string;
  dedupe_key: string;
  url: string;
  canonical_url: string | null;
  title: string;
  site_name: string;
  favicon_url: string | null;
  created_at: string;
  captured_at: string;
  updated_at: string;
  deleted_at: string | null;
  image_full_path: string | null;
  image_card_path: string | null;
  width: number | null;
  height: number | null;
  fingerprint: Fingerprint | null;
  palette: string[];
  fonts: string[];
  note: string | null;
  status: Understanding['status'];
  error: string | null;
  description: string | null;
  recall_phrases: string[] | null;
  tags: string[] | null;
}

/** Every column the client needs; leaves out the embedding and the processing queue. */
export const REMOTE_COLUMNS =
  'id,dedupe_key,url,canonical_url,title,site_name,favicon_url,created_at,captured_at,' +
  'updated_at,deleted_at,image_full_path,image_card_path,width,height,fingerprint,palette,' +
  'fonts,note,status,error,description,recall_phrases,tags';

export function understandingOf(row: RemoteSave): Understanding {
  return {
    status: row.status,
    error: row.error,
    description: row.description,
    recallPhrases: row.recall_phrases ?? [],
    tags: row.tags ?? [],
  };
}

export function sameUnderstanding(a: Understanding | undefined, b: Understanding): boolean {
  return (
    a?.status === b.status &&
    a.error === b.error &&
    a.description === b.description &&
    a.recallPhrases.join('\n') === b.recallPhrases.join('\n') &&
    a.tags.join('\n') === b.tags.join('\n')
  );
}

/** What public.upsert_save returns. */
export interface UpsertResult {
  row: RemoteSave;
  /** True when the uploaded snapshot is the one now stored. */
  applied: boolean;
  /** True when the save was deleted (on any device) after this snapshot was taken. */
  deleted: boolean;
  /** Images of the previous snapshot, to remove from storage. */
  replaced_paths: string[];
}

export const SCREENSHOT_BUCKET = 'screenshots';

export function imagePath(
  userId: string,
  saveId: string,
  capturedAt: number,
  variant: 'full' | 'card',
): string {
  // The capture time keeps each snapshot's files apart, so a re-save never overwrites an
  // image another device may still be downloading.
  return `${userId}/${saveId}/${String(capturedAt)}-${variant}.webp`;
}
