import { defineConfig } from '@playwright/test';

import base from './playwright.ios.config';

// Same harness as the iOS E2E config, but runs ONLY the live USDCx bridge-in spec
// (which the base iOS config ignores). The spec deposits real Arc Testnet USDC
// through Circle xReserve and runs a local deposit relayer, so it needs a funded
// EVM key and a funded relayer account that the standard mobile suite does not
// have. It runs in the dedicated USDCx live E2E job. Run with:
// yarn test:e2e:mobile:usdcx-live:run.
//
// The app must be built WITHOUT E2E_EVM_RPC_URL: that flag sends the Arc reads to
// a local Anvil, and this suite needs the real Arc Testnet RPC.
export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: '**/usdcx-live-*.ios.spec.ts',
  // Circle's attestation and the faucet's network transaction set the pace, not the wallet.
  timeout: 3_600_000
});
