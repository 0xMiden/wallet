import { defineConfig } from '@playwright/test';

import base from './playwright.ios.config';

/**
 * iOS dApp-browser suite. Same harness as the base iOS config, but runs ONLY
 * the dApp-browser spec (which the base config ignores), mirroring how the
 * guardian and bridge-in suites are split out.
 *
 * Split out because this suite needs no chain at all — no faucet, no
 * miden-client-cli, no funded account. Running it inside the blockchain suite
 * would make it pay for ~9 minutes of cargo build it never uses, and would let
 * a testnet outage mask a dApp-browser regression.
 *
 * The shorter timeout is deliberate: nothing here waits on proving or chain
 * sync, so a run that takes 25 minutes is hung, not slow.
 */
export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: '**/dapp-browser.*.spec.ts',
  timeout: 600_000
});
