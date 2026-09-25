/**
 * Bottom-sheet motion: the tab-bar springs, expressed as CSS so vaul can run them.
 *
 * Every sheet in the app should open and close with the same feel as switching nav tabs — bouncy
 * on the way in, snappy on the way out — rather than vaul's stock half-second tween. vaul drives
 * the sheet with a CSS `animation` (open/close) and an inline `transition` (the drag-release
 * snap-back), so the spring cannot be a framer transition here: it has to be a curve CSS can
 * consume. `springToLinearEasing` solves the spring analytically and emits it as `linear()`, which
 * keeps the overshoot and hands the whole thing to the compositor.
 *
 * Duration depends on the distance travelled, so the curves are solved once against a nominal
 * sheet travel. A shorter sheet settles a little sooner than the curve says and a taller one a
 * little later; neither is perceptible, and solving per sheet would mean measuring the element
 * before it is on screen.
 *
 * Reduced motion is NOT handled here: the `prefers-reduced-motion` block in `main.css` clamps
 * every vaul duration to nothing, which covers these curves along with vaul's own.
 */

import { springToLinearEasing, supportsLinearEasing } from './spring-easing';
import { springs } from './springs';

/** Nominal sheet travel, near the 80vh cap `DrawerContent` sets on a phone. */
const SHEET_TRAVEL_PX = 420;

/** vaul's own stock curve, kept as the fallback the CSS variables declare. */
const FALLBACK = { durationMs: 500, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' };

export interface SheetCurve {
  durationMs: number;
  /** A CSS timing function: `linear(...)` tracing the spring, or the fallback cubic-bezier. */
  easing: string;
}

function curve(transition: Parameters<typeof springToLinearEasing>[0]): SheetCurve {
  // An unparsed linear() is dropped from the declaration, which would leave the sheet no curve.
  if (!supportsLinearEasing()) return FALLBACK;
  const solved = springToLinearEasing(transition, { distance: SHEET_TRAVEL_PX });
  return solved ? { durationMs: solved.duration, easing: solved.easing } : FALLBACK;
}

/**
 * Both curves come from the tab bar, so a sheet feels like switching tabs. `open` is the highlight
 * spring (`tabSwitch`): ~350ms with one visible 7% overshoot past the resting edge, which vaul's
 * `::after` skirt covers. `close` is the icon-pop spring (`tabIconPop`): ~225ms and effectively
 * flat, so dismissing is quick and does not wobble on its way out. The drag-release snap-back uses
 * `open`, since that is the sheet returning to rest.
 */
export const sheetMotion = {
  open: curve(springs.tabSwitch),
  close: curve(springs.tabIconPop)
};

/**
 * The curves as CSS custom properties, for the elements `main.css` styles by their vaul data
 * attributes (`[data-vaul-drawer]`, `[data-vaul-overlay]`). Spread onto both the sheet and its
 * backdrop so the two run on one timing.
 */
export const sheetMotionVars: Record<string, string> = {
  '--sheet-open-duration': `${sheetMotion.open.durationMs}ms`,
  '--sheet-open-easing': sheetMotion.open.easing,
  '--sheet-close-duration': `${sheetMotion.close.durationMs}ms`,
  '--sheet-close-easing': sheetMotion.close.easing
};
