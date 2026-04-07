/**
 * Pure model for an active dApp browser session.
 *
 * In PR-1 the wallet has at most one active session at a time. PR-3
 * introduces parking (a parked session = a session whose webview is
 * offscreen but still alive). PR-4 generalizes this to N simultaneous
 * sessions across multiple `DappWebViewInstance`s.
 *
 * The model deliberately stays platform-agnostic — no references to
 * the InAppBrowser plugin. The lifecycle hook (useDappWebView) owns
 * the plugin interaction.
 */

export type DappSessionStatus = 'opening' | 'active' | 'parked' | 'restoring' | 'closing';

export interface DappSession {
  /** Stable identifier; used as the InAppBrowser instance id once PR-4 lands */
  id: string;
  /** Full URL the session was opened with (may differ from the live url after navigation) */
  url: string;
  /** Origin (scheme + host) — derived from url */
  origin: string;
  /** Page title once browserPageLoaded fires; falls back to origin until then */
  title: string;
  /** Favicon data URL or remote URL; resolved by favicon-cache */
  favicon: string | null;
  /** Lifecycle status */
  status: DappSessionStatus;
  /** Wall-clock open time (ms epoch) — used for LRU eviction in PR-4 */
  openedAt: number;
}

/**
 * Build a fresh session model for a URL the user just opened.
 * The id is generated client-side and acts as the InAppBrowser instance id in PR-4.
 */
export function createDappSession(url: string): DappSession {
  const origin = parseOrigin(url);
  return {
    id: `dapp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    url,
    origin,
    title: origin,
    favicon: null,
    status: 'opening',
    openedAt: Date.now()
  };
}

/**
 * Extract origin from a URL string. Returns the input unchanged if parsing fails
 * (which shouldn't happen for normalized URLs from the launcher).
 */
export function parseOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Hostname-only label for a session URL (no scheme, no www. prefix).
 * Used as the secondary line in the capsule and as the bubble / switcher
 * card / tile fallback name.
 */
export function getDappHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Short, human-readable display name for a session.
 *
 * Priority: a non-empty `<title>` that isn't just the URL itself wins;
 * otherwise we derive a hostname-style label from the URL. The capsule
 * stores `session.title = origin` until the page loads, so without this
 * helper every label fell back to the raw `https://...` string and the
 * letter avatar collapsed to "H".
 */
export function getDappDisplayName(session: { title?: string; url: string; origin?: string }): string {
  const t = (session.title ?? '').trim();
  if (t && !t.startsWith('http')) return t;
  return getDappHostname(session.url);
}
