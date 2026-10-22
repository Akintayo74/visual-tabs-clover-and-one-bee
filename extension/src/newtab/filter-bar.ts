import {
  colourOptions,
  FAMILY_SWATCH,
  fontOptions,
  hasFilters,
  NO_FILTERS,
  SAVED_WITHIN_LABELS,
  type ColourFamily,
  type Filters,
  type SavedWithin,
} from '@/src/lib/filters';
import type { SaveRecord } from '@/src/lib/types';

/** Most fonts offered in the font menu; the rest are rarely used one-offs. */
const MAX_FONTS = 40;

/** Colour, font and date filters. They start cleared on every new tab. */
export class FilterBar {
  private value: Filters = NO_FILTERS;
  private readonly colours: HTMLElement;
  private readonly font: HTMLSelectElement;
  private readonly saved: HTMLSelectElement;
  private readonly clearButton: HTMLButtonElement;
  private coloursKey = '';
  private fontsKey = '';

  constructor(
    container: HTMLElement,
    private readonly onChange: (filters: Filters) => void,
  ) {
    this.colours = document.createElement('div');
    this.colours.className = 'colour-filter';
    this.colours.setAttribute('role', 'group');
    this.colours.setAttribute('aria-label', 'Filter by colour');

    this.font = document.createElement('select');
    this.font.className = 'filter-select';
    this.font.dataset.testid = 'font-filter';
    this.font.setAttribute('aria-label', 'Filter by font');
    this.font.addEventListener('change', () => {
      this.set({ font: this.font.value || null });
    });

    this.saved = document.createElement('select');
    this.saved.className = 'filter-select';
    this.saved.dataset.testid = 'date-filter';
    this.saved.setAttribute('aria-label', 'Filter by when it was saved');
    for (const [value, label] of Object.entries(SAVED_WITHIN_LABELS)) {
      this.saved.append(new Option(label, value));
    }
    this.saved.addEventListener('change', () => {
      this.set({ saved: this.saved.value as SavedWithin });
    });

    this.clearButton = document.createElement('button');
    this.clearButton.type = 'button';
    this.clearButton.className = 'link-button';
    this.clearButton.textContent = 'Clear filters';
    this.clearButton.hidden = true;
    this.clearButton.addEventListener('click', () => {
      this.clear();
    });

    container.append(this.colours, this.font, this.saved, this.clearButton);
  }

  get filters(): Filters {
    return this.value;
  }

  clear(): void {
    this.set(NO_FILTERS);
  }

  /** Refreshes the colours and fonts on offer from the library. */
  setSaves(saves: SaveRecord[]): void {
    const colours = colourOptions(saves);
    if (this.value.colour && !colours.includes(this.value.colour)) colours.push(this.value.colour);
    const coloursKey = colours.join();
    if (coloursKey !== this.coloursKey) {
      this.coloursKey = coloursKey;
      this.colours.replaceChildren(...colours.map((family) => this.swatch(family)));
    }
    const fonts = fontOptions(saves).slice(0, MAX_FONTS);
    if (this.value.font && !fonts.some((f) => f.font === this.value.font)) {
      fonts.push({ font: this.value.font, count: 0 });
    }
    const fontsKey = fonts.map((f) => `${f.font}:${String(f.count)}`).join();
    if (fontsKey !== this.fontsKey) {
      this.fontsKey = fontsKey;
      this.font.replaceChildren(
        new Option('Any font', ''),
        ...fonts.map((f) => new Option(`${f.font} (${String(f.count)})`, f.font)),
      );
      this.font.value = this.value.font ?? '';
    }
    this.font.hidden = fonts.length === 0;
  }

  private swatch(family: ColourFamily): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `swatch-button is-${family}`;
    button.dataset.colour = family;
    button.title = family.charAt(0).toUpperCase() + family.slice(1);
    button.setAttribute('aria-label', `${button.title} colours`);
    button.setAttribute('aria-pressed', String(this.value.colour === family));
    button.style.setProperty('--swatch', FAMILY_SWATCH[family]);
    button.addEventListener('click', () => {
      this.set({ colour: this.value.colour === family ? null : family });
    });
    return button;
  }

  private set(change: Partial<Filters>): void {
    this.value = { ...this.value, ...change };
    for (const button of this.colours.querySelectorAll<HTMLButtonElement>('[data-colour]')) {
      button.setAttribute('aria-pressed', String(button.dataset.colour === this.value.colour));
    }
    this.font.value = this.value.font ?? '';
    this.saved.value = this.value.saved;
    this.clearButton.hidden = !hasFilters(this.value);
    this.onChange(this.value);
  }
}
