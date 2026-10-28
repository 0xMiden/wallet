import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['native.spec.ts'],
  timeout: 300_000,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: process.env.NATIVE_UI_RESULTS }]],
  outputDir: process.env.NATIVE_UI_TEST_OUTPUT
});
