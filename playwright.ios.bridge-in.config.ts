import { defineConfig } from '@playwright/test';

import base from './playwright.ios.config';

// Same harness as the iOS E2E config, but runs ONLY the bridge-in specs (which
// the base iOS config ignores). The deposit specs boot a local Anvil and use a
// WalletConnect counterparty that the standard mobile suite doesn't set up, so
// they run here in the dedicated Bridge-IN E2E job. Mirrors
// playwright.ios.guardian.config.ts. Run with: yarn test:e2e:mobile:bridge-in:run.
export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: '**/bridge-in-*.ios.spec.ts',
  // Every spec runs even after one failed: with the base config's maxFailures 1, one failed spec hid every spec after
  // that one (the Reown pairing spec did not run from 2026-10-14 to 2026-10-17).
  maxFailures: 0,
  // The app reads the served config document (MIDEN_REMOTE_CONFIG_URL) as it launches, so the
  // suite's own setup serves it for the whole run, next to the base setup's simulator pair.
  globalSetup: [
    './playwright/e2e/ios/fixtures/global-setup.ts',
    './playwright/e2e/ios/fixtures/bridge-in-global-setup.ts'
  ]
});
