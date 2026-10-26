import { defineConfig } from '@playwright/test';

import base from './playwright.e2e.config';

// Same harness as the blockchain E2E config, but runs ONLY the guardian specs
// (which the base config ignores). Used by the dedicated guardian job that
// spawns a local guardian backend.
//
// GUARDIAN_E2E_SUITE=pr (pull_request): happy-path only. Stress specs and the
// live fault.smoke wiring stay on main/dispatch, where a flake does not block
// an unrelated PR. Unset or any other value: the full suite (local runs too).
const prSuite = process.env.GUARDIAN_E2E_SUITE === 'pr';

export default defineConfig({
  ...base,
  testIgnore: prSuite ? /(-stress\.spec\.ts|guardian-fault\.smoke\.spec\.ts)$/ : undefined,
  testMatch: '**/guardian-*.spec.ts'
});
