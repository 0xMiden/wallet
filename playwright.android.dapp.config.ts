import { defineConfig } from '@playwright/test';

import base from './playwright.android.config';

/**
 * Android dApp-browser suite — the Android half of the split described in
 * playwright.ios.dapp.config.ts. Runs the same journey against the emulator.
 */
export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: '**/dapp-browser.*.spec.ts',
  timeout: 600_000
});
