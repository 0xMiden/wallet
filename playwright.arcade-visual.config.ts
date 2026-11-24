import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './playwright/visual/arcade',
  testMatch: 'visual.spec.ts',
  timeout: 30_000,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/arcade-visual',
  use: { baseURL: 'http://127.0.0.1:5191' },
  webServer: {
    command: 'yarn vite --config playwright/visual/arcade/vite.config.mts',
    url: 'http://127.0.0.1:5191',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
