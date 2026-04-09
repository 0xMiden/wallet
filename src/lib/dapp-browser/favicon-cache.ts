/**
 * In-memory favicon cache keyed by origin.
 *
 * Strategy: Google's S2 favicon service is fast, has wide coverage, and
 * doesn't require us to scrape `<link rel="icon">` tags from inside the
 * dApp webview (which would mean another executeScript round trip).
 *
 * If the request fails or the dApp uses an obscure favicon, the consumer
 * falls back to a colored letter tile rendered in React.
 *
 * The cache is module-scoped (lives for the wallet session). PR-6 may
 * promote it to disk-backed storage if we want favicons to survive cold
 * starts before the dApp's snapshot loads.
 */

const cache = new Map<string, string>();

/**
 * Build the Google S2 favicon URL for an origin. Doesn't fetch — the
 * <img> tag with this src will lazy-load it.
 */
export function buildFaviconUrl(origin: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(origin)}&sz=64`;
}

/**
 * Get a cached favicon for an origin, or build the S2 URL on demand.
 * Always returns a string — there's no async fetch. The caller binds
 * this to an `<img src>` and lets the browser handle loading.
 */
export function getFaviconUrl(origin: string): string {
  const cached = cache.get(origin);
  if (cached) return cached;
  const url = buildFaviconUrl(origin);
  cache.set(origin, url);
  return url;
}

/**
 * Generate a stable color for an origin, used as the fallback tile
 * background when no favicon is available. Hash the origin into a
 * 10-color palette.
 */
const FALLBACK_PALETTE = [
  '#F87171', // red-400
  '#FB923C', // orange-400
  '#FBBF24', // amber-400
  '#A3E635', // lime-400
  '#34D399', // emerald-400
  '#22D3EE', // cyan-400
  '#60A5FA', // blue-400
  '#818CF8', // indigo-400
  '#A78BFA', // violet-400
  '#F472B6' // pink-400
];

export function getFallbackColor(origin: string): string {
  let hash = 0;
  for (let i = 0; i < origin.length; i++) {
    hash = (hash << 5) - hash + origin.charCodeAt(i);
    hash |= 0;
  }
  return FALLBACK_PALETTE[Math.abs(hash) % FALLBACK_PALETTE.length]!;
}

/**
 * First letter of the origin's hostname (capitalized) — used as the
 * fallback letter tile when no favicon is available.
 */
export function getFallbackLetter(origin: string): string {
  try {
    const host = new URL(origin).hostname.replace(/^www\./, '');
    return host.charAt(0).toUpperCase() || '?';
  } catch {
    return origin.charAt(0).toUpperCase() || '?';
  }
}
