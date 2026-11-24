import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './playwright/visual/token-display',
  testMatch: 'visual.spec.ts',
  timeout: 30_000,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/token-display-visual',
  use: { baseURL: 'http://127.0.0.1:5193' },
  webServer: {
    command: 'yarn vite --config playwright/visual/token-display/vite.config.mts',
    url: 'http://127.0.0.1:5193',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
