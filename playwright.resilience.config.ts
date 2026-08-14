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
// non-graceful regression fails on EVERY attempt — a retry can't mask it). But
// the guardian specs' SETUP — `createGuardianWallet` onboarding — is NOT
// deterministic: it drives real proofs through the single serial local/CI prover,
// and when several guardian specs run back-to-back the prover backs up and a
// later onboarding can exceed the page-object's 120s wait. That is the exact
// prover-timing flake the base localnet config already carries retries for. So a
// small retry budget absorbs the onboarding flake without ever masking a real
// resilience bug (which is deterministic under the armed fault and stays red
// across retries). The flaky-report step surfaces any retried-then-passed spec.
export default defineConfig({
  ...base,
  testDir: './playwright/e2e/tests/resilience',
  testIgnore: undefined,
  retries: 2
});
