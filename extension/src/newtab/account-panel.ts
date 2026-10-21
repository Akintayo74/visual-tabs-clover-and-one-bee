import { sendToWorker } from '@/src/lib/events';
import { subscribeSync, type SyncStatus } from '@/src/lib/sync-state';

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? '' : 's'}`;
}

/** One line on the new tab saying whether saves are backed up. */
export function describeSync(status: SyncStatus): string {
  const waiting = status.pendingUploads;
  switch (status.phase) {
    case 'signed-out':
      return waiting
        ? `Not backed up: ${plural(waiting, 'save')} only on this computer`
        : 'Not backed up';
    case 'syncing':
      return waiting ? `Backing up ${plural(waiting, 'save')}…` : 'Syncing…';
    case 'offline':
      return waiting
        ? `Offline. ${plural(waiting, 'save')} will back up when you're online`
        : 'Offline';
    case 'error':
      return `Backup paused, retrying soon: ${status.error ?? 'unknown error'}`;
    case 'idle':
      return waiting ? `${plural(waiting, 'save')} waiting to back up` : 'All saves backed up';
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

type Step = 'closed' | 'email' | 'code' | 'account';

/** Sign-in with an emailed code, sign-out, and the backup status line. */
export class AccountPanel {
  private status: SyncStatus | null = null;
  private step: Step = 'closed';
  private email = '';
  private message: string | null = null;
  private busy = false;

  constructor(
    private readonly trigger: HTMLButtonElement,
    private readonly panel: HTMLElement,
    private readonly statusLine: HTMLElement,
    private readonly onStatus: (status: SyncStatus) => void,
  ) {
    trigger.addEventListener('click', () => {
      this.message = null;
      this.step = this.step !== 'closed' ? 'closed' : this.status?.email ? 'account' : 'email';
      this.render();
    });
    subscribeSync((next) => {
      this.setStatus(next);
    });
    // Coming back online is the moment to upload what was saved offline.
    window.addEventListener('online', () => {
      void this.refresh('sync-now');
    });
    void this.refresh('sync-now');
  }

  private async refresh(type: 'sync-status' | 'sync-now'): Promise<void> {
    try {
      this.setStatus(await sendToWorker<SyncStatus>({ type }));
    } catch (error) {
      console.warn('[account] no sync status', error);
    }
  }

  private setStatus(next: SyncStatus): void {
    this.status = next;
    this.onStatus(next);
    this.render();
  }

  private async run(action: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.message = null;
    this.render();
    try {
      await action();
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private render(): void {
    const status = this.status;
    const configured = status?.configured ?? false;
    this.trigger.hidden = !configured;
    this.statusLine.hidden = !configured;
    if (!status || !configured) {
      this.panel.hidden = true;
      return;
    }
    this.statusLine.textContent = describeSync(status);
    this.statusLine.dataset.phase = status.phase;
    this.trigger.textContent = status.email ?? 'Sign in to back up';
    if (status.email && (this.step === 'email' || this.step === 'code')) this.step = 'account';
    if (!status.email && this.step === 'account') this.step = 'closed';

    const children: Node[] = [];
    if (this.step === 'email') children.push(this.emailForm());
    if (this.step === 'code') children.push(this.codeForm());
    if (this.step === 'account') children.push(...this.accountView(status));
    if (this.message && this.step !== 'closed') {
      children.push(el('p', { className: 'account-message', textContent: this.message }));
    }
    this.panel.replaceChildren(...children);
    this.panel.hidden = children.length === 0;
  }

  private emailForm(): HTMLFormElement {
    const form = el('form', { className: 'account-form' });
    const label = el('label', {
      textContent: 'Back up your saves and sync them to other computers. We email you a code.',
    });
    const input = el('input', {
      type: 'email',
      required: true,
      placeholder: 'you@example.com',
      value: this.email,
      autocomplete: 'email',
    });
    input.dataset.testid = 'account-email';
    const submit = el('button', {
      type: 'submit',
      className: 'button primary',
      textContent: this.busy ? 'Sending…' : 'Email me a code',
      disabled: this.busy,
    });
    form.append(label, el('div', { className: 'account-row' }));
    form.lastElementChild?.append(input, submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const email = input.value.trim();
      void this.run(async () => {
        await sendToWorker({ type: 'auth-send-code', email });
        this.email = email;
        this.step = 'code';
      });
    });
    queueMicrotask(() => {
      input.focus();
    });
    return form;
  }

  private codeForm(): HTMLFormElement {
    const form = el('form', { className: 'account-form' });
    const label = el('label', { textContent: `Enter the 6-digit code sent to ${this.email}.` });
    const input = el('input', {
      inputMode: 'numeric',
      autocomplete: 'one-time-code',
      required: true,
      pattern: '[0-9]{6,10}',
      placeholder: '123456',
    });
    input.dataset.testid = 'account-code';
    const submit = el('button', {
      type: 'submit',
      className: 'button primary',
      textContent: this.busy ? 'Signing in…' : 'Sign in',
      disabled: this.busy,
    });
    const back = el('button', { type: 'button', className: 'button', textContent: 'Back' });
    back.addEventListener('click', () => {
      this.step = 'email';
      this.message = null;
      this.render();
    });
    form.append(label, el('div', { className: 'account-row' }));
    form.lastElementChild?.append(input, submit, back);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const code = input.value.trim();
      void this.run(async () => {
        this.setStatus(
          await sendToWorker<SyncStatus>({ type: 'auth-verify', email: this.email, code }),
        );
        this.step = 'closed';
      });
    });
    queueMicrotask(() => {
      input.focus();
    });
    return form;
  }

  private accountView(status: SyncStatus): Node[] {
    const info = el('p', {
      textContent: `Signed in as ${status.email ?? ''}. ${
        status.lastSyncedAt
          ? `Last synced ${new Date(status.lastSyncedAt).toLocaleTimeString()}.`
          : ''
      }`,
    });
    const syncNow = el('button', { type: 'button', className: 'button', textContent: 'Sync now' });
    syncNow.addEventListener('click', () => {
      void this.refresh('sync-now');
    });
    const signOut = el('button', {
      type: 'button',
      className: 'button',
      textContent: 'Sign out',
    });
    signOut.addEventListener('click', () => {
      void this.run(async () => {
        this.setStatus(await sendToWorker<SyncStatus>({ type: 'auth-sign-out' }));
        this.step = 'closed';
      });
    });
    const note = el('p', {
      className: 'account-note',
      textContent: 'Signing out keeps your saves on this computer and on the server.',
    });
    const row = el('div', { className: 'account-row' });
    row.append(syncNow, signOut);
    return [info, row, note];
  }
}
