const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'ref',
  'ref_src',
  '_ga',
  '_gl',
]);

function bareHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

/**
 * Normalises a URL so trivially different links to the same page compare equal:
 * drops www., tracking parameters, fragments (except hash routes) and trailing slashes.
 */
export function normalizeUrl(input: string): string {
  const url = new URL(input);
  const params = [...url.searchParams.entries()]
    .filter(
      ([key]) => !key.toLowerCase().startsWith('utm_') && !TRACKING_PARAMS.has(key.toLowerCase()),
    )
    .sort(([a], [b]) => a.localeCompare(b));
  const query = new URLSearchParams(params).toString();
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : '';
  const hash = /^#[!/]/.test(url.hash) ? url.hash : '';
  const port = url.port ? `:${url.port}` : '';
  return `${url.protocol}//${bareHost(url.hostname)}${port}${path}${query ? `?${query}` : ''}${hash}`;
}

/**
 * The key saves are deduplicated on. Uses the page's canonical URL when it points at the
 * same site; a canonical on another host is ignored so a bad tag can't merge unrelated saves.
 */
export function dedupeKey(url: string, canonicalUrl: string | null): string {
  if (canonicalUrl) {
    try {
      if (bareHost(new URL(canonicalUrl).hostname) === bareHost(new URL(url).hostname)) {
        return normalizeUrl(canonicalUrl);
      }
    } catch {
      // Malformed canonical: fall through to the page URL.
    }
  }
  return normalizeUrl(url);
}

export function displayDomain(url: string): string {
  try {
    return bareHost(new URL(url).hostname);
  } catch {
    return url;
  }
}

const WEB_STORE_HOSTS = new Set(['chromewebstore.google.com', 'microsoftedge.microsoft.com']);

/** Why a page can't be saved, or null if it can. Checked before anything is captured. */
export function unsupportedReason(url: string | undefined): string | null {
  // Chrome hides the URL of its own pages (chrome://, the new tab page) from extensions.
  if (!url) return "Browser pages can't be saved.";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "This page can't be saved.";
  }
  if (parsed.protocol === 'file:') return "Local files can't be saved.";
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return "Browser pages can't be saved.";
  }
  const host = parsed.hostname.toLowerCase();
  if (
    WEB_STORE_HOSTS.has(host) ||
    (host === 'chrome.google.com' && parsed.pathname.startsWith('/webstore'))
  ) {
    return "Chrome doesn't let extensions capture the Web Store.";
  }
  if (parsed.pathname.toLowerCase().endsWith('.pdf')) return "PDFs can't be saved.";
  return null;
}
