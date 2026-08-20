import { defineConfig } from '@playwright/test';

/**
 * iOS Simulator E2E config — mirrors playwright.e2e.config.ts but with:
 *   - separate testDir (playwright/e2e/ios/tests)
 *   - longer per-test timeout for cold WASM compile + sync to chain tip
 *   - global setup that asserts App.app exists and reserves the device pair
 *   - separate output dir so Chrome and iOS artifacts don't collide
 */
export default defineConfig({
  testDir: './playwright/e2e/ios/tests',
  // Guardian specs run via playwright.ios.guardian.config.ts and bridge-in specs
  // via playwright.ios.bridge-in.config.ts (dedicated runs with their own setup —
  // the bridge-in deposit specs need a local Anvil this suite doesn't provide);
  // keep both out of the standard iOS suite.
  // dApp-browser specs run via playwright.ios.dapp.config.ts — they need no
  // chain, so they get their own (much faster) workflow.
  testIgnore: ['**/guardian-*.ios.spec.ts', '**/bridge-in-*.ios.spec.ts', '**/dapp-browser.*.spec.ts'],
  // 25 min per test. WASM prove on the simulator is slow (~60-90s per consume),
  // and on degraded macos-26 runners BOTH the two-sim `_simPair` setup (capped
  // at 13 min, see SETUP_DEADLINE_MS) and the test body's simctl/WASM ops crawl.
  // 25 min leaves room for a slow-but-completing setup + a slow test instead of
  // killing a run that would have passed given a little more patience (no
  // assertion is relaxed — this is purely tolerance for degraded-runner IO).
  timeout: 1_500_000,
  expect: {
    timeout: 60_000
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  maxFailures: 1,
  workers: 1,
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results-ios/results.json' }],
    ['html', { outputFolder: 'test-results-ios/html', open: 'never' }]
  ],
  globalSetup: './playwright/e2e/ios/fixtures/global-setup.ts',
  globalTeardown: './playwright/e2e/ios/fixtures/global-teardown.ts',
  use: {
    actionTimeout: 30_000,
    navigationTimeout: 90_000
  }
});
