import { defineConfig } from '@playwright/test';

import base from './playwright.ios.config';

// Same harness as the iOS E2E config, but runs ONLY the guardian specs (which
// the base iOS config ignores). Mirrors playwright.guardian.config.ts on the
// Chrome side. Run with: yarn test:e2e:mobile:guardian:run (devnet uses the
// network default guardian endpoint, guardian-stg).
export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: '**/guardian-*.ios.spec.ts',
});
