import { defineConfig } from '@playwright/test';

import base from './playwright.e2e.config';

export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: '**/one-click-local.spec.ts',
  outputDir: 'test-results/one-click-local',
  reporter: [['list'], ['json', { outputFile: 'test-results/one-click-local/results.json' }]],
  timeout: 900_000,
  expect: { timeout: 120_000 }
});
