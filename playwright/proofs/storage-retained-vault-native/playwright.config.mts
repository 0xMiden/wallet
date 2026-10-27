import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: 'recovery.spec.mjs',
  timeout: 240_000,
  expect: { timeout: 10_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['json', { outputFile: process.env.RECOVERY_PROOF_RESULTS || 'proof-results/retained/results.json' }]],
  use: { headless: true, trace: 'off', screenshot: 'off', video: 'off' }
});
