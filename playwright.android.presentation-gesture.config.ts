import { defineConfig } from '@playwright/test';

import base from './playwright.android.config';

export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: '**/dapp-browser.gesture.android.spec.ts',
  timeout: 300_000,
  retries: 0,
  workers: 1,
  globalSetup: undefined,
  globalTeardown: undefined,
  outputDir: 'test-results-presentation-gesture/playwright',
  reporter: [['list'], ['json', { outputFile: 'test-results-presentation-gesture/results.json' }]]
});
