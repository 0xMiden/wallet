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
  timeout: 900_000, // 15 min per test — WASM prove on simulator is slow (~60-90s per consume)
  expect: {
    timeout: 60_000,
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  maxFailures: 1,
  workers: 1,
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results-ios/results.json' }],
    ['html', { outputFolder: 'test-results-ios/html', open: 'never' }],
  ],
  globalSetup: './playwright/e2e/ios/fixtures/global-setup.ts',
  globalTeardown: './playwright/e2e/ios/fixtures/global-teardown.ts',
  use: {
    actionTimeout: 30_000,
    navigationTimeout: 90_000,
  },
});
