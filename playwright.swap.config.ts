import { defineConfig } from '@playwright/test';

import base from './playwright.e2e.config';

// Same harness as the blockchain E2E config, but runs ONLY the swap specs
// (which the base config ignores via testIgnore). Used by the dedicated,
// path-filtered swap-e2e job so swap coverage doesn't run on every PR.
export default defineConfig({
  ...base,
  testDir: './playwright/e2e/tests/swap',
  // QUARANTINED (#522): swap-guardian.spec.ts creates a guardian account, which fails on
  // SDK 0.16 — @openzeppelin/miden-multisig-client has no protocol-0.16 release yet (its
  // guardian_ecdsa MASM references AUTH_UNAUTHORIZED_EVENT, removed in protocol 0.16).
  // Remove this testIgnore to re-enable once OZ ships a protocol-0.16 client.
  testIgnore: '**/swap-guardian.spec.ts'
});
