import { defineConfig } from '@playwright/test';

import base from './playwright.e2e.config';

// The mainnet nightly only. The base config ignores this directory so a testnet or localhost run cannot spend these accounts.
export default defineConfig({
  ...base,
  outputDir: process.env.E2E_PLAYWRIGHT_OUTPUT_DIR ?? 'test-results',
  reporter: [['list'], ['json', { outputFile: `${process.env.E2E_PLAYWRIGHT_OUTPUT_DIR ?? 'test-results'}/results.json` }]],
  // The wallet sources a spec imports reach `@miden-sdk/miden-sdk/lazy`, which the SDK exports only under the `import`
  // condition. Playwright loads specs as CJS in Node, so that subpath cannot resolve; this maps it to the SDK's Node entry,
  // the same module the helpers get from the bare specifier.
  tsconfig: './playwright.mainnet.tsconfig.json',
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
