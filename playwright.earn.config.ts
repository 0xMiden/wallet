import { defineConfig } from '@playwright/test';

import base from './playwright.e2e.config';

// Same harness as the blockchain E2E config, but runs ONLY the earn specs
// (which the base config ignores via testIgnore). Used by the dedicated
// pr-e2e-earn job. Deposit-only for now — the spec stands up the fake Epoch
// allocator (:8548) + positions (:8549) services and a local Anvil (:8545,
// Compact stub) that the deposit's single EVM read needs. Withdraw scenarios
// land in phase 2.
export default defineConfig({
  ...base,
  testDir: './playwright/e2e/tests/earn',
  testIgnore: undefined
});
