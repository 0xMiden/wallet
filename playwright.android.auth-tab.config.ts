import { defineConfig } from '@playwright/test';

import base from './playwright.android.config';

export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: '**/auth-tab.android.spec.ts',
  timeout: 600_000,
  outputDir: 'test-results-auth-tab/playwright',
  globalSetup: undefined,
  globalTeardown: undefined,
  reporter: [['list'], ['json', { outputFile: 'test-results-auth-tab/results.json' }]]
});
