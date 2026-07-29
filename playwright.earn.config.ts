import { defineConfig } from '@playwright/test';

import base from './playwright.e2e.config';

// Same harness as the blockchain E2E config, but runs ONLY the earn specs
// (which the base config ignores via testIgnore). Used by the dedicated
// pr-e2e-earn job. Covers deposit AND withdraw: each spec stands up the fake
// Epoch allocator (:8548) + positions (:8549) services and a local Anvil
// (:8545, Mock USDC/Compact stubs) for the EVM reads the Epoch SDK makes
// (deposit's Compact status; withdraw's gasless-batch USDC/Compact reads).
export default defineConfig({
  ...base,
  testDir: './playwright/e2e/tests/earn',
  testIgnore: undefined
});
