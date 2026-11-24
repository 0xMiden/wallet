import { defineConfig } from '@playwright/test';

import base from './playwright.android.config';

/** The Android half of playwright.ios.dapp-e2e.config.ts: two emulators, run by e2e-dapp.yml's dapp-e2e-android job. */
export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: '**/dapp-inapp.*.spec.ts',
  maxFailures: 0,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  globalSetup: './playwright/e2e/android/fixtures/dapp-e2e-global-setup.ts'
});
