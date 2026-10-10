import { defineConfig } from '@playwright/test';

import base from './playwright.android.config';

export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: '**/bridge-in-deposit.android.spec.ts',
  globalSetup: './playwright/e2e/android/fixtures/bridge-in-global-setup.ts'
});
