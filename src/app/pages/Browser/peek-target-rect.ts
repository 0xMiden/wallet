export interface SlotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// When the live slot rect isn't available (no dApp has been foregrounded
// this session yet AND nothing is cached), fall back to a computed slot
// that matches DappActive's layout:
//   - FALLBACK_CAPSULE_HEIGHT (145): safe-area-inset-top (~62) + the
//     capsule's drag handle + content row (83).
//   - the router's network banner (#875), measured: PageRouter renders it
//     above every page on test networks and renders nothing on mainnet.
//   - FALLBACK_BOTTOM_GUTTER (34): safe-area-inset-bottom on devices
//     with a home indicator. Subtract the bottom safe area directly as
//     a constant instead of trying to derive it from live CSS.
// These defaults are iPhone 17-class. Other devices differ slightly
// but the cache (populated the moment a dApp is foregrounded) covers
// every case after the first restore.
export const FALLBACK_CAPSULE_HEIGHT = 145;
export const FALLBACK_BOTTOM_GUTTER = 34;
// NetworkModeBanner.test pins this to the rendered banner.
export const NETWORK_BANNER_SELECTOR = '[data-testid="network-mode-banner"]';

const isMeasured = (rect: SlotRect | null): rect is SlotRect => !!rect && rect.width > 0 && rect.height > 0;

/**
 * The rect a restored bubble's expand animation lands on: the live slot if it has been measured,
 * else the last measured one, else the fallback.
 */
export function resolveTargetRect(liveSlotRect: SlotRect | null, cachedSlotRect: SlotRect | null): SlotRect {
  if (isMeasured(liveSlotRect)) return liveSlotRect;
  if (isMeasured(cachedSlotRect)) return cachedSlotRect;
  const banner = document.querySelector<HTMLElement>(NETWORK_BANNER_SELECTOR)?.offsetHeight ?? 0;
  const top = FALLBACK_CAPSULE_HEIGHT + banner;
  return {
    x: 0,
    y: top,
    width: window.innerWidth,
    height: window.innerHeight - top - FALLBACK_BOTTOM_GUTTER
  };
}
