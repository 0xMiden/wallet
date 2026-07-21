import { isIOS } from 'lib/platform';

/**
 * In-app swap (the In-Protocol DEX / PSWAP flow) is disabled on iOS.
 *
 * Apple App Review treats an in-app crypto swap as a "cryptocurrency exchange
 * service" under App Store Review Guideline 3.1.5(iii), which requires
 * per-storefront licensing the app does not currently hold. Until that
 * compliance work is done, the iOS build ships as a pure non-custodial wallet
 * with no exchange surface. Every other platform (Android, browser extension,
 * desktop) keeps swap.
 *
 * This is the single source of truth for swap availability — the swap tab, the
 * home swipe pane, and the `/swap` route all read it. To re-enable swap on iOS
 * (e.g. once it is cleared for distribution, or behind a region/remote flag),
 * change only this function.
 */
export function isSwapEnabled(): boolean {
  return !isIOS();
}
