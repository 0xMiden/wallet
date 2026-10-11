import { defineConfig } from '@playwright/test';

import base from './playwright.ios.config';

// Same harness as the iOS E2E config, but runs ONLY the live USDCx spec (which the base
// iOS config ignores). The spec deposits real Arc Testnet USDC through Circle xReserve
// from a funded key (USDCX_LIVE_EVM_PRIVATE_KEY), then burns public faucet USDCx
// through Send back to that key and waits for Circle's payout. It runs in the
// dedicated USDCx live E2E job. Run with: yarn test:e2e:mobile:usdcx-live:run.
//
// The app must be built WITHOUT E2E_EVM_RPC_URL: that flag sends the Arc reads to
// a local Anvil, and this suite needs the real Arc Testnet RPC.
export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: '**/usdcx-live-*.ios.spec.ts',
  // The worst passing run: the 13 min simulator setup cap, Circle's attestation and the relayer's mint at their 20
  // and 15 min caps, the deposit leg's other steps at 5x their CI time (3 min), its new steps at their budgets
  // (6 min) and every burn step at its budget (44.5 min, the payout's 10 min from the consume included): about
  // 102 min, rounded up. With the job's ~21 min of setup and build it fits the job's 150 min ceiling.
  timeout: 6_300_000
});
