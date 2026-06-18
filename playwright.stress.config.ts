import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the random stress suite.
 *
 * Separate from `playwright.e2e.config.ts` so stress runs don't clobber the
 * regular E2E `test-results/` directory and so we can opt out of per-test
 * timeouts without affecting the standard suite.
 */
export default defineConfig({
  testDir: './playwright/e2e/stress',
  timeout: 0, // driver's STRESS_NUM_NOTES is the stop condition
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
    ['json', { outputFile: 'test-results-stress/results.json' }],
  ],
  outputDir: 'test-results-stress',
  use: {
    headless: false,
    trace: 'on',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
