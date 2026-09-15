import { defineConfig } from '@playwright/test';

import base from './playwright.e2e.config';

// Same hermetic harness as the blockchain E2E config, but runs ONLY the
// infra-resilience specs (which the base config ignores via testIgnore). Used by
// the dedicated e2e-resilience job (push:main + nightly). Each spec arms a
// network/guardian fault via walletA.armNetworkFault(...) (harness/network-faults.ts)
// and asserts the wallet degrades / recovers gracefully.
//
// retries: 2. Nuance learned the hard way: the resilience ASSERTIONS are
// deterministic (a fault is armed with failFirstN/explicit-clear, so a genuine
// non-graceful regression fails on EVERY attempt — a retry can't mask it). What
// is NOT deterministic is the SETUP: wallet onboarding drives real proofs through
// the single serial local/CI prover, and under back-to-back load a later one can
// exceed the page object's wait — the same prover-timing hiccup pr-e2e-local
// absorbs with `--retries=1`. So a small retry budget covers setup without ever
// masking a real resilience bug (deterministic under the armed fault, red across
// every attempt). The flaky-report step surfaces any retried-then-passed spec.
export default defineConfig({
  ...base,
  testDir: './playwright/e2e/tests/resilience',
  // Explicitly clears the base's list rather than inheriting it: that list
  // ignores both `**/resilience/**` and `**/guardian-*.spec.ts`, so inheriting
  // it here would select nothing at all. This suite's whole subject is the
  // resilience directory, guardian specs included.
  testIgnore: undefined,
  retries: 2
});
