import { defineConfig } from '@playwright/test';

import base from './playwright.ios.config';

export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: '**/eligibility-origin.ios.spec.ts',
  timeout: 600_000,
  retries: 0
});
