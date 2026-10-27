import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './playwright/toolbar',
  timeout: 180000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { headless: false, trace: 'retain-on-failure', actionTimeout: 15000, navigationTimeout: 30000 }
});
