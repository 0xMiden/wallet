import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'visual.spec.ts',
  timeout: 30_000,
  workers: 1,
  outputDir: '../../test-results/1451-visual',
  use: { baseURL: 'http://127.0.0.1:5197', locale: 'en-US', trace: 'off', video: 'on' },
  projects: [
    { name: 'extension-light', use: { viewport: { width: 360, height: 640 }, colorScheme: 'light' } },
    { name: 'extension-dark', use: { viewport: { width: 360, height: 640 }, colorScheme: 'dark' } },
    { name: 'mobile-light', use: { viewport: { width: 393, height: 852 }, colorScheme: 'light' } },
    { name: 'mobile-dark', use: { viewport: { width: 393, height: 852 }, colorScheme: 'dark' } }
  ],
  webServer: {
    command: 'yarn vite --config .superpowers/1451-visual/vite.config.mts',
    cwd: '../..',
    url: 'http://127.0.0.1:5197',
    reuseExistingServer: false,
    timeout: 60_000
  }
});
