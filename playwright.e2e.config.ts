import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './playwright/e2e/tests',
  timeout: 300_000, // 5 min per test (blockchain ops are slow)
  expect: {
    timeout: 60_000,
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,        // No retries -- fail fast, diagnose from report.json
  maxFailures: 1,    // Stop entire suite on first spec failure
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
    headless: false, // Extensions require headed mode
    trace: 'on', // Always record traces for debugging
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
