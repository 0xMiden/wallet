import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './playwright/store-listing',
  testMatch: 'store-listing.capture.spec.ts',
  timeout: 600_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
  webServer: {
    command: 'yarn vite preview --config vite.mobile.config.ts --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 120_000
  }
});
