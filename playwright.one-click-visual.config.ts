import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './playwright/visual/one-click',
  testMatch: 'visual.spec.ts',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/one-click-visual',
  projects: [
    { name: 'mobile-light', use: { viewport: { width: 393, height: 852 }, deviceScaleFactor: 1 } },
    { name: 'mobile-dark', use: { viewport: { width: 393, height: 852 }, deviceScaleFactor: 1 } },
    { name: 'desktop-light', use: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 } },
    { name: 'desktop-dark', use: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 } }
  ],
  use: { baseURL: 'http://127.0.0.1:5190', headless: true },
  webServer: {
    command: 'yarn vite --config playwright/visual/one-click/vite.config.mts',
    url: 'http://127.0.0.1:5190',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
