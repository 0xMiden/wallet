import { defineConfig } from '@playwright/test';

import base, { isLocalnet } from './playwright.e2e.config';

// The multi-device suite: one Guardian account on two or three Chrome profiles (role "add" and
// "make this device the main one", claims made on another device, the rotated-out device, the
// encrypted backup). It runs on testnet against a LOCAL wallet-api Worker, so it needs its own
// build (`yarn test:e2e:multi-device:build`, which bakes MIDEN_WALLET_API_URL) and its own global
// setup, which starts the Worker before any test and stops it after the run. The base config
// ignores this directory.
//
// Each spec creates an account, funds it, waits for the Guardian, and recovers it on one or two
// more devices, each step against public testnet. The roles specs need 9 to 13 minutes, so the
// limit is 20 minutes. It is a ceiling, not a delay. A spec that needs more sets its own limit.
export default defineConfig({
  ...base,
  testDir: './playwright/e2e/tests/multi-device',
  // Clears the base list, which ignores `**/multi-device/**` and would select nothing here.
  testIgnore: undefined,
  workers: 1,
  timeout: 1_200_000,
  expect: { ...base.expect, timeout: isLocalnet ? base.expect?.timeout : 120_000 },
  globalSetup: './playwright/e2e/harness/multi-device-global-setup.ts',
  globalTeardown: './playwright/e2e/harness/multi-device-global-teardown.ts'
});
