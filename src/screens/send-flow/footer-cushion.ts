import { isMobile } from 'lib/platform';

/**
 * Bottom padding for a send step's CTA footer while the tab bar is showing (the
 * recipient step): the CTA sits ~17pt above the docked bar. Once the bar hides
 * (later steps, or the keyboard up) SendStepLayout drops the CTA to the bottom
 * instead. The class is keyboard-aware as a fallback, collapsing to 1rem.
 *
 * Off-mobile the bar is a floating pill that needs the full 6rem.
 */
export const stepFooterCushionClass = (): string =>
  isMobile()
    ? 'pb-[max(1rem,calc(4rem-var(--keyboard-height,0px)))]'
    : 'pb-[max(1rem,calc(6rem-var(--keyboard-height,0px)))]';
