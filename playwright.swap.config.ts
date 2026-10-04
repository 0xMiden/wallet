import { defineConfig } from '@playwright/test';

import base, { isLocalnet } from './playwright.e2e.config';

// Same harness as the blockchain E2E config, but runs ONLY the swap specs
// (which the base config ignores via testIgnore). Used by the dedicated
// swap-e2e job on main and workflow_dispatch, not on pull_request.

/**
 * Per-test budget. On the local node the base config's 300s is too tight: since the
 * chain charges fees (#806), `fundSwapPair` proves eight CLI transactions (two
 * faucet deploys, then a fee transfer and a mint per wallet) and takes 170-240s on
 * the 2-vCPU runner before the swap starts, and the swap itself takes another
 * 65-70s. Green runs finished the full fills and the cancel in 264-294s, so a slow
 * runner timed both attempts of both full fills out mid-settlement. 420s leaves
 * that tail its margin; guardian and partial-fill set their own 720s.
 *
 * A swap on public testnet waits on shared infrastructure at every step - a
 * delegated prover, real block times, and a maker note that must commit WITH an
 * inclusion proof before the taker can be handed it (`exportMakerNote` alone
 * budgets 90s for that) - so the same specs need materially longer there.
 *
 * Raised rather than made per-spec so a testnet run does not fail on arithmetic
 * that is only true of a chain we control. It is a ceiling, not a delay: a fast
 * run still finishes fast.
 */
export default defineConfig({
  ...base,
  testDir: './playwright/e2e/tests/swap',
  // Explicitly clears the base's list rather than inheriting it: that list
  // ignores `**/swap/**`, so inheriting it here would select nothing at all.
  testIgnore: undefined,
  timeout: isLocalnet ? 420_000 : 900_000,
  expect: { ...base.expect, timeout: isLocalnet ? base.expect?.timeout : 120_000 }
});
