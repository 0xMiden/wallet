import { defineConfig } from '@playwright/test';

import base from './playwright.ios.config';

export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: '**/dapp-browser.gesture.ios.spec.ts',
  retries: 0,
  workers: 1,
  outputDir: 'test-results-ios/presentation-gesture/playwright',
  reporter: [['list'], ['json', { outputFile: 'test-results-ios/presentation-gesture/results.json' }]]
});
