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
  testIgnore: ['**/guardian-*.spec.ts', '**/swap/**', '**/bridge/**', '**/earn/**', '**/resilience/**'],
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
  //
  // 3, not 0. With 0 the worst case is every spec burning its full 300s timeout:
  // guardian-lifecycle is 39 specs = 195 min against a 60-min `timeout-minutes`,
  // and a job killed by that budget skips its remaining steps — including the
  // `if: failure()` artifact upload and the flaky report. A run that dies with
  // NO artifacts is strictly worse than fail-fast, which is the outcome this
  // change exists to prevent. 3 keeps the runtime bounded while still reporting
  // several independent failures per cycle instead of one.
  maxFailures: isLocalnet ? 3 : 1,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  // ONE `use` block. There used to be two — a second, later one further down
  // the object literal — which silently won, so the bounded timeouts below
  // (added by #675 for exactly the failure they describe) never applied to a
  // single CI run. `guardian-recovery-stress` then failed on main with
  // "Object with guid handle@… was not bound in the connection" followed by
  // "browserContext.close: Target page, context or browser has been closed"
  // (run 32175200493) — the unbounded-action signature #675 set out to remove.
  // Root-level `playwright.*.config.ts` files sit outside `yarn lint`'s `src`
  // scope AND outside tsconfig's `include`, so neither `no-dupe-keys` nor
  // TS1117 was ever evaluated against this file; see the tsconfig entry that
  // now closes that gap.
  use: {
    headless: false, // Extensions require headed mode
    trace: 'on', // Always record traces for debugging
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Playwright defaults BOTH of these to 0 = unbounded. An action whose
    // actionability check never settles (a button under a modal still animating
    // in, say) then hangs for the whole per-test budget and fails with
    // "Target page, context or browser has been closed" — which names neither
    // the step nor the element, and looks like a crash rather than a stuck
    // click. That is what `contacts-send` did on main: 10 minutes, no
    // diagnostic. Bounded here so the failing ACTION reports itself; specs that
    // legitimately need longer pass an explicit per-call timeout, which wins.
    actionTimeout: 30_000,
    navigationTimeout: 90_000
  }
});
