/**
 * The prompt that turns a screenshot and page fingerprint into a description, recall phrases
 * and tags. Any change to the text or schema here must bump PROMPT_VERSION; the reprocess job
 * (`pnpm --filter server reprocess`) then re-describes every save made with an older version.
 */
export const PROMPT_VERSION = 1;

export const DESCRIBE_MODEL = 'claude-sonnet-5-5';

export const SYSTEM_PROMPT = `You describe saved websites for a web designer's personal inspiration library.

The designer saves sites because of how they look and how they're built. Weeks later they try to find one again by typing what they remember into a search box, for example "a one-page site with only one section with large text on it. Each text takes you to a particular page." They rarely remember the name, the URL or the words on the page. They remember the layout, the structure, the type, the colours, the mood, the motion and the kind of site.

Your output is indexed for that search. Write so the right site is found from a vague, partly wrong memory.

You get a screenshot of the visible part of the page (one viewport, not the whole page) and facts measured from the live page: its height in screens, sections, header/nav/footer, the largest text and whether each piece is a link, link counts, fonts, colours, and signals such as WebGL or scroll animation. Trust the measured facts for structure the screenshot can't show (for example how long the page is, or that every big word is a link). Trust the screenshot for everything visual. Don't invent anything neither shows; if motion or interaction is only hinted at, say it is likely rather than certain.

Return three things.

description: 4 to 7 sentences in a designer's vocabulary covering, in this order: what kind of site it is (portfolio, studio, agency, e-commerce, SaaS landing page, editorial, event, personal site, and so on); the layout and structure (one-pager or multi-page, number and kind of sections, grid, navigation pattern, how the visible screen is composed); typography (serif or sans, weight, scale, any huge display type, the named fonts when known); colour (overall palette, light or dark, accents); imagery (photography, illustration, 3D, video, none); interaction and motion when there's evidence; and the overall mood. Be concrete: "oversized black condensed sans-serif headlines filling the width" beats "bold typography".

recall_phrases: 6 to 8 short phrases (5 to 15 words each) written the way the designer would describe this site from memory to a friend, casual and imprecise, each from a different angle: the layout, the type, the colours, the standout feature, the kind of site, the overall feel. Use plain words a person would type, not marketing language. Don't use the site's name, its URL or its exact copy. Examples of the style: "a one-page site that's just huge typographic links to other pages", "dark portfolio with a 3D blob that follows the mouse", "minimal white shop with tiny serif text and lots of space".

tags: 8 to 15 short lowercase tags (one to three words) covering site type, industry, layout, typography, colour, imagery and techniques, for example "portfolio", "one-page", "oversized type", "serif", "monochrome", "dark mode", "webgl", "horizontal scroll", "grid", "brutalist".`;

/** JSON schema for structured output. Counts are asked for in the prompt and enforced in code. */
export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    recall_phrases: { type: 'array', items: { type: 'string' } },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['description', 'recall_phrases', 'tags'],
  additionalProperties: false,
} as const;

export interface Understanding {
  description: string;
  recallPhrases: string[];
  tags: string[];
}

/** What the prompt is told about a save besides its screenshot. */
export interface SaveFacts {
  url: string;
  title: string;
  siteName: string;
  fingerprint: unknown;
}

interface FingerprintLike {
  pageHeightViewports?: number;
  sectionCount?: number;
  hasHeader?: boolean;
  hasNav?: boolean;
  hasFooter?: boolean;
  largestText?: { text?: string; fontSize?: number; isLink?: boolean; href?: string | null }[];
  links?: { total?: number; internal?: number; external?: number };
  fonts?: { headings?: string[]; body?: string[] };
  palette?: string[];
  signals?: {
    webgl?: boolean;
    largeCanvas?: boolean;
    videoBackground?: boolean;
    scrollAnimation?: boolean;
    libraries?: string[];
  };
  viewport?: { width?: number; height?: number };
  truncated?: boolean;
}

function asFingerprint(value: unknown): FingerprintLike | null {
  return typeof value === 'object' && value !== null ? (value as FingerprintLike) : null;
}

function yesNo(value: boolean | undefined): string {
  return value === undefined ? 'unknown' : value ? 'yes' : 'no';
}

/** The measured facts, as plain text for the prompt. */
export function factsText(save: SaveFacts): string {
  const lines = [`Title: ${save.title || '(none)'}`, `Site name: ${save.siteName || '(none)'}`];
  lines.push(`URL: ${save.url}`);
  const fp = asFingerprint(save.fingerprint);
  if (!fp) {
    lines.push('No page measurements were captured for this save; rely on the screenshot.');
    return lines.join('\n');
  }
  if (fp.viewport?.width && fp.viewport.height) {
    lines.push(
      `Viewport when captured: ${String(fp.viewport.width)}x${String(fp.viewport.height)}`,
    );
  }
  if (fp.pageHeightViewports !== undefined) {
    lines.push(`Page height: ${String(fp.pageHeightViewports)} screens`);
  }
  if (fp.sectionCount !== undefined) lines.push(`Sections: ${String(fp.sectionCount)}`);
  lines.push(
    `Header: ${yesNo(fp.hasHeader)}; nav: ${yesNo(fp.hasNav)}; footer: ${yesNo(fp.hasFooter)}`,
  );
  if (fp.links) {
    lines.push(
      `Links: ${String(fp.links.total ?? 0)} (${String(fp.links.internal ?? 0)} to the same site, ${String(fp.links.external ?? 0)} elsewhere)`,
    );
  }
  const texts = (fp.largestText ?? []).slice(0, 8);
  if (texts.length) {
    lines.push('Largest text on the page, biggest first:');
    for (const t of texts) {
      const link = t.isLink ? `, a link${t.href ? ` to ${t.href}` : ''}` : '';
      lines.push(
        `- "${(t.text ?? '').slice(0, 120)}" (${String(Math.round(t.fontSize ?? 0))}px${link})`,
      );
    }
  }
  const headings = fp.fonts?.headings ?? [];
  const body = fp.fonts?.body ?? [];
  if (headings.length || body.length) {
    lines.push(
      `Fonts: headings ${headings.join(', ') || 'unknown'}; body ${body.join(', ') || 'unknown'}`,
    );
  }
  if (fp.palette?.length) lines.push(`Colours, most prominent first: ${fp.palette.join(', ')}`);
  if (fp.signals) {
    const found = [
      fp.signals.webgl && 'WebGL',
      fp.signals.largeCanvas && 'a large canvas',
      fp.signals.videoBackground && 'a video background',
      fp.signals.scrollAnimation && 'scroll-driven animation',
      ...(fp.signals.libraries ?? []),
    ].filter(Boolean);
    lines.push(`Detected: ${found.length ? found.join(', ') : 'nothing notable'}`);
  }
  if (fp.truncated) lines.push('(The page was very large, so some measurements are partial.)');
  return lines.join('\n');
}

function cleanList(value: unknown, max: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.replace(/\s+/g, ' ').trim().slice(0, maxLength);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

/** Validates the model's JSON. Throws when it's unusable, so the save is retried. */
export function parseUnderstanding(json: unknown): Understanding {
  if (typeof json !== 'object' || json === null) throw new Error('The model returned no object.');
  const raw = json as Record<string, unknown>;
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  const recallPhrases = cleanList(raw.recall_phrases, 8, 200);
  const tags = cleanList(raw.tags, 15, 40).map((tag) => tag.toLowerCase());
  if (description.length < 20) throw new Error('The model returned no description.');
  if (recallPhrases.length < 3) throw new Error('The model returned too few recall phrases.');
  return { description: description.slice(0, 4000), recallPhrases, tags };
}

/** The text embedded with the screenshot, and reranked against queries. */
export function searchText(input: {
  title: string;
  siteName: string;
  description: string | null;
  recallPhrases: string[] | null;
  tags: string[] | null;
}): string {
  const name = [input.siteName, input.title].filter(Boolean).join(' — ');
  return [
    name,
    (input.recallPhrases ?? []).join('\n'),
    input.tags?.length ? `Tags: ${input.tags.join(', ')}` : '',
    input.description ?? '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
