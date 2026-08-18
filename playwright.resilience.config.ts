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
  // Deliberately NOT the base's testIgnore (it excludes this whole directory);
  // this list is only the 0.16 guardian quarantine (#522), applied at the same
  // spec-selection layer as playwright.swap.config.ts's: the three
  // `guardian-*.spec.ts` resilience specs create a guardian account, which fails
  // on SDK 0.16 (@openzeppelin/miden-multisig-client has no protocol-0.16
  // release). None of them self-skips, and with the base's `maxFailures: 3` on
  // localnet their three failures abort the run before `network-faults-policy`
  // and `node-outage-recovery` — the only automated guard that a node outage
  // hides no funds — ever execute. Remove this once OZ ships a protocol-0.16
  // client, so a red run means a real infra-resilience regression.
  testIgnore: ['**/guardian-*.spec.ts'],
  retries: 2
});
