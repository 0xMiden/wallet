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
  testMatch: '**/bridge-in-*.ios.spec.ts'
});
