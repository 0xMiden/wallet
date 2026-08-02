import { defineConfig } from '@playwright/test';

import base from './playwright.e2e.config';

// Hermetic, LOCALHOST-stack variant of the bridge suite: runs ONLY the guardian
// bridge-out spec (`bridge-out-epoch-guardian.spec.ts`). Unlike
// playwright.bridge.config.ts (real testnet + the hosted Epoch allocator), this
// spec stands up the fake Epoch allocator (:8548) + a local Anvil (:8545) and
// needs the `--profile guardian` co-signer — so it runs on its own dedicated
// per-PR job (the union of the earn doubles-env build and the guardian
// bring-up). It is kept OUT of playwright.bridge.config.ts (which would run it
// against real testnet) via that config's testIgnore.
export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: '**/bridge-out-epoch-guardian.spec.ts'
});
