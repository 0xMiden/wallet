import { defineConfig } from '@playwright/test';

// This config is the base for every Chrome E2E suite: it runs directly for the
// blockchain runs (localhost per-PR + devnet/testnet on main) and is spread into
// playwright.{earn,swap,guardian,bridge,bridge-guardian}.config.ts. Those suites
// differ in what they cost to run, so `maxFailures` keys off the same
// `E2E_NETWORK` the harness already uses to pick endpoints.
const isLocalnet = process.env.E2E_NETWORK === 'localhost';

export default defineConfig({
  testDir: './playwright/e2e/tests',
  // Guardian specs need a locally-spawned guardian backend that only the
  // dedicated guardian job stands up, so exclude them from the general
  // blockchain runs (they're run via playwright.guardian.config.ts). Swap
  // specs are gated on swap-related path changes, so exclude them too
  // (they're run via playwright.swap.config.ts by the dedicated swap job).
  // Bridge specs drive real cross-chain bridging against the hosted Epoch
  // allocator (testnet-only), so they run via playwright.bridge.config.ts on a
  // dedicated job, not the general blockchain/localhost runs. Earn specs need
  // fake Epoch allocator/positions services + a local Anvil, so they run via
  // playwright.earn.config.ts on the dedicated earn job, not here.
  testIgnore: ['**/guardian-*.spec.ts', '**/swap/**', '**/bridge/**', '**/earn/**'],
  timeout: 300_000, // 5 min per test (blockchain ops are slow)
  expect: {
    timeout: 60_000
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0, // No retries -- fail fast, diagnose from report.json
  // On the hermetic localnet stack the whole point of a ~25-minute run is to
  // learn the state of EVERY spec: stopping at the first failure reports one
  // fact and N-1 unknowns, so a PR that breaks two things costs two full runs.
  // Everything else (devnet/testnet, and the real-testnet bridge suite that
  // spreads this config) burns a shared faucet and live-network time on each
  // spec, so those keep failing fast.
  maxFailures: isLocalnet ? 0 : 1,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
    headless: false, // Extensions require headed mode
    trace: 'on', // Always record traces for debugging
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  }
});
