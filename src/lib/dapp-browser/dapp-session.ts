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
