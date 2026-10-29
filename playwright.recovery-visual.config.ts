import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './playwright/visual/recovery', testMatch: 'visual.spec.ts', timeout: 30000, workers: 1,
  reporter: [['list']], outputDir: 'test-results/recovery-visual',
  projects: [
    { name: 'sidebar-light', use: { viewport: { width: 400, height: 800 } } },
    { name: 'sidebar-dark', use: { viewport: { width: 400, height: 800 } } },
    { name: 'mobile-light', use: { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true } },
    { name: 'mobile-dark', use: { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true } }
  ],
  use: { baseURL: 'http://127.0.0.1:5190', headless: true },
  webServer: { command: 'yarn vite --config playwright/visual/recovery/vite.config.mts', url: 'http://127.0.0.1:5190', timeout: 120000 }
});
