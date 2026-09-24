import { isMobile } from 'lib/platform';

/**
 * Bottom padding for a flow page's pinned CTA: it clears the docked tab bar (~17pt above it) on
 * every flow page, since a pushed step still lives inside TabLayout; only `body[data-hide-navbar]`
 * collapses it (main.css), whenever the bar is down.
 *
 * On iOS the keyboard term is the mechanism: `--keyboard-height` and the navbar flag are both
 * written by the keyboard listener (lib/mobile/keyboard-inset) in the step that grows the page's
 * bottom inset, so the cushion and the page change in ONE reflow and the CTA makes ONE move. On
 * Android the native resize comes first, so the CTA takes two slides.
 *
 * Off-mobile the bar is a floating pill that needs the full 6rem.
 */
export const stepFooterCushionClass = (): string =>
  isMobile()
    ? 'pb-[max(1rem,calc(4rem-var(--keyboard-height,0px)))]'
    : 'pb-[max(1rem,calc(6rem-var(--keyboard-height,0px)))]';
