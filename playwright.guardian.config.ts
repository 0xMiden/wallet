import { defineConfig } from '@playwright/test';

import base from './playwright.e2e.config';

// Same harness as the blockchain E2E config, but runs ONLY the guardian specs
// (which the base config ignores). Used by the dedicated guardian job that
// spawns a local guardian backend.
export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: '**/guardian-*.spec.ts'
});
