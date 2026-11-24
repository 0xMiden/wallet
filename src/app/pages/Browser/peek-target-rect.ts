import type { MorphCard } from '@miden/dapp-browser';

import { CARD_HEIGHT, CARD_WIDTH } from './DappPeekCard';

/** The peek card's corner radius (`rounded-2xl`), the one the native morph lands with. */
export const CARD_CORNER_RADIUS = 16;

export interface SlotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// When the live slot rect isn't available (no dApp has been foregrounded
// this session yet AND nothing is cached), fall back to a computed slot
// that matches DappActive's layout:
//   - FALLBACK_CAPSULE_HEIGHT (121): safe-area-inset-top (~62) + the
//     capsule's content row and hairline (57) + the progress bar (2).
//     Nothing tops the page above it: the test network is named in Home's
//     pill, not a banner.
//   - FALLBACK_BOTTOM_GUTTER (34): safe-area-inset-bottom on devices
//     with a home indicator. Subtract the bottom safe area directly as
//     a constant instead of trying to derive it from live CSS.
// These defaults are iPhone 17-class. Other devices differ slightly
// but the cache (populated the moment a dApp is foregrounded) covers
// every case after the first restore.
export const FALLBACK_CAPSULE_HEIGHT = 121;
export const FALLBACK_BOTTOM_GUTTER = 34;

const isMeasured = (rect: SlotRect | null): rect is SlotRect => !!rect && rect.width > 0 && rect.height > 0;

/**
 * The rect a restored bubble's expand animation lands on: the live slot if it has been measured,
 * else the last measured one, else the fallback.
 */
export function resolveTargetRect(liveSlotRect: SlotRect | null, cachedSlotRect: SlotRect | null): SlotRect {
  if (isMeasured(liveSlotRect)) return liveSlotRect;
  if (isMeasured(cachedSlotRect)) return cachedSlotRect;
  return {
    x: 0,
    y: FALLBACK_CAPSULE_HEIGHT,
    width: window.innerWidth,
    height: window.innerHeight - FALLBACK_CAPSULE_HEIGHT - FALLBACK_BOTTOM_GUTTER
  };
}

/** The front card's rect in the tray's measured box: the card sits at its bottom-right corner. */
export function frontCardRect(tray: DOMRect): MorphCard {
  return {
    x: tray.right - CARD_WIDTH,
    y: tray.bottom - CARD_HEIGHT,
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    cornerRadius: CARD_CORNER_RADIUS
  };
}
