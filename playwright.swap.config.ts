import { defineConfig } from '@playwright/test';

import base from './playwright.e2e.config';

// Same harness as the blockchain E2E config, but runs ONLY the swap specs
// (which the base config ignores via testIgnore). Used by the dedicated,
// path-filtered swap-e2e job so swap coverage doesn't run on every PR.

/**
 * Per-test budget. The base config's 300s was sized against the local 0.16 node
 * the PR job boots, whose blocks arrive on demand. A swap on public testnet
 * waits on shared infrastructure at every step - a delegated prover, real block
 * times, and a maker note that must commit WITH an inclusion proof before the
 * taker can be handed it (`exportMakerNote` alone budgets 90s for that) - so the
 * same specs need materially longer there.
 *
 * Raised rather than made per-spec so a testnet run does not fail on arithmetic
 * that is only true of a chain we control. It is a ceiling, not a delay: a fast
 * run still finishes fast.
 */
const IS_TESTNET = (process.env.E2E_NETWORK ?? 'testnet') !== 'localhost';

export default defineConfig({
  ...base,
  testDir: './playwright/e2e/tests/swap',
  // Explicitly clears the base's list rather than inheriting it: that list
  // ignores `**/swap/**`, so inheriting it here would select nothing at all.
  testIgnore: undefined,
  timeout: IS_TESTNET ? 900_000 : base.timeout,
  expect: { ...base.expect, timeout: IS_TESTNET ? 120_000 : base.expect?.timeout }
});
