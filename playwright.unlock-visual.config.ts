import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './playwright/visual/unlock',
  testMatch: 'visual.spec.ts',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/unlock-visual',
  projects: [320, 360, 600, 1280].flatMap(width =>
    ['light', 'dark'].map(theme => ({
      name: `${width}-${theme}`,
      use: { viewport: { width, height: 720 }, deviceScaleFactor: 1 }
    }))
  ),
  use: { baseURL: 'http://127.0.0.1:5192', headless: true },
  webServer: {
    command: 'yarn vite --config playwright/visual/unlock/vite.config.mts',
    url: 'http://127.0.0.1:5192',
    reuseExistingServer: !process.env.CI
  }
});
