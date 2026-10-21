import type Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, embedSave, ModelError, type VoyageOptions } from './models.ts';
import { PROMPT_VERSION, searchText } from './prompt.ts';

export const SCREENSHOT_BUCKET = 'screenshots';
/** After this many tries a save is marked failed and waits for the user's Retry. */
export const MAX_ATTEMPTS = 6;

/** A row handed out by public.claim_saves. */
export interface ClaimedSave {
  id: string;
  user_id: string;
  claim_id: string;
  attempts: number;
  url: string;
  title: string;
  site_name: string;
  image_full_path: string | null;
  fingerprint: unknown;
  captured_at: string;
}

export interface ProcessDeps {
  /** A client with the secret key: the queue functions and storage reads need it. */
  admin: SupabaseClient;
  anthropic: Pick<Anthropic, 'beta'>;
  voyage: VoyageOptions;
  now?: () => number;
}

export type Outcome =
  | { id: string; result: 'ready' }
  | { id: string; result: 'retrying'; error: string; retryAt: string }
  | { id: string; result: 'failed'; error: string }
  /** A newer snapshot or a delete arrived while this one was being described. */
  | { id: string; result: 'superseded' };

/** Wait before the next try after `attempts` tries: 1 min, 5 min, 30 min, 2 h, 6 h. */
export function retryDelayMs(attempts: number): number {
  const steps = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
  return steps[Math.min(Math.max(attempts, 1), steps.length) - 1] ?? 6 * 3_600_000;
}

/** Base64 without blowing the call stack on large images. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function mediaTypeOf(path: string): 'image/webp' | 'image/png' | 'image/jpeg' {
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  return 'image/webp';
}

export async function claim(
  admin: SupabaseClient,
  options: { userId: string | null; saveId: string | null; max: number },
): Promise<ClaimedSave[]> {
  const { data, error } = await admin.rpc('claim_saves', {
    for_user: options.userId,
    only_save: options.saveId,
    max_count: options.max,
  });
  if (error) throw new Error(`Couldn't claim saves: ${error.message}`);
  return (data ?? []) as ClaimedSave[];
}

export async function backlog(
  admin: SupabaseClient,
  userId: string | null,
): Promise<{ waiting: number; nextDue: string | null }> {
  const { data, error } = await admin.rpc('processing_backlog', { for_user: userId });
  if (error) throw new Error(`Couldn't read the queue: ${error.message}`);
  const row = (data as { waiting: number; next_due: string | null }[] | null)?.[0];
  return { waiting: row?.waiting ?? 0, nextDue: row?.next_due ?? null };
}

/**
 * Describes and embeds one claimed save and writes the result back. Never throws: every
 * failure ends as a retry (with backoff) or, after MAX_ATTEMPTS or an unfixable error, as
 * 'failed' with the reason. Safe to run twice for the same save; only the current claim
 * can write.
 */
export async function processClaimed(deps: ProcessDeps, save: ClaimedSave): Promise<Outcome> {
  const now = deps.now ?? Date.now;
  try {
    if (!save.image_full_path) throw new ModelError('This save has no screenshot.', false);
    const download = await deps.admin.storage
      .from(SCREENSHOT_BUCKET)
      .download(save.image_full_path);
    if (download.error) {
      // A missing file won't appear by waiting, but storage can also fail briefly.
      const missing = /not found|404/i.test(download.error.message);
      throw new ModelError(
        missing ? 'The screenshot is missing from storage.' : `Storage: ${download.error.message}`,
        !missing,
      );
    }
    const imageBase64 = toBase64(new Uint8Array(await download.data.arrayBuffer()));
    const mediaType = mediaTypeOf(save.image_full_path);

    const understanding = await describe(deps.anthropic, {
      url: save.url,
      title: save.title,
      siteName: save.site_name,
      fingerprint: save.fingerprint,
      imageBase64,
      mediaType,
    });
    const embedding = await embedSave(deps.voyage, {
      text: searchText({
        title: save.title,
        siteName: save.site_name,
        description: understanding.description,
        recallPhrases: understanding.recallPhrases,
        tags: understanding.tags,
      }),
      imageBase64,
      mediaType,
    });

    const { data, error } = await deps.admin.rpc('complete_save', {
      save_id: save.id,
      claim: save.claim_id,
      new_description: understanding.description,
      new_recall_phrases: understanding.recallPhrases,
      new_tags: understanding.tags,
      new_prompt_version: PROMPT_VERSION,
      new_embedding: JSON.stringify(embedding),
    });
    if (error) throw new ModelError(`Couldn't store the result: ${error.message}`, true);
    return data === true ? { id: save.id, result: 'ready' } : { id: save.id, result: 'superseded' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = !(error instanceof ModelError) || error.retryable;
    const giveUp = !retryable || save.attempts >= MAX_ATTEMPTS;
    const retryAt = giveUp ? null : new Date(now() + retryDelayMs(save.attempts)).toISOString();
    console.error(`[process-save] ${save.id} attempt ${String(save.attempts)}: ${message}`);
    const { data, error: failError } = await deps.admin.rpc('fail_save', {
      save_id: save.id,
      claim: save.claim_id,
      message: message.slice(0, 500),
      retry_at: retryAt,
    });
    // If even that fails, the claim goes stale and the save is picked up again later.
    if (failError)
      console.error(`[process-save] couldn't record the failure: ${failError.message}`);
    if (data === false) return { id: save.id, result: 'superseded' };
    return retryAt
      ? { id: save.id, result: 'retrying', error: message, retryAt }
      : { id: save.id, result: 'failed', error: message };
  }
}
