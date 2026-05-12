import { defineConfig } from '@playwright/test';

/**
 * Android Emulator E2E config — mirrors playwright.ios.config.ts. Test
 * artifacts go under `test-results-android/` so they don't collide with
 * iOS or Chrome runs.
 */
export default defineConfig({
  testDir: './playwright/e2e/android/tests',
  // Same 15-min ceiling as iOS — Android emulator on Apple Silicon is
  // comparable to iOS sim for our prove workload.
  timeout: 900_000,
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
    ['json', { outputFile: 'test-results-android/results.json' }],
    ['html', { outputFolder: 'test-results-android/html', open: 'never' }],
  ],
  globalSetup: './playwright/e2e/android/fixtures/global-setup.ts',
  globalTeardown: './playwright/e2e/android/fixtures/global-teardown.ts',
  use: {
    actionTimeout: 30_000,
    navigationTimeout: 90_000,
  },
});
