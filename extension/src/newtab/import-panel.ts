import { sendToWorker as send, type WorkerMessage } from '@/src/lib/events';
import { type ImportState, subscribeImport, summarize } from '@/src/lib/import-state';
import { displayDomain } from '@/src/lib/url';

function button(label: string, onClick: () => void, className = 'button'): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  el.textContent = label;
  el.addEventListener('click', onClick);
  return el;
}

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? '' : 's'}`;
}

/** "Import my open tabs": the button, live progress, and the summary with "close tabs". */
export class ImportPanel {
  private state: ImportState | null = null;
  private message: string | null = null;

  constructor(
    private readonly trigger: HTMLButtonElement,
    private readonly panel: HTMLElement,
  ) {
    trigger.addEventListener('click', () => {
      void this.start();
    });
    subscribeImport((next) => {
      this.state = next;
      this.render();
    });
    void send<ImportState | null>({ type: 'import-status' }).then((current) => {
      this.state = current;
      this.render();
    });
  }

  private async start(): Promise<void> {
    this.message = null;
    // Must be called straight from the click so Chrome accepts it as a user gesture.
    const granted = await browser.permissions.request({ origins: ['<all_urls>'] });
    if (!granted) {
      this.message = 'Importing needs permission to capture your open tabs. Nothing was imported.';
      this.render();
      return;
    }
    const tab = await browser.tabs.getCurrent();
    if (tab?.id === undefined) return;
    try {
      this.state = await send<ImportState>({
        type: 'import-start',
        windowId: tab.windowId,
        originalTabId: tab.id,
      });
    } catch (error) {
      this.message = `Couldn't start the import: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.render();
  }

  private act(message: WorkerMessage, after?: (result: unknown) => void): () => void {
    return () => {
      void send<unknown>(message).then(after, (error: unknown) => {
        this.message = error instanceof Error ? error.message : String(error);
        this.render();
      });
    };
  }

  private render(): void {
    const state = this.state;
    const busy = state?.phase === 'running' || state?.phase === 'cancelling';
    this.trigger.disabled = busy || state?.phase === 'interrupted';
    const children: Node[] = [];

    if (this.message) {
      const p = document.createElement('p');
      p.className = 'import-message';
      p.textContent = this.message;
      children.push(p);
    }

    if (state) {
      const s = summarize(state);
      const heading = document.createElement('p');
      heading.className = 'import-heading';
      const actions = document.createElement('div');
      actions.className = 'import-actions';

      if (busy) {
        heading.textContent =
          state.phase === 'cancelling'
            ? `Stopping after the current tab… (${String(s.done)} of ${String(s.total)})`
            : `Importing tab ${String(Math.min(s.done + 1, s.total))} of ${String(s.total)}…`;
        const bar = document.createElement('progress');
        bar.max = Math.max(s.total, 1);
        bar.value = s.done;
        children.push(heading, bar);
        if (state.phase === 'running')
          actions.append(button('Cancel', this.act({ type: 'import-cancel' })));
      } else if (state.phase === 'interrupted') {
        heading.textContent = `The import stopped partway (${String(s.done)} of ${String(s.total)} tabs done).`;
        children.push(heading);
        actions.append(
          button('Resume', this.act({ type: 'import-resume' }), 'button primary'),
          button('Stop here', this.act({ type: 'import-cancel' })),
        );
      } else {
        const verb = state.phase === 'cancelled' ? 'Import cancelled. Saved' : 'Saved';
        heading.textContent = `${verb} ${plural(s.saved, 'tab')} of ${String(s.total)}.`;
        children.push(heading);
        const problems = state.items.filter((i) => i.status === 'skipped' || i.status === 'failed');
        if (problems.length) {
          const details = document.createElement('details');
          const summary = document.createElement('summary');
          summary.textContent = `${plural(problems.length, 'tab')} not saved`;
          const list = document.createElement('ul');
          for (const item of problems) {
            const li = document.createElement('li');
            li.textContent = `${item.title || displayDomain(item.url) || 'Untitled tab'}: ${item.reason ?? item.status}`;
            list.append(li);
          }
          details.append(summary, list);
          children.push(details);
        }
        if (state.closedTabs !== undefined) {
          const closed = document.createElement('p');
          closed.textContent = `Closed ${plural(state.closedTabs, 'tab')}.${
            state.keptTabs
              ? ` Left ${plural(state.keptTabs, 'tab')} open because ${state.keptTabs === 1 ? 'it now shows' : 'they now show'} a different page.`
              : ''
          }`;
          children.push(closed);
        } else if (s.saved > 0) {
          actions.append(
            button(
              `Close ${plural(s.saved, 'saved tab')}`,
              this.act({ type: 'import-close-saved' }),
              'button primary',
            ),
          );
        }
        actions.append(
          button(
            'Done',
            this.act({ type: 'import-dismiss' }, () => {
              this.message = null;
            }),
          ),
        );
      }
      children.push(actions);
    }

    this.panel.replaceChildren(...children);
    this.panel.hidden = children.length === 0;
  }
}
