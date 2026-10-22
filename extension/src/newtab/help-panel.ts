function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const kbd = (text: string) => el('kbd', { textContent: text });

/** The shortcuts as they're set now, or null where none is set. */
export async function currentShortcuts(): Promise<{ save: string | null; close: string | null }> {
  const commands = await browser.commands.getAll();
  const shortcut = (name: string) => commands.find((c) => c.name === name)?.shortcut || null;
  return { save: shortcut('save-page'), close: shortcut('save-and-close') };
}

/** "How it works": a short guide, so the trial needs no one standing by. */
export class HelpPanel {
  constructor(
    private readonly trigger: HTMLButtonElement,
    private readonly panel: HTMLElement,
  ) {
    trigger.addEventListener('click', () => {
      void this.toggle();
    });
  }

  private async toggle(): Promise<void> {
    if (!this.panel.hidden) {
      this.panel.hidden = true;
      this.trigger.setAttribute('aria-expanded', 'false');
      return;
    }
    await this.render();
    this.panel.hidden = false;
    this.trigger.setAttribute('aria-expanded', 'true');
  }

  private async render(): Promise<void> {
    const { save, close } = await currentShortcuts();
    const shortcutsButton = el('button', {
      type: 'button',
      className: 'link-button',
      textContent: 'Change shortcuts',
    });
    shortcutsButton.addEventListener('click', () => {
      void browser.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });
    const keyOr = (key: string | null, what: string): (Node | string)[] =>
      key ? [kbd(key), ` ${what}`] : [`No shortcut set to ${what}. `];

    const hide = el('button', { type: 'button', className: 'button', textContent: 'Close' });
    hide.addEventListener('click', () => {
      void this.toggle();
    });

    this.panel.replaceChildren(
      el('div', { className: 'help-columns' }, [
        el('section', {}, [
          el('h2', { textContent: 'Saving' }),
          el('ul', {}, [
            el('li', {}, keyOr(save, 'saves the page you are on.')),
            el('li', {}, keyOr(close, 'saves it and closes the tab.')),
            el('li', {}, [
              'Or click the toolbar button. Right-click it for “Save and close tab”. ',
              shortcutsButton,
            ]),
            el('li', {
              textContent:
                'Saving a page again updates its screenshot; your note stays. “Import open tabs” saves a whole window at once.',
            }),
          ]),
        ]),
        el('section', {}, [
          el('h2', { textContent: 'Finding' }),
          el('ul', {}, [
            el('li', {
              textContent:
                'Describe what you remember: the layout, colours, type, the kind of site. Quick matches show at once; the best matches replace them a moment later.',
            }),
            el('li', {}, [
              kbd('/'),
              ' search, ',
              kbd('↑ ↓ ← →'),
              ' move between sites, ',
              kbd('Enter'),
              ' open, ',
              kbd('Esc'),
              ' clear or close.',
            ]),
            el('li', {
              textContent:
                'Open a site for its details, your note, and “More like this”. Filter by colour, font or when you saved it.',
            }),
          ]),
        ]),
        el('section', {}, [
          el('h2', { textContent: 'Keeping it safe' }),
          el('ul', {}, [
            el('li', {
              textContent:
                'Saves are kept on this computer first. Sign in to back them up and to search by description; each save shows if it is waiting to back up.',
            }),
            el('li', {
              textContent:
                'Export downloads everything (screenshots, notes and details) as one zip.',
            }),
          ]),
        ]),
      ]),
      el('div', { className: 'help-actions' }, [hide]),
    );
  }
}
