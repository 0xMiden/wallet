/**
 * Bottom-sheet motion: the tab-bar springs, expressed as CSS so vaul can run them.
 *
 * Every sheet in the app should open and close with the same feel as switching nav tabs - bouncy
 * on the way in, snappy on the way out - rather than vaul's stock half-second tween. vaul drives
 * the sheet with a CSS `animation` (open/close) and an inline `transition` (the drag-release
 * snap-back), so the spring cannot be a framer transition here: it has to be CSS.
 *
 * The open and close run as `@keyframes` sampled from the spring (`springKeyframeStops`) with
 * `linear` timing between stops. Measured on an iPhone 17 Pro Max (#1841), WebKit runs the same
 * spring as a `linear()` timing function at 60 fps, while sampled keyframes run at 117-120 fps, so
 * `linear()` does NOT hand the curve to the compositor there. `springToLinearEasing` still supplies
 * the `--sheet-*-easing` vars, which the overlay fade and vaul's drag-release snap-back read.
 *
 * Duration depends on the distance travelled, so the curves are solved once against a nominal
 * sheet travel. A shorter sheet settles a little sooner than the curve says and a taller one a
 * little later; neither is perceptible, and solving per sheet would mean measuring the element
 * before it is on screen.
 *
 * Reduced motion is NOT handled here: the `prefers-reduced-motion` block in `main.css` clamps
 * every vaul duration to nothing, which covers these curves along with vaul's own.
 */

import { springKeyframeStops, springToLinearEasing, supportsLinearEasing } from './spring-easing';
import { springs } from './springs';

/** Nominal sheet travel, near the 80vh cap `DrawerContent` sets on a phone. */
const SHEET_TRAVEL_PX = 420;

/** vaul's own stock curve, kept as the fallback the CSS variables declare. */
const FALLBACK = { durationMs: 500, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' };

export interface SheetCurve {
  /** The sampled spring's duration, which the keyframes span. */
  durationMs: number;
  /** A CSS timing function: `linear(...)` tracing the spring, or the fallback cubic-bezier. */
  easing: string;
}

type Spring = Parameters<typeof springToLinearEasing>[0];

function curve(transition: Spring): SheetCurve {
  // The keyframes span the sampled duration whether or not the engine parses linear().
  const durationMs = springKeyframeStops(transition, { distance: SHEET_TRAVEL_PX })?.duration ?? FALLBACK.durationMs;
  // An unparsed linear() is dropped from the declaration, which would leave the overlay no curve.
  if (!supportsLinearEasing()) return { durationMs, easing: FALLBACK.easing };
  const solved = springToLinearEasing(transition, { distance: SHEET_TRAVEL_PX });
  return { durationMs, easing: solved ? solved.easing : FALLBACK.easing };
}

/**
 * Both curves come from the tab bar, so a sheet feels like switching tabs, at 1.25 times the
 * duration because a sheet travels farther. `open` is the highlight spring's shape (`sheetOpen`):
 * ~440ms with one visible 7% overshoot past the resting edge, which vaul's `::after` skirt covers.
 * `close` is the icon-pop spring's shape (`sheetClose`): ~280ms and effectively flat, so dismissing
 * is quick and does not wobble on its way out. The drag-release snap-back uses `open`, since that is
 * the sheet returning to rest.
 */
export const sheetMotion = {
  open: curve(springs.sheetOpen),
  close: curve(springs.sheetClose)
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

const KEYFRAMES_ELEMENT_ID = 'miden-sheet-keyframes';

const round = (value: number) => Number(value.toFixed(4));

/**
 * One `@keyframes` block over the sheet's `translate3d`, as a fraction of `--initial-transform`
 * (vaul sets it on the sheet; 100% is fully offscreen). `closing` omits the 0% stop, so the sheet
 * leaves from wherever it is, as vaul's own `slideToBottom` does with only a `to`.
 */
function keyframes(name: string, transition: Spring, closing: boolean): string {
  const sampled = springKeyframeStops(transition, { distance: SHEET_TRAVEL_PX });
  if (!sampled) return '';
  const body = sampled.stops
    .filter(stop => !(closing && stop.offset === 0))
    .map(({ offset, progress }) => {
      const factor = round(closing ? progress : 1 - progress);
      return `  ${round(offset * 100)}% { transform: translate3d(0, calc(var(--initial-transform, 100%) * ${factor}), 0); }`;
    })
    .join('\n');
  return `@keyframes ${name} {\n${body}\n}`;
}

/** The open and close keyframes `main.css` points a bottom sheet at. */
export function sheetKeyframesCss(): string {
  return [
    keyframes('miden-sheet-open', springs.sheetOpen, false),
    keyframes('miden-sheet-close', springs.sheetClose, true)
  ].join('\n');
}

/** Idempotent, so every sheet may call it; the keyframes are global CSS. */
export function installSheetKeyframes(doc: Document = document): void {
  const css = sheetKeyframesCss();
  const existing = doc.getElementById(KEYFRAMES_ELEMENT_ID);
  if (existing) {
    if (existing.textContent !== css) existing.textContent = css;
    return;
  }
  const style = doc.createElement('style');
  style.id = KEYFRAMES_ELEMENT_ID;
  style.textContent = css;
  doc.head.appendChild(style);
}
