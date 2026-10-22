import { deleteSave, getDisplayImage, getFingerprint, setNote } from '@/src/lib/db';
import { publish } from '@/src/lib/events';
import type { Fingerprint, SaveRecord } from '@/src/lib/types';
import { displayDomain } from '@/src/lib/url';
import { faviconUrl } from './wall';

const CONFIRM_WINDOW_MS = 4000;
/** Typing pauses this long before the note is stored. */
const NOTE_SAVE_DELAY_MS = 600;
export const NOTE_MAX_LENGTH = 4000;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function chip(colour: string): HTMLElement {
  const span = el('span', { className: 'chip' });
  span.style.background = colour;
  return span;
}

function row(label: string, value: Node | string): HTMLElement {
  return el('div', { className: 'detail-row' }, [
    el('dt', { textContent: label }),
    el('dd', {}, [value]),
  ]);
}

function structure(fp: Fingerprint): string {
  const parts = [
    `${String(fp.pageHeightViewports)} screens tall`,
    `${String(fp.sectionCount)} section${fp.sectionCount === 1 ? '' : 's'}`,
  ];
  const chrome = [fp.hasHeader && 'header', fp.hasNav && 'nav', fp.hasFooter && 'footer'].filter(
    Boolean,
  );
  parts.push(chrome.length ? `has ${chrome.join(', ')}` : 'no header, nav or footer');
  parts.push(
    `${String(fp.links.total)} links (${String(fp.links.internal)} internal, ${String(fp.links.external)} external)`,
  );
  return parts.join(' · ');
}

function signals(fp: Fingerprint): string {
  const found = [
    fp.signals.webgl && '3D/WebGL',
    fp.signals.largeCanvas && 'large canvas',
    fp.signals.videoBackground && 'video background',
    fp.signals.scrollAnimation && 'scroll animation',
    ...fp.signals.libraries,
  ].filter(Boolean);
  return found.length ? found.join(', ') : 'None detected';
}

export interface DetailCallbacks {
  onRetry(save: SaveRecord): void;
  onRetryUnderstanding(save: SaveRecord): void;
  onDeleted(save: SaveRecord): void;
  /** A note was stored on this device and needs uploading. */
  onNoteSaved(save: SaveRecord): void;
  onMoreLikeThis(save: SaveRecord): void;
}

/** The detail view: full screenshot, what we know about the page, and its actions. */
export class Detail {
  private readonly dialog: HTMLDialogElement;
  private objectUrl: string | null = null;
  private current: SaveRecord | null = null;
  /** Stores a note edit still waiting for typing to pause; run when the dialog closes. */
  private flushNote: (() => Promise<void>) | null = null;

  constructor(private readonly callbacks: DetailCallbacks) {
    this.dialog = el('dialog', { className: 'detail' });
    this.dialog.dataset.testid = 'detail';
    this.dialog.addEventListener('close', () => {
      this.cleanup();
    });
    this.dialog.addEventListener('click', (event) => {
      // A click on the backdrop closes the dialog.
      if (event.target === this.dialog) this.dialog.close();
    });
    this.dialog.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement;
      if (event.key === 'Enter' && !target.closest('button, a, textarea') && this.current) {
        event.preventDefault();
        window.location.href = this.current.url;
      }
    });
    document.body.append(this.dialog);
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  get openId(): string | null {
    return this.isOpen ? (this.current?.id ?? null) : null;
  }

  close(): void {
    this.dialog.close();
  }

  async show(save: SaveRecord): Promise<void> {
    this.cleanup();
    this.current = save;
    const fingerprint = await getFingerprint(save.id);
    if (this.current !== save) return;

    const img = el('img', { className: 'detail-image', alt: `Screenshot of ${save.title}` });
    void getDisplayImage(save.id, 'full').then((blob) => {
      if (!blob || this.current !== save) return;
      this.objectUrl = URL.createObjectURL(blob);
      img.src = this.objectUrl;
    });

    const open = el('a', { className: 'button primary', href: save.url, textContent: 'Open site' });
    const del = el('button', { type: 'button', className: 'button danger', textContent: 'Delete' });
    let confirmTimer = 0;
    del.addEventListener('click', () => {
      if (!del.classList.contains('confirming')) {
        del.classList.add('confirming');
        del.textContent = 'Click again to delete';
        confirmTimer = window.setTimeout(() => {
          del.classList.remove('confirming');
          del.textContent = 'Delete';
        }, CONFIRM_WINDOW_MS);
        return;
      }
      clearTimeout(confirmTimer);
      void deleteSave(save.id).then(() => {
        publish({ type: 'deleted', id: save.id });
        this.callbacks.onDeleted(save);
        this.dialog.close();
      });
    });
    const close = el('button', { type: 'button', className: 'button', textContent: 'Close' });
    close.addEventListener('click', () => {
      this.dialog.close();
    });

    const similar = el('button', {
      type: 'button',
      className: 'button',
      textContent: 'More like this',
    });
    similar.dataset.testid = 'more-like-this';
    similar.addEventListener('click', () => {
      this.dialog.close();
      this.callbacks.onMoreLikeThis(save);
    });

    const actions = el('div', { className: 'detail-actions' }, [open, similar, del, close]);
    if (save.status === 'failed') {
      const retry = el('button', { type: 'button', className: 'button', textContent: 'Retry' });
      retry.addEventListener('click', () => {
        this.callbacks.onRetry(save);
      });
      actions.prepend(retry);
    } else if (save.understanding?.status === 'failed') {
      const retry = el('button', {
        type: 'button',
        className: 'button',
        textContent: 'Retry describing',
      });
      retry.addEventListener('click', () => {
        retry.disabled = true;
        this.callbacks.onRetryUnderstanding(save);
      });
      actions.prepend(retry);
    }

    const icon = el('img', { className: 'detail-favicon', src: faviconUrl(save.url, 32), alt: '' });
    const header = el('header', { className: 'detail-header' }, [
      icon,
      el('div', { className: 'detail-heading' }, [
        el('h2', { textContent: save.title }),
        el('a', {
          href: save.url,
          textContent: displayDomain(save.url),
          className: 'detail-domain',
        }),
      ]),
      actions,
    ]);

    const facts = el('dl', { className: 'detail-facts' });
    facts.append(row('Your note', this.noteEditor(save)));
    facts.append(row('Saved', new Date(save.updatedAt).toLocaleString()));
    if (save.status !== 'ready') {
      facts.append(
        row(
          'Status',
          save.status === 'failed' ? `Failed: ${save.error ?? 'unknown error'}` : 'Processing…',
        ),
      );
    }
    const understanding = save.understanding;
    if (understanding?.description) {
      facts.append(row('Description', understanding.description));
    }
    if (understanding?.recallPhrases.length) {
      facts.append(
        row(
          'Remembered as',
          el(
            'ul',
            { className: 'recall-phrases' },
            understanding.recallPhrases.map((p) => el('li', { textContent: p })),
          ),
        ),
      );
    }
    if (understanding?.tags.length) facts.append(row('Tags', understanding.tags.join(', ')));
    if (understanding && understanding.status !== 'ready') {
      const text =
        understanding.status === 'failed'
          ? `Couldn't describe this save: ${understanding.error ?? 'unknown error'}`
          : understanding.error
            ? `Describing; the last try failed (${understanding.error}) and will be retried`
            : 'Describing…';
      facts.append(row('Search', text));
    }
    if (save.fonts.length) facts.append(row('Fonts', save.fonts.join(', ')));
    if (save.palette.length) {
      const swatches = el(
        'div',
        { className: 'swatches' },
        save.palette.map((colour) =>
          el('span', { className: 'swatch', title: colour }, [chip(colour), colour]),
        ),
      );
      facts.append(row('Palette', swatches));
    }
    if (fingerprint) {
      facts.append(row('Structure', structure(fingerprint)));
      facts.append(row('Signals', signals(fingerprint)));
      const texts = fingerprint.largestText.slice(0, 5);
      if (texts.length) {
        facts.append(
          row(
            'Largest text',
            el(
              'ul',
              { className: 'large-text' },
              texts.map((t) =>
                el('li', {}, [
                  `${t.text} `,
                  el('span', {
                    className: 'muted',
                    textContent: `${String(Math.round(t.fontSize))}px${t.isLink ? ', link' : ''}`,
                  }),
                ]),
              ),
            ),
          ),
        );
      }
    } else {
      facts.append(row('Structure', 'Not captured for this save'));
    }

    this.dialog.replaceChildren(
      header,
      el('div', { className: 'detail-body' }, [
        el('div', { className: 'detail-shot' }, [img]),
        facts,
      ]),
    );
    if (!this.dialog.open) this.dialog.showModal();
    open.focus();
  }

  /** The note box: stored on this device as you type, then backed up by sync. */
  private noteEditor(save: SaveRecord): HTMLElement {
    const input = el('textarea', {
      className: 'note-input',
      value: save.note ?? '',
      placeholder: 'Why you saved it, who it was for, what to borrow from it…',
      rows: 3,
      maxLength: NOTE_MAX_LENGTH,
    });
    input.dataset.testid = 'note';
    input.setAttribute('aria-label', 'Your note');
    const status = el('div', { className: 'note-status muted' });
    status.dataset.testid = 'note-status';
    status.setAttribute('aria-live', 'polite');
    if (save.notePending) status.textContent = 'Saved on this device; backs up when online.';

    let stored = save.note ?? '';
    let timer = 0;
    const store = async (): Promise<void> => {
      clearTimeout(timer);
      const text = input.value.trim();
      if (text === stored) return;
      stored = text;
      try {
        const updated = await setNote(save.id, text, Date.now());
        if (!updated) {
          status.textContent = 'This save was deleted, so the note was not kept.';
          return;
        }
        status.textContent = 'Saved.';
        publish({ type: 'changed', id: save.id });
        this.callbacks.onNoteSaved(updated);
      } catch (error) {
        stored = '';
        console.error('[note] could not store', error);
        status.textContent = `Couldn't save the note: ${error instanceof Error ? error.message : String(error)}`;
      }
    };
    input.addEventListener('input', () => {
      status.textContent = '';
      clearTimeout(timer);
      timer = window.setTimeout(() => void store(), NOTE_SAVE_DELAY_MS);
    });
    input.addEventListener('blur', () => void store());
    this.flushNote = store;
    return el('div', { className: 'note' }, [input, status]);
  }

  private cleanup(): void {
    if (this.flushNote) void this.flushNote();
    this.flushNote = null;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }
}
