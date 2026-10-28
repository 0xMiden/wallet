import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['visual.spec.ts'],
  timeout: 120_000,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: process.env.RECOVERY_VISUAL_RESULTS }]],
  outputDir: process.env.RECOVERY_VISUAL_OUTPUT,
  use: { baseURL: 'http://127.0.0.1:5194', headless: true, deviceScaleFactor: 1, trace: 'off', screenshot: 'off', video: 'off' },
  webServer: {
    cwd: process.cwd(),
    command: 'yarn vite preview --config playwright/proofs/storage-recovery-visual/vite.config.mts --host 127.0.0.1 --port 5194 --strictPort',
    url: 'http://127.0.0.1:5194',
    timeout: 60_000,
    reuseExistingServer: false
  }
});
