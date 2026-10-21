import { expect, type Page, type Worker } from '@playwright/test';

/** The local Supabase stack's test mailbox (Mailpit), started by `supabase start`. */
const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:54324';

export function uniqueEmail(label: string): string {
  return `${label}-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

interface MailpitMessage {
  Created: string;
  Snippet: string;
}

/** Waits for a sign-in email to `email` sent after `since`, and returns its code. */
export async function signInCode(email: string, since: number): Promise<string> {
  let code: string | undefined;
  await expect
    .poll(
      async () => {
        const url = new URL('/api/v1/search', MAILPIT);
        url.searchParams.set('query', `to:"${email}"`);
        const response = await fetch(url);
        const { messages } = (await response.json()) as { messages: MailpitMessage[] };
        // Mailpit stores times to the second; allow for that.
        const fresh = messages.find((m) => Date.parse(m.Created) >= since - 1000);
        code = /\b(\d{6})\b/.exec(fresh?.Snippet ?? '')?.[1];
        return code;
      },
      { timeout: 15_000, message: `no sign-in email for ${email}` },
    )
    .toBeTruthy();
  return code as string;
}

/** Signs in on the new tab with an emailed code, as a person would. */
export async function signIn(wall: Page, email: string): Promise<void> {
  await wall.getByTestId('account-trigger').click();
  await wall.getByTestId('account-email').fill(email);
  const since = Date.now();
  await wall.getByRole('button', { name: 'Email me a code' }).click();
  await wall.getByTestId('account-code').fill(await signInCode(email, since));
  await wall.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(wall.getByTestId('account-trigger')).toHaveText(email);
}

export async function expectBackedUp(wall: Page, timeout = 30_000): Promise<void> {
  await expect(wall.getByTestId('sync-status')).toHaveText('All saves backed up', { timeout });
}

/** Clicks "Sync now" in the account panel. */
export async function syncNow(wall: Page): Promise<void> {
  const button = wall.getByRole('button', { name: 'Sync now' });
  if (!(await button.isVisible())) await wall.getByTestId('account-trigger').click();
  await button.click();
}

/** e2e hook: makes the extension's requests to Supabase fail as if offline. */
export async function setOffline(worker: Worker, offline: boolean): Promise<void> {
  await worker.evaluate((value) => {
    (
      globalThis as unknown as {
        __visualMemory: { setSimulatedOffline: (offline: boolean) => void };
      }
    ).__visualMemory.setSimulatedOffline(value);
  }, offline);
}

/** Every save's id, URL and states, read straight from IndexedDB. */
export function localSaves(
  page: Page,
): Promise<{ id: string; url: string; status: string; syncState: string; updatedAt: number }[]> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('visual-memory');
        open.onerror = () => {
          reject(new Error('could not open the database'));
        };
        open.onsuccess = () => {
          const request = open.result.transaction('saves').objectStore('saves').getAll();
          request.onsuccess = () => {
            resolve(
              (
                request.result as {
                  id: string;
                  url: string;
                  status: string;
                  syncState: string;
                  updatedAt: number;
                }[]
              ).map(({ id, url, status, syncState, updatedAt }) => ({
                id,
                url,
                status,
                syncState,
                updatedAt,
              })),
            );
            open.result.close();
          };
        };
      }),
  );
}
