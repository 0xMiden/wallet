import { defineConfig } from '@playwright/test';

export default defineConfig({
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'on-first-retry'
  },
  projects: [
    {
      name: 'default',
      testDir: './playwright/tests',
      timeout: 30_000,
      use: { headless: true },
      retries: 2
    },
    {
      name: 'stress',
      testDir: './stress-test',
      timeout: 7_200_000, // 2 hours
      use: { headless: false }, // extensions require headed mode
      retries: 0
    }
  ]
});
