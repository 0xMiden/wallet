import { defineConfig } from '@playwright/test';

import base from './playwright.e2e.config';

// Same hermetic harness as the blockchain E2E config, but runs ONLY the
// infra-resilience specs (which the base config ignores via testIgnore). Used by
// the dedicated e2e-resilience job (push:main + nightly). Each spec arms a
// network/guardian fault via walletA.armNetworkFault(...) (harness/network-faults.ts)
// and asserts the wallet degrades / recovers gracefully.
//
// retries: 0 (not the base's localnet 3) — resilience assertions are
// correctness checks under deterministic fault arming (failFirstN + explicit
// clear), so a retry would mask a genuine non-graceful regression.
export default defineConfig({
  ...base,
  testDir: './playwright/e2e/tests/resilience',
  testIgnore: undefined,
  retries: 0
});
