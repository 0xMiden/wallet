import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './playwright/visual/bridge-status',
  testMatch: 'visual.spec.ts',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/bridge-status-visual',
  projects: [
    { name: 'light', use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 } },
    { name: 'dark', use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 } }
  ],
  use: { baseURL: 'http://127.0.0.1:5193', headless: true },
  webServer: {
    command: 'yarn vite --config playwright/visual/bridge-status/vite.config.mts',
    url: 'http://127.0.0.1:5193',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
