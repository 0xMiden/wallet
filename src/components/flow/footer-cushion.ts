import { isMobile } from 'lib/platform';

/**
 * Bottom padding for the pinned CTA on a flow page that has the docked tab bar under it (a tab
 * root: Send's recipient step, the swap amounts page): the CTA sits ~17pt above the bar. `FlowFooter`
 * drops every other flow page's CTA to the bottom instead, since nothing is under it to clear.
 *
 * The keyboard term is the whole mechanism, not a fallback: `--keyboard-height` is written by the
 * `keyboardWillShow`/`WillHide` listeners (lib/mobile/keyboard-inset) in the same step that grows
 * the page's bottom inset, so the cushion collapses to 1rem and the page shrinks in ONE reflow and
 * the CTA makes ONE move.
 *
 * Off-mobile the bar is a floating pill that needs the full 6rem.
 */
export const stepFooterCushionClass = (): string =>
  isMobile()
    ? 'pb-[max(1rem,calc(4rem-var(--keyboard-height,0px)))]'
    : 'pb-[max(1rem,calc(6rem-var(--keyboard-height,0px)))]';
