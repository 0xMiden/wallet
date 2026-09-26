/**
 * Bottom padding for a flow page's pinned CTA: the room the tab bar takes over the page. main.css declares
 * it on TabLayout's root (`--navbar-cushion`), so only a page inside the layout that draws the bar reserves
 * it; anywhere else (a slide page beside the covered tab layer, a route with no tab bar) it is the flat
 * 1rem. main.css also collapses it to 1rem whenever the bar is down (`body[data-hide-navbar]`).
 *
 * On iOS the keyboard term is the mechanism: `--keyboard-height` and the navbar flag are both
 * written by the keyboard listener (lib/mobile/keyboard-inset) in the step that grows the page's
 * bottom inset, so the cushion and the page change in ONE reflow and the CTA makes ONE move. On
 * Android the native resize comes first, so the CTA takes two slides.
 *
 * On mobile the room is 4rem, more where the bar clears the inset (Android). Over an iPhone's home
 * indicator the bar reaches 49px into the page, so 4rem keeps the CTA 15px above it; on a home-button
 * iPhone it reaches 57px and the gap is 7px. Off-mobile the bar is a floating pill that needs 6rem.
 */
export const stepFooterCushionClass = (): string =>
  'pb-[max(1rem,calc(var(--navbar-cushion,1rem)-var(--keyboard-height,0px)))]';
