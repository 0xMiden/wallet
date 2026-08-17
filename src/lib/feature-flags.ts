import { MOONPAY_API_KEY } from 'lib/fiat-ramp/moonpay';

/**
 * In-app swap (the In-Protocol DEX / PSWAP flow) availability.
 *
 * Swap is enabled on every platform, including iOS. It was previously disabled
 * on iOS for App Store Review Guideline 3.1.5(iii) — Apple App Review read an
 * in-app crypto swap as a "cryptocurrency exchange service" — and is re-enabled
 * here now that the iOS build ships swap for distribution.
 *
 * This is the single source of truth for swap availability — the swap tab, the
 * home swipe pane, the `/swap` route, and the featured swap dApps all read it.
 * To gate swap again (per-platform, per-region, or behind a remote flag),
 * change only this function.
 */
export function isSwapEnabled(): boolean {
  return true;
}

/**
 * Receive-from-EVM bridge deposit (bridge-IN) availability.
 *
 * Enabled on every platform — the "Cross Chain" deposit button on the Receive
 * page and the `/bridge/deposit` screen now ship to users (previously hidden
 * pending launch behind `MIDEN_E2E_TEST` / `MIDEN_ENABLE_BRIDGE_UI`).
 *
 * This is the single source of truth for the deposit entry — the Receive "Cross
 * Chain" button and the `/bridge/deposit` route both read it. Send-to-EVM
 * (bridge-OUT) is intentionally NOT gated: it has no discoverable entry point
 * (it only triggers when a user types a 0x recipient address). To gate the
 * deposit UI again (per-platform, per-region, or behind a remote flag), change
 * only this function.
 */
export function isBridgeDepositEnabled(): boolean {
  return true;
}

/**
 * Fiat on-ramp (Buy) availability.
 *
 * Enabled only when a MoonPay API key is baked into the build
 * (`MOONPAY_API_KEY`) — builds without one hide the feature entirely. This is
 * the single source of truth for the ramp entry points — the home-screen Buy
 * button and the `/buy` route both read it. Note the button additionally
 * requires the current account to have a derived `evmAddress` (imported
 * accounts don't).
 */
export function isFiatRampEnabled(): boolean {
  return MOONPAY_API_KEY.length > 0;
}
