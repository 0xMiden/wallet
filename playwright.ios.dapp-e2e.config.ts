import { defineConfig } from '@playwright/test';

import base from './playwright.ios.config';

/**
 * The dApp E2E journey in the iOS in-app browser (spec section 3, PL1): a live network, two simulators, and records
 * judged like the Chrome legs' (scripts/render-dapp-matrix.mjs). e2e-dapp.yml's dapp-e2e-ios job runs it. Each journey
 * sets its own timeout (JOURNEY_TIMEOUT_MS.PL); a red cell is a record, so no run stops early.
 */
export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: '**/dapp-inapp.*.spec.ts',
  maxFailures: 0,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  globalSetup: './playwright/e2e/ios/fixtures/dapp-e2e-global-setup.ts'
});
