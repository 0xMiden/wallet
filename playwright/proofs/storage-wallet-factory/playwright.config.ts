import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['factory.spec.ts'],
  timeout: 240_000,
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  workers: 2,
  reporter: [['list'], ['json', { outputFile: process.env.WALLET_FACTORY_RESULT_FILE }]],
  outputDir: process.env.WALLET_FACTORY_OUTPUT_DIR,
  use: { headless: true, trace: 'off', screenshot: 'off', video: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
