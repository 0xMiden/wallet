/**
 * Per-page guide banners: each home-carousel pane (Send, Receive, Earn, Swap)
 * offers its own guided tour from a slim banner under the segmented action
 * bar. A banner stays available until the user dismisses it (or takes the
 * tour); dismissals persist per page in localStorage.
 */
export type GuidePage = 'send' | 'receive' | 'earn' | 'swap';

const PAGE_GUIDES_DISMISSED_KEY = 'page_guides_dismissed';

function isGuidePage(value: unknown): value is GuidePage {
  return value === 'send' || value === 'receive' || value === 'earn' || value === 'swap';
}

export function getDismissedPageGuides(): GuidePage[] {
  try {
    const raw = localStorage.getItem(PAGE_GUIDES_DISMISSED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isGuidePage) : [];
  } catch {
    return [];
  }
}

export function dismissPageGuide(page: GuidePage): GuidePage[] {
  const next = Array.from(new Set([...getDismissedPageGuides(), page]));
  try {
    localStorage.setItem(PAGE_GUIDES_DISMISSED_KEY, JSON.stringify(next));
  } /* c8 ignore next -- jsdom localStorage.setItem is non-configurable */ catch {}
  return next;
}

/**
 * PLACEHOLDER — the per-page guided steps are not built yet. This is the
 * single entry point the banner's "Take the tour" wires to; a follow-up
 * replaces the body with the page-specific step machine (mirroring the
 * onboarding tour in TutorialTour/tour-store).
 */
export function startPageGuide(page: GuidePage): void {
  console.warn(`[tutorial] page guide for "${page}" is not implemented yet`);
}
