import { defineConfig } from '@playwright/test';

import base from './playwright.e2e.config';

// Same harness as the blockchain E2E config, but runs ONLY the swap specs
// (which the base config ignores via testIgnore). Used by the dedicated,
// path-filtered swap-e2e job so swap coverage doesn't run on every PR.
export default defineConfig({
  ...base,
  testDir: './playwright/e2e/tests/swap',
  // Explicitly clears the base's list rather than inheriting it: that list
  // ignores `**/swap/**`, so inheriting it here would select nothing at all.
  testIgnore: undefined
});
