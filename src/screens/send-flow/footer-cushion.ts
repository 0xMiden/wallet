import { isMobile } from 'lib/platform';

/**
 * Bottom padding for a send step's CTA footer.
 *
 * Every step puts its CTA at the same height, whether or not the tab bar is
 * showing: the recipient step keeps the docked bar (the CTA sits ~17pt above
 * it), later steps hide it and the CTA stays put. So this footer does NOT carry
 * `data-navbar-cushion`, whose CSS collapses the cushion whenever the bar hides.
 * Only the soft keyboard shrinks it, down to 1rem above the keyboard.
 *
 * Off-mobile the bar is a floating pill that needs the full 6rem.
 */
export const stepFooterCushionClass = (): string =>
  isMobile()
    ? 'pb-[max(1rem,calc(4rem-var(--keyboard-height,0px)))]'
    : 'pb-[max(1rem,calc(6rem-var(--keyboard-height,0px)))]';
