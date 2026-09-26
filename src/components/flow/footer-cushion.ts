import { isAndroid, isMobile } from 'lib/platform';

/**
 * Bottom padding for a flow page's pinned CTA: it clears the docked tab bar (~15px above it) on
 * every flow page, since a pushed step still lives inside TabLayout. main.css collapses it to 1rem
 * whenever the bar is down (`body[data-hide-navbar]`) or no TabLayout is mounted (no
 * `body[data-navbar-mounted]`).
 *
 * On iOS the keyboard term is the mechanism: `--keyboard-height` and the navbar flag are both
 * written by the keyboard listener (lib/mobile/keyboard-inset) in the step that grows the page's
 * bottom inset, so the cushion and the page change in ONE reflow and the CTA makes ONE move. On
 * Android the native resize comes first, so the CTA takes two slides.
 *
 * The docked bar reaches 49px into the page on an iPhone, whose tabs dip into the home indicator. On
 * Android the tabs stay 8px above the system navigation bar (BottomNav `clearInset`), so it reaches
 * 57px plus the inset, up to 16px: 73px over a navigation bar, 57px where the WebView reports none.
 * Each cushion keeps the CTA 15px above the bar. Off-mobile the bar is a floating pill that needs the
 * full 6rem.
 */
export const stepFooterCushionClass = (): string => {
  if (!isMobile()) return 'pb-[max(1rem,calc(6rem-var(--keyboard-height,0px)))]';
  return isAndroid()
    ? 'pb-[max(1rem,calc(4.5rem+min(1rem,env(safe-area-inset-bottom))-var(--keyboard-height,0px)))]'
    : 'pb-[max(1rem,calc(4rem-var(--keyboard-height,0px)))]';
};
