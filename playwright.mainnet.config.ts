import { defineConfig } from '@playwright/test';

import base from './playwright.e2e.config';

// The mainnet nightly only. The base config ignores this directory so a testnet or localhost run cannot spend these accounts.
export default defineConfig({
  ...base,
  testDir: './playwright/e2e/tests/mainnet',
  testIgnore: undefined,
  timeout: 1_200_000,
  use: {
    ...base.use,
    // These accounts are long-lived mainnet keys. A trace records navigation and fills.
    trace: 'off',
    video: 'off',
    screenshot: 'off'
  }
});
