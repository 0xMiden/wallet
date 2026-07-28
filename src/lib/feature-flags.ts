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
 * In-app Earn (the DeFi vaults / positions flow) availability.
 *
 * Earn is built but not yet exposed to users, so it is disabled here — most
 * visibly it keeps the unfinished Earn pane out of the home swipe carousel,
 * where it was reachable by swiping.
 *
 * This is the single source of truth for Earn visibility — the home swipe pane
 * and the top action-bar segment both read it. To ship Earn, flip this to true
 * (the `/earn` routes already exist).
 */
export function isEarnEnabled(): boolean {
  return false;
}

/**
 * Receive-from-EVM bridge deposit (bridge-IN) availability.
 *
 * The deposit entry — the "Cross Chain" button on the Receive page and the
 * `/bridge/deposit` screen — is hidden from users pending launch, like Earn.
 * Unlike Earn it stays enabled in the E2E build (`MIDEN_E2E_TEST=true`) so the
 * bridge-in e2e jobs keep exercising the flow with zero test changes, and can be
 * force-enabled in a dev / staging build via `MIDEN_ENABLE_BRIDGE_UI` for manual
 * testing.
 *
 * This is the single source of truth for the deposit entry — the Receive "Cross
 * Chain" button and the `/bridge/deposit` route both read it. Send-to-EVM
 * (bridge-OUT) is intentionally NOT gated: it has no discoverable entry point
 * (it only triggers when a user types a 0x recipient address). To ship the
 * deposit UI, make this return true unconditionally.
 *
 * Both env vars are statically replaced by Vite (`define`), so a production
 * build compiles this to a constant `false` and the entry points never render.
 */
export function isBridgeDepositEnabled(): boolean {
  return process.env.MIDEN_E2E_TEST === 'true' || process.env.MIDEN_ENABLE_BRIDGE_UI === 'true';
}
