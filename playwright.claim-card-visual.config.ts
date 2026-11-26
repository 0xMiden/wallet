import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './playwright/visual/claim-card',
  testMatch: 'visual.spec.ts',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/claim-card-visual',
  projects: [
    { name: 'light', use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 } },
    { name: 'dark', use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 } }
  ],
  use: { baseURL: 'http://127.0.0.1:5196', headless: true, locale: "en-US", timezoneId: "UTC" },
  webServer: {
    command: 'yarn vite --config playwright/visual/claim-card/vite.config.mts',
    url: 'http://127.0.0.1:5196',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
