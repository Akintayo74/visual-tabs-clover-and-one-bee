import { FunctionsHttpError } from '@supabase/supabase-js';
import { hasUnprocessedSaves, storeUnderstanding } from '@/src/lib/db';
import { publish } from '@/src/lib/events';
import type { SaveRecord } from '@/src/lib/types';
import { isNetworkError, supabase, syncConfigured } from './supabase';
import { requestSync } from './sync';

/**
 * Asks the server to describe uploaded saves (the `process-save` Edge Function). The server
 * owns the queue and its retries; this only keeps calling while saves are due, and wakes up
 * again when the next retry is due. Results arrive through the normal sync pull.
 */
export const PROCESS_ALARM = 'process-retry';
/** Each call describes a few saves; this bounds one run (an import of 50 tabs is ~17 calls). */
const MAX_CALLS = 30;
const MIN_WAIT_MS = 60_000;
/** When the server isn't set up for processing yet, check back this often. */
const NOT_SET_UP_WAIT_MS = 60 * 60_000;

interface ProcessResponse {
  outcomes: { id: string; result: string }[];
  waiting: number;
  nextDue: string | null;
}

let running: Promise<void> | null = null;
let again = false;
// requestProcessing sets the flag while run awaits; a function keeps TypeScript from narrowing it.
const runAgain = (): boolean => again;

/** Runs now, or straight after the run in progress. Never rejects. */
export function requestProcessing(): Promise<void> {
  if (!syncConfigured) return Promise.resolve();
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      await run().catch((error: unknown) => {
        console.warn('[understand] failed', error);
      });
    } while (runAgain());
  })().finally(() => {
    running = null;
  });
  return running;
}

async function wakeAt(at: number | null): Promise<void> {
  await browser.alarms.clear(PROCESS_ALARM);
  if (at !== null) {
    await browser.alarms.create(PROCESS_ALARM, { when: Math.max(at, Date.now() + MIN_WAIT_MS) });
  }
}

async function run(): Promise<void> {
  const { data: session } = await supabase().auth.getSession();
  if (!session.session || !(await hasUnprocessedSaves())) {
    await wakeAt(null);
    return;
  }
  for (let call = 0; call < MAX_CALLS; call++) {
    const { data, error } = (await supabase().functions.invoke<ProcessResponse>('process-save', {
      body: {},
    })) as { data: ProcessResponse | null; error: unknown };
    if (error || !data) {
      const status = error instanceof FunctionsHttpError ? (error.context as Response).status : 0;
      if (status === 503) {
        // Model keys aren't configured on the server yet; saves keep waiting, untouched.
        await wakeAt(Date.now() + NOT_SET_UP_WAIT_MS);
        return;
      }
      if (!isNetworkError(error)) console.warn('[understand] process-save failed', error);
      await wakeAt(Date.now() + MIN_WAIT_MS);
      return;
    }
    // Pull the new descriptions so cards and search update as they're written.
    if (data.outcomes.length) void requestSync();
    if (!data.waiting) {
      await wakeAt(null);
      return;
    }
    if (!data.outcomes.length) {
      // What's left is waiting for a retry, or another device is describing it.
      await wakeAt(data.nextDue ? Date.parse(data.nextDue) : Date.now() + MIN_WAIT_MS);
      return;
    }
  }
  await wakeAt(Date.now() + MIN_WAIT_MS);
}

/** Retry on a save the server couldn't describe. */
export async function retryUnderstanding(save: SaveRecord): Promise<void> {
  const { error } = await supabase().rpc('retry_save', { save_id: save.id });
  if (error) throw new Error(error.message);
  if (save.understanding) {
    await storeUnderstanding(save.id, { ...save.understanding, status: 'pending', error: null });
    publish({ type: 'changed', id: save.id });
  }
  void requestProcessing();
}
