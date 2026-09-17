import { isMobile } from 'lib/platform';

/**
 * Bottom padding for a send step's CTA footer, reserving room for the tab bar.
 *
 * Mobile docks the bar to the bottom edge, where it rises ~47pt into the
 * screen; 4rem leaves the CTA ~17pt above it on an iPhone 17 Pro. Off-mobile the bar is a floating pill
 * that needs the full 6rem. The keyboard-aware variant collapses the cushion
 * while the soft keyboard is up.
 */
export const footerCushionClass = (keyboardAware: boolean): string => {
  if (isMobile()) {
    return keyboardAware ? 'pb-[max(0px,calc(4rem-var(--keyboard-height,0px)))]' : 'pb-16';
  }
  return keyboardAware ? 'pb-[max(0px,calc(6rem-var(--keyboard-height,0px)))]' : 'pb-24';
};
