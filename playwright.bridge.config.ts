import { defineConfig } from '@playwright/test';

import base from './playwright.e2e.config';

// Same real-network harness as the blockchain E2E config, but runs ONLY the
// bridge specs (which the base config ignores via testIgnore). The bridge suite
// drives real cross-chain bridging (Miden testnet -> Sepolia via the hosted
// Epoch allocator), so it is testnet-only and gated on its own dedicated job
// rather than the per-PR localhost stack — the hosted allocator/solver cannot be
// stood up locally.
export default defineConfig({
  ...base,
  testDir: './playwright/e2e/tests/bridge',
  // `bridge-out-epoch-guardian.spec.ts` is hermetic (local stack + fake Epoch
  // allocator + guardian profile), NOT a real-testnet spec — it runs via
  // playwright.bridge-guardian.config.ts on its own job, so exclude it here.
  testIgnore: '**/bridge-out-epoch-guardian.spec.ts'
});
