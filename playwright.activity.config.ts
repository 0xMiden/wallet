import { defineConfig } from '@playwright/test';

// Explicit actual-Chrome acceptance, separate from the generic Chromium extension smoke suite.
export default defineConfig({
  testDir: './playwright/chrome',
  testMatch: 'activity-filter-drag.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' }
});
