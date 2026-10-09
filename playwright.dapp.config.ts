import { defineConfig } from '@playwright/test';

import base from './playwright.e2e.config';

// Runs only the dApp journeys, which the base config ignores. maxFailures is 0 on every network: known-red cells
// fail most journeys on main, and a run that stops early reports nothing about the journeys after it. Every run is
// on a live network, and the workflow bounds its faucet spend with the grant probe and INFRA_ABORT instead.
export default defineConfig({
  ...base,
  testDir: './playwright/e2e/tests/dapp',
  testIgnore: undefined,
  maxFailures: 0
});
