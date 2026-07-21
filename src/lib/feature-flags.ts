import { isIOS } from 'lib/platform';

/**
 * In-app swap (the In-Protocol DEX / PSWAP flow) is disabled on iOS by
 * default.
 *
 * Apple App Review treats an in-app crypto swap as a "cryptocurrency exchange
 * service" under App Store Review Guideline 3.1.5(iii), which requires
 * per-storefront licensing the app does not currently hold. Until that
 * compliance work is done, the iOS build ships as a pure non-custodial wallet
 * with no exchange surface. Every other platform (Android, browser extension,
 * desktop) keeps swap.
 *
 * For internal testing only, developers can explicitly include swap in the
 * iOS bundle with `yarn mobile:ios --includeSwapForIos true`. The launcher
 * converts that flag into a build-time constant; normal and release builds
 * remain gated.
 *
 * This is the single source of truth for swap availability — the swap tab,
 * home swipe pane, and `/swap` route all read it.
 */
export function isSwapEnabled(): boolean {
  return !isIOS() || process.env.MIDEN_INCLUDE_SWAP_FOR_IOS === 'true';
}
