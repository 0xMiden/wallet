import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './playwright/visual/token-detail',
  testMatch: 'visual.spec.ts',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/token-detail-visual/results.json' }]],
  outputDir: 'test-results/token-detail-visual',
  projects: [
    { name: 'mobile-light', use: { viewport: { width: 393, height: 852 }, deviceScaleFactor: 1 } },
    { name: 'mobile-dark', use: { viewport: { width: 393, height: 852 }, deviceScaleFactor: 1 } },
    { name: 'extension-light', use: { viewport: { width: 360, height: 640 }, deviceScaleFactor: 1 } },
    { name: 'extension-dark', use: { viewport: { width: 360, height: 640 }, deviceScaleFactor: 1 } }
  ],
  use: { baseURL: 'http://127.0.0.1:5192', headless: true },
  webServer: {
    command: 'yarn vite --config playwright/visual/token-detail/vite.config.mts',
    url: 'http://127.0.0.1:5192',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
