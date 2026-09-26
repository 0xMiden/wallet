import { isMobile } from 'lib/platform';

/**
 * Bottom padding for a flow page's pinned CTA: it clears the docked tab bar on every flow page, since
 * a pushed step still lives inside TabLayout. main.css collapses it to 1rem whenever the bar is down
 * (`body[data-hide-navbar]`) or no TabLayout is mounted (no `body[data-navbar-mounted]`).
 *
 * On iOS the keyboard term is the mechanism: `--keyboard-height` and the navbar flag are both
 * written by the keyboard listener (lib/mobile/keyboard-inset) in the step that grows the page's
 * bottom inset, so the cushion and the page change in ONE reflow and the CTA makes ONE move. On
 * Android the native resize comes first, so the CTA takes two slides.
 *
 * On mobile the room is main.css's `--navbar-cushion`, 4rem unless TabLayout marks the body for a bar
 * that clears the inset (Android). Over an iPhone's home indicator the bar reaches 49px into the page,
 * so 4rem keeps the CTA 15px above it; on a home-button iPhone it reaches 57px and the gap is 7px.
 * Off-mobile the bar is a floating pill that needs the full 6rem.
 */
export const stepFooterCushionClass = (): string =>
  isMobile()
    ? 'pb-[max(1rem,calc(var(--navbar-cushion,4rem)-var(--keyboard-height,0px)))]'
    : 'pb-[max(1rem,calc(6rem-var(--keyboard-height,0px)))]';
