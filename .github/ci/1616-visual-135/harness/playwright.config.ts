import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

if (!process.env.VISUAL_PROOF_OUTPUT) throw new Error('VISUAL_PROOF_OUTPUT must name a fresh private output directory');
export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: 'visual.spec.ts',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  retries: 0,
  workers: 1,
  reporter: [['json', { outputFile: resolve(process.env.VISUAL_PROOF_OUTPUT, 'playwright.json') }]],
  outputDir: resolve(process.env.VISUAL_PROOF_OUTPUT, 'test-output'),
  use: { screenshot: 'off', trace: 'off' },
  webServer: {
    command: 'yarn vite preview --config .ci-proof/1616-visual/harness/vite.config.mts',
    url: 'http://127.0.0.1:5191',
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe'
  }
});
