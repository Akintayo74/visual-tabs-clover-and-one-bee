import type { Fingerprint, LargeText } from '@/src/lib/types';

/**
 * Reads the page's structure. Injected with `scripting.executeScript({ func })`, which
 * serialises the function's source, so it must not reference anything outside its own body.
 * Runs in the page's main world so it can see globals set by animation and 3D libraries.
 */
export function extractFingerprint(ignoreSelector: string | null = null): Fingerprint {
  const MAX_ELEMENTS = 6000;
  const MAX_LARGE_TEXT = 12;
  const MAX_TEXT_LENGTH = 140;

  const doc = document;
  const win = window;
  const vw = win.innerWidth || doc.documentElement.clientWidth;
  const vh = win.innerHeight || doc.documentElement.clientHeight;
  const viewportArea = Math.max(vw * vh, 1);
  const here = location.hostname.toLowerCase().replace(/^www\./, '');

  function absolute(href: string | null | undefined): string | null {
    if (!href) return null;
    try {
      return new URL(href, doc.baseURI).href;
    } catch {
      return null;
    }
  }

  function meta(selector: string): string | null {
    const content = doc.querySelector<HTMLMetaElement>(selector)?.content.trim();
    return content ? content : null;
  }

  function firstFamily(fontFamily: string): string {
    return (fontFamily.split(',').at(0) ?? '').trim().replace(/^["']|["']$/g, '');
  }

  function toHex(color: string): string | null {
    const match = /rgba?\(([^)]+)\)/.exec(color);
    if (!match?.[1]) return null;
    const parts = match[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    const [r, g, b] = parts;
    const alpha = parts[3] ?? 1;
    if (r === undefined || g === undefined || b === undefined || alpha < 0.5) return null;
    return `#${[r, g, b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
  }

  function isVisible(el: Element, style: CSSStyleDeclaration): boolean {
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function ownText(el: Element): string {
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? '';
    }
    return text.replace(/\s+/g, ' ').trim();
  }

  function isInternal(href: string): boolean | null {
    try {
      const url = new URL(href, doc.baseURI);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return url.hostname.toLowerCase().replace(/^www\./, '') === here;
    } catch {
      return null;
    }
  }

  function addWeight(map: Map<string, number>, key: string | null, weight: number): void {
    if (!key || weight <= 0) return;
    map.set(key, (map.get(key) ?? 0) + weight);
  }

  function topKeys(map: Map<string, number>, limit: number): string[] {
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([key]) => key);
  }

  const ignored = ignoreSelector ? doc.querySelector(ignoreSelector) : null;
  const scrollHeight = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);

  // One pass over the elements, collecting text, colours and fonts.
  const textCandidates: LargeText[] = [];
  const headingFonts = new Map<string, number>();
  const bodyFonts = new Map<string, number>();
  const colours = new Map<string, number>();
  let largeCanvas = false;
  let videoBackground = false;
  let scrollTimeline = false;
  let visited = 0;
  let truncated = false;

  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      const tag = (node as Element).tagName;
      if (node === ignored || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const rootStyle = win.getComputedStyle(doc.body);
  const rootBg =
    toHex(rootStyle.backgroundColor) ??
    toHex(win.getComputedStyle(doc.documentElement).backgroundColor);
  addWeight(colours, rootBg ?? '#ffffff', viewportArea);

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (++visited > MAX_ELEMENTS) {
      truncated = true;
      break;
    }
    const el = node as HTMLElement;
    const style = win.getComputedStyle(el);
    if (!isVisible(el, style)) continue;
    const rect = el.getBoundingClientRect();
    const absTop = rect.top + win.scrollY;
    // Elements near the top of the page shape the impression most.
    const prominence = absTop < vh ? 1 : absTop < vh * 3 ? 0.5 : 0.2;
    const visibleArea =
      Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0)) * Math.max(0, rect.height);

    addWeight(
      colours,
      toHex(style.backgroundColor),
      Math.min(visibleArea, viewportArea) * prominence,
    );
    if (
      'animationTimeline' in style &&
      style.animationTimeline &&
      !/^(auto|none)$/.test(style.animationTimeline)
    ) {
      scrollTimeline = true;
    }

    if (el.tagName === 'CANVAS' && visibleArea >= viewportArea * 0.25) largeCanvas = true;
    if (el.tagName === 'VIDEO') {
      const video = el as HTMLVideoElement;
      if ((video.autoplay || video.loop) && video.muted && visibleArea >= viewportArea * 0.3) {
        videoBackground = true;
      }
    }

    const text = ownText(el);
    if (!text) continue;
    const fontSize = parseFloat(style.fontSize) || 0;
    const family = firstFamily(style.fontFamily);
    const isHeading = /^H[1-3]$/.test(el.tagName) || fontSize >= 28;
    addWeight(isHeading ? headingFonts : bodyFonts, family, text.length * fontSize * prominence);
    addWeight(colours, toHex(style.color), text.length * fontSize * fontSize * 0.5 * prominence);

    const link = el.closest('a[href]');
    textCandidates.push({
      text: text.slice(0, MAX_TEXT_LENGTH),
      fontSize,
      isLink: link !== null,
      href: link ? absolute(link.getAttribute('href')) : null,
    });
  }

  const seen = new Set<string>();
  const largestText = textCandidates
    .sort((a, b) => b.fontSize - a.fontSize)
    .filter((candidate) => {
      const key = candidate.text.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_LARGE_TEXT);

  // Sections: explicit <section>s, else the tall top-level blocks of <main> or <body>.
  const minSectionHeight = vh * 0.3;
  const tall = (els: Iterable<Element>) =>
    [...els].filter((el) => el !== ignored && el.getBoundingClientRect().height >= minSectionHeight)
      .length;
  const explicitSections = tall(doc.querySelectorAll('section'));
  const container = doc.querySelector('main') ?? doc.body;
  const sectionCount = Math.max(explicitSections, tall(container.children));

  let internal = 0;
  let external = 0;
  const anchors = doc.querySelectorAll('a[href]');
  for (const anchor of anchors) {
    const result = isInternal(anchor.getAttribute('href') ?? '');
    if (result === true) internal++;
    else if (result === false) external++;
  }

  const g = win as unknown as Record<string, unknown>;
  const libraryChecks: [string, () => boolean][] = [
    [
      'three.js',
      () => 'THREE' in g || doc.querySelector('canvas[data-engine^="three.js"]') !== null,
    ],
    ['PixiJS', () => 'PIXI' in g || '__PIXI_APP__' in g],
    ['Babylon.js', () => 'BABYLON' in g],
    ['Spline', () => doc.querySelector('spline-viewer, canvas[data-spline]') !== null],
    ['GSAP', () => 'gsap' in g || 'TweenMax' in g],
    ['ScrollTrigger', () => 'ScrollTrigger' in g],
    [
      'Lenis',
      () => 'Lenis' in g || 'lenis' in g || doc.documentElement.classList.contains('lenis'),
    ],
    [
      'Locomotive Scroll',
      () => 'LocomotiveScroll' in g || doc.querySelector('[data-scroll-container]') !== null,
    ],
    ['Barba.js', () => 'barba' in g || doc.querySelector('[data-barba]') !== null],
    ['Swiper', () => 'Swiper' in g || doc.querySelector('.swiper') !== null],
    ['anime.js', () => 'anime' in g],
    [
      'Lottie',
      () =>
        'lottie' in g ||
        'bodymovin' in g ||
        doc.querySelector('lottie-player, dotlottie-player') !== null,
    ],
    [
      'Framer',
      () => doc.querySelector('[data-framer-name], [data-framer-component-type]') !== null,
    ],
    ['Webflow', () => 'Webflow' in g || doc.documentElement.hasAttribute('data-wf-page')],
    ['Next.js', () => '__NEXT_DATA__' in g || doc.querySelector('#__next') !== null],
    ['Nuxt', () => '__NUXT__' in g],
    [
      'Squarespace',
      () =>
        'Static' in g && doc.querySelector('[data-squarespace-cacheversion], .sqs-block') !== null,
    ],
    ['Shopify', () => 'Shopify' in g],
    ['WordPress', () => /wordpress/i.test(meta('meta[name="generator"]') ?? '')],
  ];
  const libraries = libraryChecks
    .filter(([, check]) => {
      try {
        return check();
      } catch {
        return false;
      }
    })
    .map(([name]) => name);

  const has3d = libraries.some((name) =>
    ['three.js', 'PixiJS', 'Babylon.js', 'Spline'].includes(name),
  );
  const hasScrollLibrary = libraries.some((name) =>
    ['ScrollTrigger', 'Lenis', 'Locomotive Scroll'].includes(name),
  );

  const canonical = absolute(
    doc.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.getAttribute('href'),
  );
  const icon = absolute(
    doc
      .querySelector<HTMLLinkElement>('link[rel~="icon"], link[rel="apple-touch-icon"]')
      ?.getAttribute('href'),
  );

  return {
    version: 1,
    url: location.href,
    canonicalUrl: canonical,
    title: doc.title.trim(),
    siteName: meta('meta[property="og:site_name"]') ?? meta('meta[name="application-name"]'),
    faviconUrl: icon,
    viewport: { width: vw, height: vh, devicePixelRatio: win.devicePixelRatio || 1 },
    pageHeightViewports: Math.round((scrollHeight / Math.max(vh, 1)) * 10) / 10,
    sectionCount,
    hasHeader: doc.querySelector('header, [role="banner"]') !== null,
    hasNav: doc.querySelector('nav, [role="navigation"]') !== null,
    hasFooter: doc.querySelector('footer, [role="contentinfo"]') !== null,
    largestText,
    links: { total: anchors.length, internal, external },
    fonts: { headings: topKeys(headingFonts, 3), body: topKeys(bodyFonts, 3) },
    palette: topKeys(colours, 6),
    signals: {
      webgl: has3d,
      largeCanvas,
      videoBackground,
      scrollAnimation: hasScrollLibrary || scrollTimeline,
      libraries,
    },
    truncated,
  };
}
