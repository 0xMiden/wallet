import { defineConfig } from '@playwright/test';

import base from './playwright.e2e.config';

// Same harness as the blockchain E2E config, but runs ONLY the live USDCx suites, which the base config ignores.
// `yarn e2e:real --suite usdcx|usdcx-in|usdcx-burn` is its only caller; no workflow runs it. An hour per test because
// Playwright charges test-scoped fixture setup (wallet A and the CLI it depends on) to the test's own budget.
export default defineConfig({
  ...base,
  testDir: './playwright/e2e/tests/usdcx',
  testIgnore: undefined,
  timeout: 3_600_000
});
