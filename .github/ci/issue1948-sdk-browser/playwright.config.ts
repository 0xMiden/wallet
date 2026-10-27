import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: ['indexeddb_safety.browser.test.ts'],
  timeout: 240_000,
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  workers: 2,
  reporter: [['list'], ['json', { outputFile: process.env.SDK_BROWSER_RESULT_FILE }]],
  outputDir: process.env.SDK_BROWSER_OUTPUT_DIR,
  use: { headless: true, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
