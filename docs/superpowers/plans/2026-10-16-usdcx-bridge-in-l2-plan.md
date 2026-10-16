# USDCx L2 bridge-in live E2E (usdcx-in-l2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live Chrome suite, `usdcx-in-l2`, deposits 0.001 USDC plus Circle's forward fee from the harness key on Base Sepolia and on Arbitrum Sepolia through the wallet's own executor-route deposit, and passes only once the source burn, Circle's attestation and forward, the Arc execution, the Miden mint and the wallet's claim are each proven.

**Architecture:** PR 1 makes `src/lib/usdcx/executor.ts` load in Node without the wallet's configuration runtime or the SDK, so the harness runs the product's own `runUsdcxExecutorDeposit` (allowance and balance reads, quote, approve for amount plus twice the fee, balance read and second quote, forwarded burn; since #1498 it refuses a balance short of the amount plus the quoted fee before the approve and again before the burn) with a Node signer, and teaches the E2E-only `__TEST_CREATE_BRIDGE_RECEIVE__` hook to keep the `submitting` write that function makes (the forwarded CCTP leg), so the wallet's real reconciler tracks the harness-signed deposit. PR 2 adds the harness pieces (L2 sources from the fixture, the Node deposit, chain-evidence gates keyed by our burn hash and CCTP nonce), the spec, a runner suite with a per-chain key preflight, and splits E2E USDCx into an Arc job and an L2 job chained by `needs`.

**Tech Stack:** TypeScript, viem 2 (local account signing, `parseEventLogs`), Playwright (extension harness), Jest (`@swc/jest`), Node 22 runner `scripts/e2e-real.mjs`, GitHub Actions.

**Spec:** `/Users/celrisen/miden/wt-usdcx-e2e/.superpowers/gaps/usdcx-gap-map.md` (gap 1; decisions D1, D3, D4, D5) with `scout-bridgein.md` (route, fees, gas, signing, risks). The user's binding decisions on top of them are copied into Global Constraints.

## Size

| PR | Task | What | Lines (approx., tests included) | Touches the product (`src/`) |
|---|---|---|---|---|
| 1 | 1 | `executor.ts` loads without the wallet runtime or the SDK | +70 / -25 | **Yes: the executor-route deposit users run** |
| 1 | 2 | The E2E hook keeps an executor deposit's `submitting` write | +95 / -5 | **Yes: E2E-only hook, installed only under `MIDEN_E2E_TEST`** |
| 2 | 3 | L2 sources, generalized write internals, Node L2 deposit through the product | +440 / -30 | No |
| 2 | 4 | Chain-evidence gates: source burn, Iris forward, Arc execution | +1,000 (about 550 of it captured JSON) | No |
| 2 | 5 | Move the receive leg out of the round-trip spec | +175 / -165 | No |
| 2 | 6 | The `usdcx-in-l2` spec, the bridge helper fields and the listing pins | +345 / -5 | No |
| 2 | 7 | Runner suite, L2 key and write-endpoint preflight, stub, runner tests | +340 / -25 | No |
| 2 | 8 | Split E2E USDCx into an Arc job and an L2 job | +185 / -60 | No |
| 2 | 9 | Docs, config comment, CHANGELOG | +45 / -20 | No |

PR 1 is about 165 changed lines; PR 2 is about 2,500, of which about 850 are tests and 550 captured chain data.

## Global Constraints

- Chrome only. The source-chain deposit is signed in Node with the harness key; in CI that key's address is `0x4D4A180C637a71FCB9b5BD1186C8ce23C40EBa81` (the `USDCX_HARNESS_ARC_KEY` secret). Its ETH on Base Sepolia and Arbitrum Sepolia is sent by hand; its USDC there comes from `usdcx-burn-l2` payouts.
- The key already holds ETH on Base Sepolia and Arbitrum Sepolia, bridged by hand (user, 2026-10-16), so the top-up message is for later runs, once a balance runs low. Read at the pre-flight (2026-10-16, publicnode): Base Sepolia 0.024 ETH and 3_955_604 USDC units; Arbitrum Sepolia 3_955_604 USDC units and 0 ETH on all three of its endpoints (an L1 to L2 bridge may still have been landing; see the pre-flight doubts).
- Deposit exactly `DEPOSIT_UNITS` (1_000 base units, 0.001 USDC) plus Circle's quoted fee. Read 2026-10-16: fee 22_404, so 23_404 per chain per run.
- The suite's preflight fails with `top up the key on <chain>: <address> holds ... , below the ... one bridge-in needs ...` when ETH or USDC is short, naming the chain, the address and the minimum.
- Suite name `usdcx-in-l2`; it runs after `usdcx-in` and before `usdcx-burn-l2`; it runs after an earlier suite failed, never after a failed setup step.
- The harness never executes on Arc itself: a forward Circle gave up on fails the run.
- Ethereum Sepolia is out of this change, and adding it is more than one entry: `L2BridgeInSource` takes a `PayoutChain`, and `payoutChainFor` refuses 11155111 on main (`usdcx-constants.ts`; the parallel Sepolia-burn change lifts that and adds `ETHEREUM_SEPOLIA_PAYOUT`); `sendSigned` needs a pinned low priority fee there (its signers bid 22 wei to 1.5 gwei); the key needs Sepolia ETH and a USDC seed (refilled only if that change's Sepolia payouts land); and it adds an `L2_BRIDGE_IN_CHAINS` copy, the listing pins and about 55 min on the L2 job's ceiling.
- E2E USDCx becomes two serialized jobs: `chrome-usdcx-arc` (usdcx-in, usdcx-burn, usdcx), then `chrome-usdcx-l2` (usdcx-in-l2, usdcx-burn-l2) with `needs: chrome-usdcx-arc` and `if: ${{ !cancelled() }}`, so it runs after a red Arc job and never in a cancelled run. "Never after a failed setup step" is the L2 job's own setup: `usdcx-in-l2` has no `if:`, so any failed setup step there (its key write included) skips it, and `usdcx-burn-l2` runs only when `usdcx-in-l2` was not skipped. Ceilings: Arc push 210 / dispatch 240; L2 push 230 / dispatch 260. If the parallel Sepolia-burn change lands first (a third `usdcx-burn-l2` test of 38 min), the L2 job is push 270 / dispatch 300.
- `usdcx-burn-l2` keeps reading its balance snapshot right before each burn.
- Keep the harness patterns: `withStepBudget`/`namedSteps` budgets, evidence JSON through `attachEvidence` (refuses a private key), the run lock, `keylessEnv` (no key reaches a build), endpoints named by host only (`arcHost`, `redactProjectId`), the runner's fetch stub (`scripts/e2e-real.fetch-stub.mjs`) and stub EIP-1193 clients for unit tests.
- CPU rule: jest only on added or changed test files plus the other test files in the directory of a changed source file, always `--maxWorkers=1`; never `yarn ts`/`tsc`, `yarn lint`, `yarn lint:e2e`, a full jest run, coverage, a build, any live or local E2E suite, or `yarn e2e:real` (not even `--preflight-only`); `prettier --check` and `eslint --max-warnings 0` only on changed files. Type errors are left to CI.
- Every shell command starts with `cd /Users/celrisen/miden/wt-usdcx-bridge-in-l2 && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"`. The shell is zsh.
- Commit messages: one lower-case line, no trailers, no tool attribution. Never amend.
- No em dash or en dash anywhere (code, comments, docs, CHANGELOG, commit messages).
- No `any`; no type assertions in source (`as const` is fine).
- Comment density: match the file (`executor.ts` and the hook about 20%, `arc-usdcx.ts` 9%, specs 7%, `e2e-real.mjs` 21%, the workflow 27%). Comments say why, not what.
- CHANGELOG: entries go under `## 1.17.5 (TBD)`; before writing, run `git fetch --tags && git tag --list 'v*' --sort=-v:refname | grep -v rc | head -1` and confirm the latest release is below 1.17.5.

## Why one job's order is enough between usdcx-in-l2 and usdcx-burn-l2

`usdcx-in-l2` spends the key's USDC on Base Sepolia and Arbitrum Sepolia; `usdcx-burn-l2` proves each payout as the key's balance rising by exactly the payout above a read taken right before its burn. The two never overlap because:

1. They are consecutive steps of the L2 job, and a job runs its steps one at a time on one runner; locally the runner's lock (`~/.miden-e2e/usdcx-run.lock`) refuses a second usdcx run.
2. Every L2 transaction `usdcx-in-l2` sends is mined before its step ends: `runUsdcxExecutorDeposit` awaits the approve's receipt and the burn's receipt, and the `source_burn` gate re-reads the burn's receipt.
3. `usdcx-burn-l2` reads its snapshot (head block and balance at that block, from one endpoint) right before each burn, so anything mined earlier is inside `balanceBefore` and cannot move the delta.
4. Runs never overlap: the workflow-level concurrency group `usdcx-harness-arc-key` queues whole runs, both jobs included.
5. `usdcx-in-l2` pays nothing back to the key on the L2s as far as the probed burn shows (the USDC moves executor, handler, xReserve on Arc; the mint goes to the Miden wallet), and the Arc job only pays into the key on Arc. The burn names the key as `refundAddress` (`executor.ts:249`, `:351`), so a later refund of part of Circle's forward fee to the key on the L2 is unverified (see the watch list below).

The one residual: a `usdcx-in-l2` test that broadcast its burn but saw no receipt within 120 s fails, and if that burn mines inside `usdcx-burn-l2`'s window, `usdcx-burn-l2` fails `key-moved`, whose note already names "a deposit a killed run left pending".

## Review Focus

1. **`TokenMessengerWithFees` passing the hook data on verbatim.** The `source_burn` gate compares the CCTP message's hook data byte for byte with what the key signed (`submission.signed`, the tuple the Node signer received, never a rebuilt intent); the only live sample (another integrator's) ordered its frames `circle-generic-executor` then `cctp-forward`, the reverse of the wallet's, so this is unproven for the wallet's frame order. Expected: a mismatch fails naming `hookData`, never passes silently. Pinned in Task 4 ("names hookData when one signed byte differs").
2. **Circle falling back to source finality.** A fast transfer forwarded in 8-10 s when probed; an exhausted fast allowance takes 15-20 min. Expected: the Iris step waits up to 25 min (the wallet's own arrival copy says about 20 min) and its failure names the last status and forward state. Pinned in Task 4 ("waits through pending reads" and "times out naming the last status").
3. **Another party's deposit through the same executor, handler and xReserve.** It happens every 20 min or so. Expected: every gate keys on our burn hash (Iris) and our CCTP nonce (Arc logs), and two Iris messages or a foreign nonce fail by name. Pinned in Task 4 ("two messages", "another burn's nonce").
4. **The key short of ETH or USDC on one chain, or no L2 endpoint taking writes.** Expected: the runner's preflight fails before the build with `top up the key on <chain>` naming the address and the minimum, or with `<chain> write endpoint` naming each endpoint's refusal, and the spec's `l2_key` step says the same about funds with the live quote. Past both, `runUsdcxExecutorDeposit`'s own check (#1498) refuses a USDC balance short of the amount plus the quoted fee before the approve, so nothing is sent. Pinned in Task 3 (`l2KeyShortfall`, and "sends nothing when the key's USDC does not cover the amount and Circle's fee") and Task 7 (runner preflight).
5. **A forward Circle gave up on.** Expected: the gate fails at once naming `forwardState`, and the harness never executes on Arc. Pinned in Task 4 ("fails at once on a forward Circle gave up").

Not reachable by tests, watched on the first runs: whether `TokenMessengerWithFees` takes a 0.001 USDC forwarded burn (Iris prices 1000 units, but every forwarded burn read on 2026-10-16, about 17 h of Base Sepolia and 2 h of Arbitrum Sepolia, was 5 USDC or more, so no amount below that has been tried on chain; a refusal fails `deposit_submit` at the burn's simulation, after the approve); whether Circle ever refunds part of a forward fee to `refundAddress` (the key) on the L2 later (none in the probed burn; a refund inside `usdcx-burn-l2`'s window would read as an uncorrelated credit).

## File structure

| File | Responsibility |
|---|---|
| `src/lib/usdcx/protocol.ts` | Gains `UsdcxDomainNotRegisteredError` (moved from `deposit.ts`), so `executor.ts` needs no runtime import. |
| `src/lib/usdcx/deposit.ts` | Re-exports the error and its guard; behaviour unchanged. |
| `src/lib/usdcx/executor.ts` | Imports only viem, `./cctp`, `./protocol` and types; requires the route's Miden domain instead of reading the live document. |
| `src/lib/miden/activity/bridge-in-test-hooks.ts` | E2E hook replays `usdcxRemoteRecipient` and the `cctp` leg; state reports `usdcxExecuteTxHash`. |
| `playwright/e2e/helpers/usdcx-config.ts` | `getUsdcxExecutorSource(chainId)` from the in-repo testnet fixture. |
| `playwright/e2e/helpers/usdcx-constants.ts` | `L2BridgeInSource`, `bridgeInSourceFor`, `L2_BRIDGE_IN_SOURCES`, `L2_BRIDGE_IN_GAS`. |
| `playwright/e2e/helpers/arc-usdcx.ts` | Write and read internals take their chain from the deps (Arc unchanged) and are exported; `depositedToRemoteOf` extracted. |
| `playwright/e2e/helpers/usdcx-l2-deposit.ts` (new) | Key funds, top-up message, the Node signer around the product's `runUsdcxExecutorDeposit`. |
| `playwright/e2e/helpers/usdcx-cctp-proof.ts` (new) | CCTP message decode and the three chain gates. |
| `playwright/e2e/helpers/usdcx-bridge-in.vectors.json` (new) | A live Base Sepolia executor deposit: burn receipt, Iris message, Arc forward receipt. |
| `playwright/e2e/helpers/usdcx-receive.ts` (new) | `trackReceiveRows` and `receiveLeg`, moved from the round-trip spec. |
| `playwright/e2e/helpers/bridge.ts` | Hook args and state field. |
| `playwright/e2e/tests/usdcx/usdcx-in-l2.spec.ts` (new) | The suite. |
| `scripts/e2e-real.mjs`, `scripts/e2e-real.fetch-stub.mjs` | Suite entry, L2 key and write-endpoint preflight, harness-key requirement. |
| `playwright/e2e/harness/spec-selection.test.ts` | Pins the two new tests, their runner grep and the spec's throw-not-skip `beforeAll`. |
| `.github/workflows/e2e-usdcx.yml` | Two jobs. |
| `playwright/e2e/docs/e2e-architecture.md`, `playwright.usdcx.config.ts`, `CHANGELOG.md` | Docs. |

---

# PR 1: the wallet's executor deposit, shareable with the harness

PR title: `refactor(usdcx): run the executor deposit without the wallet runtime, keep its cctp leg on e2e rows`. Body ends with: **Reviewers:** Task 1 is on the deposit path every Base, Arbitrum and Ethereum deposit takes; the only behaviour change is that a route without a Miden domain now refuses before any prompt instead of reading the live document.

PR 1 builds on #1498 (`wiktor/usdcx-deposit-fee-balance`, head 854b56d3f, which this branch is at and which includes main 2d093db96): it edits the `executor.ts` #1498 changed. Until #1498 merges, PR 1's base is #1498's branch; once it merged, main.

### Task 1: `executor.ts` loads without the wallet runtime or the SDK [PRODUCT: deposit path]

**Files:**
- Modify: `src/lib/usdcx/protocol.ts` (append the error class)
- Modify: `src/lib/usdcx/deposit.ts:1-55`
- Modify: `src/lib/usdcx/executor.ts:15-31` (imports), `:61-74` (`encodeXReserveDepositCalldata`), `:260-275` (`UsdcxExecutorDepositDeps`, whose `updatePhase` names the import that becomes type-only), `:310-315` (the domain read in `runUsdcxExecutorDeposit`)
- Test: `src/lib/usdcx/executor.test.ts`, `src/lib/usdcx/deposit.test.ts`, `playwright/e2e/helpers/usdcx-node-imports.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `src/lib/usdcx/protocol.ts` exports `class UsdcxDomainNotRegisteredError extends Error { readonly remoteDomain: number }` and `isUsdcxDomainNotRegisteredError(error: unknown): error is UsdcxDomainNotRegisteredError`; `deposit.ts` re-exports both (same bindings). `executor.ts` keeps every export and signature, #1498's `UsdcxExecutorBalanceTooLowError`, `isUsdcxExecutorBalanceTooLowError`, `UsdcxExecutorFeeShortfall`, `usdcxExecutorFeeShortfall` and the required `readBalance` deps member among them (all defined in `executor.ts` itself, so they need no import); at runtime it imports only `viem`, `./cctp`, `./protocol`. A route without `midenDomain` throws `Error('USDCx Miden domain is not configured')`.

- [ ] **Step 1: Write the failing tests**

Append to `playwright/e2e/helpers/usdcx-node-imports.test.ts` (below the existing `jest.mock`, above the existing `it`, add the two mocks; append the new `it` at the end):

```ts
jest.mock('lib/miden/activity', () => {
  throw new Error('E2E helpers must not load the wallet activity module, which pulls in the SDK');
});

jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  throw new Error('E2E helpers must not load the SDK');
});
```

```ts
// The live L2 bridge-in suite signs the wallet's own executor deposit in Node (usdcx-l2-deposit.ts).
it("loads the wallet's executor-route deposit without the wallet runtime, its activity module or the SDK", () => {
  const executor = jest.requireActual<typeof import('../../../src/lib/usdcx/executor')>(
    '../../../src/lib/usdcx/executor'
  );
  expect(typeof executor.runUsdcxExecutorDeposit).toBe('function');
  expect(typeof executor.encodeExecutorHookData).toBe('function');
});
```

Append to `src/lib/usdcx/executor.test.ts`:

```ts
describe('a route without its Miden domain', () => {
  // Every route usdcxSourceChains builds carries one (schema.ts drops a usdcx route without it); the encoders no longer
  // read the live document, which the E2E harness cannot load.
  const { midenDomain: _targetDomain, ...target } = TARGET;
  const { midenDomain: _sourceDomain, ...source } = SOURCE;

  it('refuses to encode the xReserve deposit', () => {
    expect(() => encodeXReserveDepositCalldata(target, RECIPIENT)).toThrow('USDCx Miden domain is not configured');
  });

  it('refuses the deposit before any read or prompt', async () => {
    const { deps, calls } = makeDeps({ source: { ...source, target } });

    await expect(runUsdcxExecutorDeposit('row-1', '1', RECIPIENT, deps)).rejects.toThrow(
      'USDCx Miden domain is not configured'
    );
    expect(calls).toEqual([]);
  });

  // The target keeps its domain, so the intent builds and only the source route's own check can refuse.
  it("refuses a source route without it before Arc's registration read", async () => {
    const { deps, calls } = makeDeps({ source: { ...source, target: TARGET } });

    await expect(runUsdcxExecutorDeposit('row-1', '1', RECIPIENT, deps)).rejects.toThrow(
      'USDCx Miden domain is not configured'
    );
    expect(calls).toEqual([]);
    expect(deps.isRemoteDomainRegistered).not.toHaveBeenCalled();
  });
});
```

Since #1498, `makeDeps` (`executor.test.ts:153-193`) also logs `readBalance` into `calls`, and the full order is `isRemoteDomainRegistered`, `readAllowance`, `readBalance`, `quote`, then after an approval `receipt:approve`, `readBalance`, `quote`. An empty `calls` therefore pins that both refusals come before the registration read, the allowance read and both balance reads: the target's refusal throws inside `buildExecutorBurnIntent` (`:310`), the source's at the domain read (`:312`).

Append to `src/lib/usdcx/deposit.test.ts` (it already imports `isUsdcxDomainNotRegisteredError` and `UsdcxDomainNotRegisteredError` from `./deposit`; add `import * as protocol from './protocol';` below that import):

```ts
it("re-exports the protocol's domain error, so a check against either module holds for both", () => {
  expect(UsdcxDomainNotRegisteredError).toBe(protocol.UsdcxDomainNotRegisteredError);
  expect(isUsdcxDomainNotRegisteredError(new protocol.UsdcxDomainNotRegisteredError(10007))).toBe(true);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx jest --maxWorkers=1 playwright/e2e/helpers/usdcx-node-imports.test.ts src/lib/usdcx/executor.test.ts src/lib/usdcx/deposit.test.ts`
Expected: FAIL. The new node-imports test throws `E2E helpers must not load the wallet activity module, which pulls in the SDK` (`executor.ts:15` imports `lib/miden/activity` before `./constant` at `:30`); the three "without its Miden domain" tests fail (the fallbacks still read 10007, so nothing throws and both deposits resolve: `makeDeps`'s `readBalance` answers 10_000_000, which covers 1 USDC plus the 31_908 fee, so #1498's balance check passes too); the deposit test fails on `protocol.UsdcxDomainNotRegisteredError` being undefined.

- [ ] **Step 3: Move the error class to `protocol.ts`**

Append to `src/lib/usdcx/protocol.ts`:

```ts
/** Circle did not register the remote domain on the xReserve contract. No gas was spent. */
export class UsdcxDomainNotRegisteredError extends Error {
  readonly remoteDomain: number;

  constructor(remoteDomain: number) {
    super(`xReserve remote domain ${remoteDomain} is not registered`);
    this.name = 'UsdcxDomainNotRegisteredError';
    this.remoteDomain = remoteDomain;
  }
}

export function isUsdcxDomainNotRegisteredError(error: unknown): error is UsdcxDomainNotRegisteredError {
  return error instanceof UsdcxDomainNotRegisteredError;
}
```

In `src/lib/usdcx/deposit.ts`, delete the class and its guard (current lines 42-55) and add below the imports:

```ts
import { UsdcxDomainNotRegisteredError } from './protocol';

export { isUsdcxDomainNotRegisteredError, UsdcxDomainNotRegisteredError } from './protocol';
```

(`deposit.ts` still throws `new UsdcxDomainNotRegisteredError(remoteDomain)` at its current line 106.)

- [ ] **Step 4: Make `executor.ts` runtime-free**

Replace `src/lib/usdcx/executor.ts:15-31` (the activity import through the `./deposit` import) with:

```ts
import type { updateBridgedReceivePhase } from 'lib/miden/activity';

import { CctpBurnQuote, fetchCctpBurnQuote } from './cctp';
import type { UsdcxExecutorSource, UsdcxExecutorTarget } from './constant';
import {
  CCTP_EXECUTOR_HOOK_NAME,
  CCTP_EXECUTOR_PAYLOAD_VERSION,
  CCTP_FORWARD_HOOK_NAME,
  CCTP_HOOK_VERSION,
  CIRCLE_USDC_DECIMALS,
  USDCX_DEPOSIT_HOOK_DATA,
  USDCX_DEPOSIT_MAX_FEE,
  UsdcxDomainNotRegisteredError,
  XRESERVE_ABI
} from './protocol';

// The live L2 bridge-in suite runs this module in Node (playwright/e2e/helpers/usdcx-l2-deposit.ts), so nothing here may
// load the wallet's configuration runtime or the SDK at runtime; usdcx-node-imports.test.ts fails on either.

/** The route's Miden domain. Every route usdcxSourceChains builds has one: schema.ts drops a usdcx route without it. */
function midenDomainOf(route: { midenDomain?: number }): number {
  if (route.midenDomain === undefined) throw new Error('USDCx Miden domain is not configured');
  return route.midenDomain;
}
```

In `encodeXReserveDepositCalldata`, replace `target.midenDomain ?? getUsdcxRemoteDomain(),` with `midenDomainOf(target),`.

In `runUsdcxExecutorDeposit` (line 312, still ahead of the allowance and balance reads #1498 placed at `:331-332`), replace `const remoteDomain = source.midenDomain ?? getUsdcxRemoteDomain();` with `const remoteDomain = midenDomainOf(source);`. Nothing else in the function changes: #1498's `readBalance` calls, `ensureBalanceCovers` and `UsdcxExecutorBalanceTooLowError` stay as they are.

- [ ] **Step 5: Run the tests to see them pass, then the directory's other tests**

Run: `npx jest --maxWorkers=1 playwright/e2e/helpers/usdcx-node-imports.test.ts src/lib/usdcx/`
Expected: PASS, every file in `src/lib/usdcx/` included.

- [ ] **Step 6: Mutation checks (predict, then run, then restore)**

| Mutation | Predicted failure |
|---|---|
| Restore `target.midenDomain ?? getUsdcxRemoteDomain()` with its `./constant` import | node-imports test (`E2E helpers must not load the SDK`: `constant.ts:4` loads `effective-endpoints`, whose first import is the SDK) and "refuses to encode the xReserve deposit" |
| `midenDomainOf(source)` back to `source.midenDomain ?? 10007` | "refuses a source route without it before Arc's registration read" (the deposit resolves) |
| Import `UsdcxDomainNotRegisteredError` from `./deposit` again | node-imports test (`E2E helpers must not load the wallet activity module, which pulls in the SDK`: `deposit.ts:3` imports `lib/miden/activity`) |
| Re-export a copy of the class from `deposit.ts` instead of the binding | deposit test (`toBe` identity) |

Each run: `npx jest --maxWorkers=1 playwright/e2e/helpers/usdcx-node-imports.test.ts src/lib/usdcx/executor.test.ts src/lib/usdcx/deposit.test.ts`. Restore with `git checkout -- <file>` of the mutated file only, then rerun to green.

- [ ] **Step 7: Format and lint the changed files**

Run: `npx prettier --check src/lib/usdcx/protocol.ts src/lib/usdcx/deposit.ts src/lib/usdcx/executor.ts src/lib/usdcx/executor.test.ts src/lib/usdcx/deposit.test.ts playwright/e2e/helpers/usdcx-node-imports.test.ts && npx eslint --max-warnings 0 src/lib/usdcx/protocol.ts src/lib/usdcx/deposit.ts src/lib/usdcx/executor.ts src/lib/usdcx/executor.test.ts src/lib/usdcx/deposit.test.ts playwright/e2e/helpers/usdcx-node-imports.test.ts`
Expected: no output from prettier beyond "All matched files use Prettier code style!", eslint silent.

- [ ] **Step 8: Commit**

```bash
git add src/lib/usdcx/protocol.ts src/lib/usdcx/deposit.ts src/lib/usdcx/executor.ts src/lib/usdcx/executor.test.ts src/lib/usdcx/deposit.test.ts playwright/e2e/helpers/usdcx-node-imports.test.ts
git commit -m "refactor(usdcx): load the executor deposit without the wallet runtime"
```

### Task 2: the E2E hook keeps an executor deposit's `submitting` write [PRODUCT: E2E-only hook]

`bridge-in-test-hooks.ts` is installed from `back/main.ts` (the extension's service worker) and `lib/intercom/mobile-adapter.ts:31-34` (mobile), each only under `MIDEN_E2E_TEST`; production builds strip it. Today the hook moves the row to `delivering` with `evmTxHash` alone, so `reconcileUsdcxExecutorRow` returns at `bridge-receive.ts:260-261` (`if (!leg) return;`) and the row never leaves `delivering`. The reconciler stays as it is; the hook gains the fields.

**Files:**
- Modify: `src/lib/miden/activity/bridge-in-test-hooks.ts:6`, `:24-49`, `:83-111`
- Test: `src/lib/miden/activity/bridge-in-test-hooks.test.ts`
- Modify: `CHANGELOG.md` (one line under `## 1.17.5 (TBD)` / `### Fixes`)

**Interfaces:**
- Consumes: `IUsdcxCctpLeg` from `src/lib/miden/db/types.ts`.
- Produces: `__TEST_CREATE_BRIDGE_RECEIVE__` accepts `usdcxRemoteRecipient?: string` and `cctp?: Pick<IUsdcxCctpLeg, 'sourceDomain' | 'forwarded' | 'forwardFee'>` and writes them with `evmTxHash` on the move to `delivering`; `__TEST_BRIDGE_RECEIVE_STATE__` and `__TEST_LATEST_BRIDGE_RECEIVE__` report `usdcxExecuteTxHash?: string` (`extraInputs.cctp.executeTxHash`).

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/miden/activity/bridge-in-test-hooks.test.ts` (add `import { reconcileBridgedReceives } from './bridge-receive';` beside the hook import):

```ts
const BASE_SEPOLIA_CHAIN_ID = 84_532;
const BURN_HASH = '0x2222222222222222222222222222222222222222222222222222222222222222';
const FORWARD_HASH = '0x3333333333333333333333333333333333333333333333333333333333333333';
// What runUsdcxExecutorDeposit (usdcx/executor.ts) writes on its `submitting` step.
const SUBMITTED = {
  usdcxRemoteRecipient: '0x00000000000000000000000000000000b64e1827414584510723cad8e145a400',
  cctp: { sourceDomain: 6, forwarded: true, forwardFee: '22404' }
};

const createExecutorReceive = () =>
  globalThis.__TEST_CREATE_BRIDGE_RECEIVE__({
    accountId: 'mtst1account',
    amount: '1000',
    faucetId: 'mtst1usdcx',
    provider: 'usdcx',
    sourceChainId: BASE_SEPOLIA_CHAIN_ID,
    sourceAddress: '0x4D4A180C637a71FCB9b5BD1186C8ce23C40EBa81',
    sourceAmount: '0.001',
    sourceSymbol: 'USDC',
    evmTxHash: BURN_HASH,
    ...SUBMITTED
  });

it("keeps an executor deposit's submitting write on the row it moves to delivering", async () => {
  installBridgeInTestHooks();

  const id = await createExecutorReceive();

  const inputs: IBridgedReceiveExtraInputs | undefined = (await Repo.transactions.where({ id }).first())?.extraInputs;
  expect(inputs).toMatchObject({
    phase: 'delivering',
    evmTxHash: BURN_HASH,
    usdcxRemoteRecipient: SUBMITTED.usdcxRemoteRecipient,
    cctp: SUBMITTED.cctp,
    usdcxSource: { route: 'cctp-executor', chain: { id: BASE_SEPOLIA_CHAIN_ID } }
  });
});

it("hands the row to the reconciler, which asks Circle about the burn and takes its Arc forward as the execute", async () => {
  installBridgeInTestHooks();
  const id = await createExecutorReceive();
  // Iris, as bridge-receive.usdcx.test.ts stands it in: the only fetch this pass makes.
  const iris = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      messages: [
        {
          message: '0x01',
          attestation: '0x02',
          status: 'complete',
          eventNonce: '0x03',
          forwardState: 'COMPLETE',
          forwardTxHash: FORWARD_HASH
        }
      ]
    })
  }));
  Object.defineProperty(globalThis, 'fetch', { value: iris, writable: true, configurable: true });

  await reconcileBridgedReceives();

  expect(iris).toHaveBeenCalledWith(
    `https://iris-api-sandbox.circle.com/v2/messages/6?transactionHash=${BURN_HASH}`,
    expect.anything()
  );
  expect(await globalThis.__TEST_BRIDGE_RECEIVE_STATE__(id)).toMatchObject({
    phase: 'delivering',
    usdcxExecuteTxHash: FORWARD_HASH
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx jest --maxWorkers=1 src/lib/miden/activity/bridge-in-test-hooks.test.ts`
Expected: FAIL. The first new test has no `cctp` and no `usdcxRemoteRecipient` on the row; the second never calls `fetch` (the reconciler returns at `bridge-receive.ts:261`) and reads no `usdcxExecuteTxHash`.

- [ ] **Step 3: Implement**

In `src/lib/miden/activity/bridge-in-test-hooks.ts`, change the type import (line 6) to:

```ts
import { IBridgedReceiveExtraInputs, IBridgeProvider, ITransactionStatus, IUsdcxCctpLeg } from '../db/types';
```

Add to `CreateBridgeReceiveArgs`, after `evmTxHash`:

```ts
  /**
   * An executor-route deposit signed outside the deposit screen: what runUsdcxExecutorDeposit (usdcx/executor.ts) wrote on
   * its `submitting` step. Without the forwarded CCTP leg the reconciler never asks Circle about the burn.
   */
  usdcxRemoteRecipient?: string;
  cctp?: Pick<IUsdcxCctpLeg, 'sourceDomain' | 'forwarded' | 'forwardFee'>;
```

Add to `BridgeReceiveDepositFields`:

```ts
  /** The Arc transaction the row took as its execute: Circle's forward, or the wallet's own execute. */
  usdcxExecuteTxHash?: string;
```

Add to the object `depositFields` returns:

```ts
    usdcxExecuteTxHash: inputs?.cctp?.executeTxHash
```

Replace the hook's first lines and its `drive` callback:

```ts
  globalThis.__TEST_CREATE_BRIDGE_RECEIVE__ = async ({
    evmTxHash,
    usdcxRemoteRecipient,
    cctp,
    ...args
  }: CreateBridgeReceiveArgs) => {
    // A USDCx row reads the document's source route and Miden domain. A profile that never stored a document has
    // nothing to hydrate, and initBridgeConfig never waits for the network, so this waits for the first document.
    await ensureBridgeConfig();
    let advanced: Promise<void> | undefined;
    const txId = await startBridgeReceiveSubmission(
      () => initiateBridgedReceiveTransaction({ ...args, amount: BigInt(args.amount) }),
      id => {
        advanced = updateBridgedReceivePhase(id, 'delivering', {
          evmTxHash,
          ...(usdcxRemoteRecipient === undefined ? {} : { usdcxRemoteRecipient }),
          ...(cctp === undefined ? {} : { cctp })
        });
        return advanced;
      }
    );
    await advanced;
    return txId;
  };
```

Add one line to `CHANGELOG.md` under `## 1.17.5 (TBD)` / `### Fixes`, directly after the `usdcx-burn-l2` line, which is that section's first entry (#1495's SDK-client line, #1498's balance line and #1499's Arc mainnet line follow it; leave them where they are). Check the release tag first, per Global Constraints (v1.17.4 is the latest release as of this pre-flight):

```markdown
- [FIX][ci] The USDCx executor-route deposit (Base, Arbitrum and Ethereum to Arc) runs without the wallet's configuration runtime, so the E2E harness signs the wallet's own deposit, and the E2E bridge-in hook keeps a deposit's forwarded CCTP leg, so the wallet reconciles a deposit the harness signed as it does its own.
```

- [ ] **Step 4: Run the tests to see them pass, then the directory**

Run: `npx jest --maxWorkers=1 src/lib/miden/activity/`
Expected: PASS for every file in the directory.

- [ ] **Step 5: Mutation checks**

| Mutation | Predicted failure |
|---|---|
| Drop `...(cctp === undefined ? {} : { cctp })` | both new tests (no leg; no Iris call) |
| Drop the `usdcxRemoteRecipient` spread | "keeps an executor deposit's submitting write" |
| Drop `usdcxExecuteTxHash` from `depositFields` | "hands the row to the reconciler" |

Run each with `npx jest --maxWorkers=1 src/lib/miden/activity/bridge-in-test-hooks.test.ts`, restore, rerun green.

- [ ] **Step 6: Format and lint**

Run: `npx prettier --check src/lib/miden/activity/bridge-in-test-hooks.ts src/lib/miden/activity/bridge-in-test-hooks.test.ts && npx eslint --max-warnings 0 src/lib/miden/activity/bridge-in-test-hooks.ts src/lib/miden/activity/bridge-in-test-hooks.test.ts`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/miden/activity/bridge-in-test-hooks.ts src/lib/miden/activity/bridge-in-test-hooks.test.ts CHANGELOG.md
git commit -m "fix(e2e): keep an executor deposit's cctp leg on rows the bridge-in hook makes"
```

---

# PR 2: the usdcx-in-l2 suite, its preflight and the CI split

Branch PR 2 off PR 1 (or off main once PR 1 merged). PR title: `test(e2e): usdcx-in-l2 bridges in from base and arbitrum sepolia, e2e usdcx splits into arc and l2 jobs`. Body ends with: **Reviewers:** the gates in `usdcx-cctp-proof.ts` and the L2 job's `if:` are the parts worth your time.

### Task 3: L2 sources, chain-generic write internals, the Node L2 deposit through the product

**Files:**
- Modify: `playwright/e2e/helpers/usdcx-config.ts` (append `getUsdcxExecutorSource`)
- Modify: `playwright/e2e/helpers/usdcx-constants.ts` (append the L2 bridge-in list)
- Modify: `playwright/e2e/helpers/arc-usdcx.ts:56-60`, `:221`, `:682-854` (internals take their chain from the deps; exports)
- Create: `playwright/e2e/helpers/usdcx-l2-deposit.ts`
- Test: `playwright/e2e/helpers/usdcx-config.test.ts`, `playwright/e2e/helpers/usdcx-l2-deposit.test.ts` (new), `playwright/e2e/helpers/usdcx-node-imports.test.ts`

**Interfaces:**
- Consumes: Task 1 (`runUsdcxExecutorDeposit`, `buildExecutorBurnIntent`, `quoteExecutorBurn`, `UsdcxExecutorDepositDeps`, `UsdcxExecutorSigner`, `ExecutorBurnIntent`, `DepositForBurnWithHookAndFeesArgs` from `src/lib/usdcx/executor.ts`; `TOKEN_MESSENGER_WITH_FEES_ABI`, `CIRCLE_USDC_DECIMALS` from `protocol.ts`). Since #1498, `UsdcxExecutorDepositDeps.readBalance(): Promise<bigint>` is required (the depositor's source USDC balance), and `runUsdcxExecutorDeposit` calls the deps in this order: `isRemoteDomainRegistered`, `readAllowance`, `readBalance`, `fetchQuote` (then `UsdcxExecutorBalanceTooLowError` when the balance is short of the amount plus the fee), and when the allowance is short `signer.approve`, `waitForReceipt`, `readBalance`, `fetchQuote` (the same balance check, then the approved-headroom check), then `signer.depositForBurnWithHookAndFees`, `updatePhase('submitting')`, `waitForReceipt`, `updatePhase('delivering')`.
- Produces:
  - `usdcx-config.ts`: `getUsdcxExecutorSource(chainId: number): UsdcxExecutorSource`.
  - `usdcx-constants.ts`: `interface L2BridgeInSource { payout: PayoutChain; source: UsdcxExecutorSource }`, `bridgeInSourceFor(payout: PayoutChain): L2BridgeInSource`, `L2_BRIDGE_IN_SOURCES: readonly L2BridgeInSource[]` (Base Sepolia, then Arbitrum Sepolia), `L2_BRIDGE_IN_GAS = 1_000_000n`.
  - `arc-usdcx.ts` exports: `ERC20_ABI`, `onFirstEndpoint`, `chainRead` (renamed from `arcRead`), `pickWriteEndpoint`, `simulate`, `sendSigned`, `waitForReceipt`, `startingAt`. Each reads `chainId` and `label` from `deps.payoutChain ?? ARC_PAYOUT`, so every Arc message stays word for word.
  - `usdcx-l2-deposit.ts`: `l2Reads(l2, overrides?): ArcReadDeps`; `interface L2KeyFunds { wei: bigint; usdc: bigint; maxFeePerGas: bigint }`; `readL2KeyFunds(address: Address, reads: ArcReadDeps): Promise<L2KeyFunds>`; `quoteL2Deposit(l2, { units, recipient, depositor }): Promise<CctpBurnQuote>`; `l2KeyShortfall(args: { label: string; address: Address; wei: bigint; maxFeePerGas: bigint; usdc: bigint; units: bigint; fee: bigint }): string | undefined`; `interface L2DepositSubmission { endpoint: string; approveHash?: Hash; burnHash: Hash; signed: { amount: bigint; destinationCaller: Hex; hookData: Hex }; quotes: CctpBurnQuote[]; burnQuote: CctpBurnQuote; submitted: { usdcxRemoteRecipient: string; cctp: IUsdcxCctpLeg } }`; `submitL2Deposit(args: { privateKey: Hex; l2: L2BridgeInSource; units: bigint; recipientHex: string; arc: ArcReadDeps }, deps?: { publicClient?; clock?; fetchQuote?; isRemoteDomainRegistered? }, signal?: AbortSignal): Promise<L2DepositSubmission>`.

- [ ] **Step 1: Write the failing tests**

Append to `playwright/e2e/helpers/usdcx-config.test.ts` (it already mocks the runtime to the fixture and imports `harness` and `wallet`):

```ts
it.each([84532, 421614])('reads the executor route of chain %i from the fixture as the wallet reads it', chainId => {
  const harnessRoute = harness.L2_BRIDGE_IN_SOURCES.find(l2 => l2.payout.chainId === chainId)?.source;
  const walletRoute = wallet.getUsdcxExecutorSource(chainId);
  const comparable = (route: typeof walletRoute | undefined) =>
    route && {
      route: route.route,
      chainId: route.chain.id,
      usdc: route.usdc,
      domain: route.domain,
      midenDomain: route.midenDomain,
      tokenMessengerWithFees: route.tokenMessengerWithFees,
      irisApi: route.irisApi,
      target: { ...route.target, chain: route.target.chain.id }
    };
  expect(comparable(harnessRoute)).toEqual(comparable(walletRoute));
});

it('lists Base Sepolia, then Arbitrum Sepolia, each read where usdcx-burn-l2 reads it', () => {
  expect(harness.L2_BRIDGE_IN_SOURCES.map(l2 => l2.payout)).toEqual([
    harness.BASE_SEPOLIA_PAYOUT,
    harness.ARBITRUM_SEPOLIA_PAYOUT
  ]);
});
```

Append to `playwright/e2e/helpers/usdcx-node-imports.test.ts`:

```ts
it('loads the L2 bridge-in deposit helper without the wallet runtime or the SDK', () => {
  const helper = jest.requireActual<typeof import('./usdcx-l2-deposit')>('./usdcx-l2-deposit');
  expect(typeof helper.submitL2Deposit).toBe('function');
});
```

Create `playwright/e2e/helpers/usdcx-l2-deposit.test.ts`:

```ts
/**
 * @jest-environment node
 */
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  isHex,
  keccak256,
  parseTransaction,
  toHex,
  type Hex,
  type PublicClient
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { ERC20_ABI } from './arc-usdcx';
import arcVectors from './arc-usdcx.vectors.json';
import { DEPOSIT_UNITS, L2_BRIDGE_IN_SOURCES, type L2BridgeInSource } from './usdcx-constants';
import { l2KeyShortfall, l2Reads, readL2KeyFunds, submitL2Deposit } from './usdcx-l2-deposit';
import type { CctpBurnQuote } from '../../../src/lib/usdcx/cctp';
import { buildDepositForBurnWithHookAndFeesArgs, buildExecutorBurnIntent } from '../../../src/lib/usdcx/executor';
import { TOKEN_MESSENGER_WITH_FEES_ABI } from '../../../src/lib/usdcx/protocol';
import { midenAccountHexToXReserveRecipient } from '../../../src/lib/usdcx/recipient';

const KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const { address: DEPOSITOR } = privateKeyToAccount(KEY);
const RECIPIENT_HEX = '0xf2f42cda8d010f417d1cad5dc4d52b';
const RECIPIENT = midenAccountHexToXReserveRecipient(RECIPIENT_HEX);
/** Circle's sandbox priced a 0.001 USDC forwarded burn at 22_404 on 2026-10-16; the second quote moved a little. */
const QUOTE: CctpBurnQuote = { signedQuote: '0x0102', feeTotalAmount: 22_404n };
const REQUOTE: CctpBurnQuote = { signedQuote: '0x0304', feeTotalAmount: 22_500n };
const CALL_ABI = [...ERC20_ABI, ...TOKEN_MESSENGER_WITH_FEES_ABI];

function baseSepolia(): L2BridgeInSource {
  const found = L2_BRIDGE_IN_SOURCES.find(l2 => l2.payout.chainId === 84532);
  if (!found) throw new Error('L2_BRIDGE_IN_SOURCES lost Base Sepolia');
  return found;
}

function dataOf(params: readonly unknown[]): Hex {
  const [request] = params;
  const data: unknown = request !== null && typeof request === 'object' ? Reflect.get(request, 'data') : undefined;
  if (!isHex(data)) throw new Error('eth_call without data');
  return data;
}

/**
 * One L2 behind a stub EIP-1193 provider: viem's own encoding, signing and decoding run, the chain answers are canned.
 * `balanceReads` keeps the calldata of every balanceOf read, so a test can tell whose balance the deposit read.
 */
function l2Chain(l2: L2BridgeInSource, opts: { allowance: bigint; usdc?: bigint; servedChainId?: number }) {
  const sent: Hex[] = [];
  const balanceReads: Hex[] = [];
  const rpc = (method: string, params: readonly unknown[]): unknown => {
    switch (method) {
      case 'eth_chainId':
        return toHex(opts.servedChainId ?? l2.payout.chainId);
      case 'eth_getTransactionCount':
        return '0x7';
      case 'eth_estimateGas':
        return '0xaae60';
      case 'eth_maxPriorityFeePerGas':
        return '0x5f5e100';
      case 'eth_getBlockByNumber':
        return {
          number: '0x10',
          hash: `0x${'11'.repeat(32)}`,
          timestamp: '0x6a87a0a0',
          baseFeePerGas: '0x5b8d80',
          transactions: []
        };
      case 'eth_getBalance':
        return '0x2386f26fc10000';
      case 'eth_call': {
        const data = dataOf(params);
        const { functionName } = decodeFunctionData({ abi: CALL_ABI, data });
        if (functionName === 'allowance') return encodeAbiParameters([{ type: 'uint256' }], [opts.allowance]);
        if (functionName === 'balanceOf') {
          balanceReads.push(data);
          return encodeAbiParameters([{ type: 'uint256' }], [opts.usdc ?? 1_977_802n]);
        }
        if (functionName === 'approve') return encodeAbiParameters([{ type: 'bool' }], [true]);
        return '0x';
      }
      case 'eth_sendRawTransaction': {
        const [raw] = params;
        if (raw === '0x00') throw Object.assign(new Error('failed to decode signed transaction'), { code: -32602 });
        if (!isHex(raw)) throw new Error('raw transaction is not hex');
        sent.push(raw);
        return keccak256(raw);
      }
      case 'eth_getTransactionReceipt':
        return { ...arcVectors.deposit.receipt, transactionHash: params[0], logs: [], status: '0x1' };
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  const client: PublicClient = createPublicClient({
    chain: l2.payout.chain,
    cacheTime: 0,
    transport: custom(
      {
        async request({ method, params }: { method: string; params?: unknown }) {
          return rpc(method, Array.isArray(params) ? params : []);
        }
      },
      { retryCount: 0 }
    )
  });
  return { sent, balanceReads, publicClient: () => client };
}

function quotesInTurn(...quotes: CctpBurnQuote[]) {
  return async () => {
    const next = quotes.shift();
    if (!next) throw new Error('asked for one quote too many');
    return next;
  };
}

describe('submitL2Deposit', () => {
  it("approves the amount and twice the fee, quotes again, then signs the product's forwarded burn on Base Sepolia", async () => {
    const l2 = baseSepolia();
    const chain = l2Chain(l2, { allowance: 0n });

    const submission = await submitL2Deposit(
      { privateKey: KEY, l2, units: DEPOSIT_UNITS, recipientHex: RECIPIENT_HEX, arc: { endpoints: [] } },
      {
        publicClient: chain.publicClient,
        isRemoteDomainRegistered: async () => true,
        fetchQuote: quotesInTurn(QUOTE, REQUOTE)
      }
    );

    const [approve, burn] = chain.sent.map(raw => parseTransaction(raw));
    expect([approve?.chainId, burn?.chainId, approve?.nonce, burn?.nonce]).toEqual([84532, 84532, 7, 8]);
    expect(approve?.to).toBe(l2.source.usdc.toLowerCase());
    expect(decodeFunctionData({ abi: CALL_ABI, data: approve?.data ?? '0x' })).toEqual({
      functionName: 'approve',
      args: [l2.source.tokenMessengerWithFees, DEPOSIT_UNITS + 2n * QUOTE.feeTotalAmount]
    });
    const intent = buildExecutorBurnIntent(formatUnits(DEPOSIT_UNITS, 6), l2.source, RECIPIENT, DEPOSITOR);
    const burnArgs = buildDepositForBurnWithHookAndFeesArgs(l2.source, intent, REQUOTE, DEPOSITOR);
    expect(burn?.to).toBe(l2.source.tokenMessengerWithFees.toLowerCase());
    // Compared as calldata: decoding lowercases bytes32 and bytes, while addressToBytes32 keeps the checksum's case.
    expect(burn?.data).toBe(
      encodeFunctionData({
        abi: TOKEN_MESSENGER_WITH_FEES_ABI,
        functionName: 'depositForBurnWithHookAndFees',
        args: burnArgs
      }).toLowerCase()
    );
    expect(submission).toEqual({
      endpoint: l2.payout.rpcUrls[0],
      approveHash: keccak256(chain.sent[0] ?? '0x'),
      burnHash: keccak256(chain.sent[1] ?? '0x'),
      signed: { amount: DEPOSIT_UNITS, destinationCaller: intent.destinationCaller, hookData: intent.hookData },
      quotes: [QUOTE, REQUOTE],
      burnQuote: REQUOTE,
      submitted: {
        usdcxRemoteRecipient: RECIPIENT.toLowerCase(),
        cctp: { sourceDomain: 6, forwarded: true, forwardFee: '22500' }
      }
    });
    // runUsdcxExecutorDeposit reads the key's own USDC before the first quote and again once the approve is mined.
    const keyBalance = encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [DEPOSITOR] });
    expect(chain.balanceReads).toEqual([keyBalance, keyBalance]);
  });

  it('sends no approve when the allowance covers the amount and the fee', async () => {
    const l2 = baseSepolia();
    const chain = l2Chain(l2, { allowance: 1_000_000n });

    const submission = await submitL2Deposit(
      { privateKey: KEY, l2, units: DEPOSIT_UNITS, recipientHex: RECIPIENT_HEX, arc: { endpoints: [] } },
      { publicClient: chain.publicClient, isRemoteDomainRegistered: async () => true, fetchQuote: quotesInTurn(QUOTE) }
    );

    expect(chain.sent.map(raw => parseTransaction(raw).nonce)).toEqual([7]);
    expect([submission.approveHash, submission.quotes, chain.balanceReads.length]).toEqual([undefined, [QUOTE], 1]);
  });

  // The product's own check (#1498), past the spec's l2_key step: the burn pulls Circle's fee on top of the amount.
  it("sends nothing when the key's USDC does not cover the amount and Circle's fee", async () => {
    const l2 = baseSepolia();
    const chain = l2Chain(l2, { allowance: 0n, usdc: DEPOSIT_UNITS + QUOTE.feeTotalAmount - 1n });

    await expect(
      submitL2Deposit(
        { privateKey: KEY, l2, units: DEPOSIT_UNITS, recipientHex: RECIPIENT_HEX, arc: { endpoints: [] } },
        { publicClient: chain.publicClient, isRemoteDomainRegistered: async () => true, fetchQuote: quotesInTurn(QUOTE) }
      )
    ).rejects.toThrow('The burn needs 23404 USDC base units, the amount plus a fee of 22404, but the balance is 23403');
    expect(chain.sent).toEqual([]);
  });

  it('sends nothing when Arc has not registered Miden', async () => {
    const l2 = baseSepolia();
    const chain = l2Chain(l2, { allowance: 0n });

    await expect(
      submitL2Deposit(
        { privateKey: KEY, l2, units: DEPOSIT_UNITS, recipientHex: RECIPIENT_HEX, arc: { endpoints: [] } },
        { publicClient: chain.publicClient, isRemoteDomainRegistered: async () => false, fetchQuote: quotesInTurn(QUOTE) }
      )
    ).rejects.toThrow('xReserve remote domain 10007 is not registered');
    expect(chain.sent).toEqual([]);
  });

  it('sends nothing once its step ran out of budget', async () => {
    const l2 = baseSepolia();
    const chain = l2Chain(l2, { allowance: 0n });
    const step = new AbortController();
    step.abort(new Error('deposit_submit exceeded its 300000 ms budget'));

    await expect(
      submitL2Deposit(
        { privateKey: KEY, l2, units: DEPOSIT_UNITS, recipientHex: RECIPIENT_HEX, arc: { endpoints: [] } },
        { publicClient: chain.publicClient, isRemoteDomainRegistered: async () => true, fetchQuote: quotesInTurn(QUOTE) },
        step.signal
      )
    ).rejects.toThrow('USDC approve not sent');
    expect(chain.sent).toEqual([]);
  });

  it('refuses an endpoint that serves another chain, naming Base Sepolia', async () => {
    const l2 = baseSepolia();
    const chain = l2Chain(l2, { allowance: 0n, servedChainId: 5042002 });

    await expect(
      submitL2Deposit(
        { privateKey: KEY, l2, units: DEPOSIT_UNITS, recipientHex: RECIPIENT_HEX, arc: { endpoints: [] } },
        { publicClient: chain.publicClient, isRemoteDomainRegistered: async () => true, fetchQuote: quotesInTurn(QUOTE) }
      )
    ).rejects.toThrow('no Base Sepolia endpoint takes writes');
  });
});

describe('readL2KeyFunds', () => {
  it("reads the key's ETH, its USDC and the fee a send would bid, on one endpoint", async () => {
    const l2 = baseSepolia();
    const funds = await readL2KeyFunds(DEPOSITOR, l2Reads(l2, { publicClient: l2Chain(l2, { allowance: 0n }).publicClient }));

    expect({ wei: funds.wei, usdc: funds.usdc }).toEqual({ wei: 10_000_000_000_000_000n, usdc: 1_977_802n });
    expect(funds.maxFeePerGas).toBeGreaterThanOrEqual(100_000_000n);
  });
});

describe('l2KeyShortfall', () => {
  const enough = { label: 'Base Sepolia', address: DEPOSITOR, maxFeePerGas: 7_200_000n, units: 1_000n, fee: 22_404n };

  it('asks for ETH first, naming the chain, the address and the minimum', () => {
    expect(l2KeyShortfall({ ...enough, wei: 0n, usdc: 0n })).toBe(
      `top up the key on Base Sepolia: ${DEPOSITOR} holds 0 ETH, below the 0.0000072 ETH one bridge-in needs ` +
        `(1000000 gas at 0.0072 gwei); send Base Sepolia ETH to ${DEPOSITOR}`
    );
  });

  it('asks for USDC to cover the deposit and twice the fee its approve covers', () => {
    expect(l2KeyShortfall({ ...enough, wei: 10n ** 16n, usdc: 40_000n })).toBe(
      `top up the key on Base Sepolia: ${DEPOSITOR} holds 0.04 USDC, below the 0.045808 USDC one bridge-in needs ` +
        "(the 0.001 deposit and twice Circle's 0.022404 fee, which its approve covers); a green usdcx-burn-l2 run " +
        'pays it about 0.99 USDC there'
    );
  });

  it('asks for nothing when both suffice', () => {
    expect(l2KeyShortfall({ ...enough, wei: 10n ** 16n, usdc: 1_977_802n })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx jest --maxWorkers=1 playwright/e2e/helpers/usdcx-l2-deposit.test.ts playwright/e2e/helpers/usdcx-config.test.ts playwright/e2e/helpers/usdcx-node-imports.test.ts`
Expected: FAIL: `Cannot find module './usdcx-l2-deposit'`; `harness.L2_BRIDGE_IN_SOURCES` is undefined.

- [ ] **Step 3: Add `getUsdcxExecutorSource` to `usdcx-config.ts`**

Change the type import to `import type { UsdcxDestination, UsdcxExecutorSource, UsdcxXReserveSource } from '../../../src/lib/usdcx/constant';` and append:

```ts
/** The executor route the fixture names for `chainId`, built as the wallet's usdcxSourceChains builds it. */
export function getUsdcxExecutorSource(chainId: number): UsdcxExecutorSource {
  const chain = EVM_CHAIN_DEFINITIONS.find(candidate => candidate.id === chainId);
  const route = Object.values(document.supportedEvmChains).find(entry => entry.chainId === chainId)?.bridges.usdcx;
  const deposit = route?.deposit;
  if (!chain || !route || !deposit || !('tokenMessengerWithFees' in deposit)) {
    throw new Error(`chain ${chainId} is no executor source in the testnet fixture`);
  }
  return {
    route: 'cctp-executor',
    chain,
    usdc: address(route.tokens.USDC.contractAddress),
    domain: route.domain,
    midenDomain: provider.midenDomain,
    tokenMessengerWithFees: address(deposit.tokenMessengerWithFees),
    irisApi: provider.irisUrl,
    target: {
      midenDomain: provider.midenDomain,
      chain: ARC_TESTNET,
      domain: arc.domain,
      executor: address(arc.executor.address),
      handler: address(arc.executor.handler),
      xReserve: address(arc.deposit.xReserve),
      usdc: address(arc.tokens.USDC.contractAddress),
      attestationApi: provider.attestationUrl,
      irisApi: provider.irisUrl
    }
  };
}
```

- [ ] **Step 4: Append the L2 bridge-in list to `usdcx-constants.ts`**

Add `getUsdcxExecutorSource` to the `./usdcx-config` import and `import type { UsdcxExecutorSource } from '../../../src/lib/usdcx/constant';`, then append after `ARBITRUM_SEPOLIA_PAYOUT`:

```ts
/**
 * A chain usdcx-in-l2 deposits from: where it is read (the PayoutChain usdcx-burn-l2 pays on, so both suites read the
 * same endpoints) and the executor route the fixture names for it.
 */
export interface L2BridgeInSource {
  payout: PayoutChain;
  source: UsdcxExecutorSource;
}

export function bridgeInSourceFor(payout: PayoutChain): L2BridgeInSource {
  return { payout, source: getUsdcxExecutorSource(payout.chainId) };
}

export const L2_BRIDGE_IN_SOURCES: readonly L2BridgeInSource[] = [
  bridgeInSourceFor(BASE_SEPOLIA_PAYOUT),
  bridgeInSourceFor(ARBITRUM_SEPOLIA_PAYOUT)
];

/**
 * One bridge-in's gas on an L2: an approve (about 55k) and the forwarded burn (693-699k on Base Sepolia, 698,683 with no
 * L1 gas on Arbitrum Sepolia, read 2026-10-16), each sent at 1.2x its estimate.
 */
export const L2_BRIDGE_IN_GAS = 1_000_000n;
```

- [ ] **Step 5: Make the write and read internals of `arc-usdcx.ts` chain-generic and export them**

- `const ERC20_ABI = parseAbi([...])` becomes `export const ERC20_ABI = ...`.
- `async function onFirstEndpoint` becomes `export async function onFirstEndpoint`.
- Rename `arcRead` to `chainRead` (definition and its callers in this file) and export it.
- `pickWriteEndpoint`, `simulate`, `waitForReceipt`, `startingAt` gain `export` and a one-line doc tail "Shared with usdcx-l2-deposit.ts and usdcx-cctp-proof.ts."
- In `pickWriteEndpoint`:

```ts
export async function pickWriteEndpoint(deps: ArcWriteDeps): Promise<string> {
  const { chainId, label } = chainOf(deps);
  const failures: string[] = [];
  for (const endpoint of deps.endpoints) {
    const client = clientFor(deps)(endpoint);
    try {
      const served = await client.getChainId();
      if (served !== chainId) failures.push(`${arcHost(endpoint)}: chain ${served}`);
      else if (await acceptsRawTransactions(client)) return endpoint;
      else failures.push(`${arcHost(endpoint)}: refuses eth_sendRawTransaction`);
    } catch (error) {
      failures.push(`${arcHost(endpoint)}: ${errorText(error)}`);
    }
  }
  throw new Error(`no ${label} endpoint takes writes\n  ${failures.join('\n  ') || 'no endpoints'}`);
}
```

- In `sendSigned` (now exported), take `const { chainId, label } = chainOf(deps);`; the two reads are named `` `${label} gas estimate` `` and `` `${label} fee estimate` ``; sign with `chainId` in place of `ARC_CHAIN_ID`; the send failure reads `` `${label} transaction ${hash} was not sent on ${arcHost(endpoint)}: ...` ``.
- In `waitForReceipt`, take `const { label } = chainOf(deps);` and write `${label} transaction` where it writes `Arc transaction` (three messages).
- The file's header sentence "Never imports usdcx/deposit.ts or executor.ts: they pull in lib/miden/activity and with it the wallet's SDK." becomes "Never imports usdcx/deposit.ts, which pulls in lib/miden/activity and with it the wallet's SDK." (`executor.ts` loads in Node after Task 1; `usdcx-node-imports.test.ts` pins it.)

`ARC_PAYOUT.label` is `'Arc'`, so every existing Arc message is unchanged and `arc-usdcx.test.ts` stays green.

- [ ] **Step 6: Create `playwright/e2e/helpers/usdcx-l2-deposit.ts`**

```ts
/**
 * The source-chain leg of a usdcx-in-l2 deposit, signed in Node with the harness key. The wallet's own
 * runUsdcxExecutorDeposit (usdcx/executor.ts) drives it, so the balance checks, the quote, the approve for the amount plus
 * twice the fee, the second quote and the forwarded burn are the product's; only the signer, the chain reads and the
 * row write are the harness's.
 */
import { encodeFunctionData, formatEther, formatGwei, formatUnits, type Address, type Hash, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  chainRead,
  ERC20_ABI,
  onFirstEndpoint,
  pickWriteEndpoint,
  readXReserveDomainState,
  sendSigned,
  simulate,
  startingAt,
  waitForReceipt,
  type ArcReadDeps
} from './arc-usdcx';
import { L2_BRIDGE_IN_GAS, USDCX_REMOTE_DOMAIN, type L2BridgeInSource } from './usdcx-constants';
import type { IUsdcxCctpLeg } from '../../../src/lib/miden/db/types';
import type { CctpBurnQuote } from '../../../src/lib/usdcx/cctp';
import {
  buildExecutorBurnIntent,
  quoteExecutorBurn,
  runUsdcxExecutorDeposit,
  type DepositForBurnWithHookAndFeesArgs,
  type ExecutorBurnIntent,
  type UsdcxExecutorDepositDeps,
  type UsdcxExecutorSigner
} from '../../../src/lib/usdcx/executor';
import { CIRCLE_USDC_DECIMALS, TOKEN_MESSENGER_WITH_FEES_ABI } from '../../../src/lib/usdcx/protocol';
import { midenAccountHexToXReserveRecipient } from '../../../src/lib/usdcx/recipient';

export function l2Reads(
  l2: L2BridgeInSource,
  overrides: Pick<ArcReadDeps, 'publicClient' | 'clock'> = {}
): ArcReadDeps {
  return { endpoints: l2.payout.rpcUrls, payoutChain: l2.payout, ...overrides };
}

export interface L2KeyFunds {
  wei: bigint;
  usdc: bigint;
  /** What a send bids per gas now; the node refuses a transaction the balance cannot cover at this price. */
  maxFeePerGas: bigint;
}

export async function readL2KeyFunds(address: Address, reads: ArcReadDeps): Promise<L2KeyFunds> {
  const chain = reads.payoutChain;
  if (!chain) throw new Error('readL2KeyFunds reads an L2: its deps name no payoutChain');
  return onFirstEndpoint(reads, `${chain.label} funds of ${address}`, async client => ({
    wei: await client.getBalance({ address }),
    usdc: await client.readContract({ address: chain.usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] }),
    maxFeePerGas: (await client.estimateFeesPerGas()).maxFeePerGas
  }));
}

/** Circle's live quote for the deposit, bound to the hook data the product builds for this recipient and depositor. */
export function quoteL2Deposit(
  l2: L2BridgeInSource,
  args: { units: bigint; recipient: Hex; depositor: Address }
): Promise<CctpBurnQuote> {
  const amount = formatUnits(args.units, CIRCLE_USDC_DECIMALS);
  return quoteExecutorBurn(l2.source, buildExecutorBurnIntent(amount, l2.source, args.recipient, args.depositor));
}

/**
 * What the key lacks for one deposit on `label`, or undefined. ETH first, at L2_BRIDGE_IN_GAS and the live fee; then USDC
 * for the deposit and twice the quoted fee, since the approve covers twice the fee and the second quote may use it.
 */
export function l2KeyShortfall(args: {
  label: string;
  address: Address;
  wei: bigint;
  maxFeePerGas: bigint;
  usdc: bigint;
  units: bigint;
  fee: bigint;
}): string | undefined {
  const head = `top up the key on ${args.label}: ${args.address} holds`;
  const needWei = L2_BRIDGE_IN_GAS * args.maxFeePerGas;
  if (args.wei < needWei) {
    return (
      `${head} ${formatEther(args.wei)} ETH, below the ${formatEther(needWei)} ETH one bridge-in needs ` +
      `(${L2_BRIDGE_IN_GAS} gas at ${formatGwei(args.maxFeePerGas)} gwei); send ${args.label} ETH to ${args.address}`
    );
  }
  const needUsdc = args.units + 2n * args.fee;
  if (args.usdc < needUsdc) {
    const usdc = (units: bigint) => formatUnits(units, CIRCLE_USDC_DECIMALS);
    return (
      `${head} ${usdc(args.usdc)} USDC, below the ${usdc(needUsdc)} USDC one bridge-in needs (the ${usdc(args.units)} ` +
      `deposit and twice Circle's ${usdc(args.fee)} fee, which its approve covers); a green usdcx-burn-l2 run pays it ` +
      'about 0.99 USDC there'
    );
  }
  return undefined;
}

export interface L2DepositSubmission {
  /** The endpoint that took the writes; reads of this deposit start there. */
  endpoint: string;
  approveHash?: Hash;
  burnHash: Hash;
  /** The forwarded burn's amount, caller and hook data exactly as the signer received them: what the gates compare. */
  signed: { amount: bigint; destinationCaller: Hex; hookData: Hex };
  /** Every quote the deposit took, in order. */
  quotes: CctpBurnQuote[];
  /** The quote the burn carried: the last one. */
  burnQuote: CctpBurnQuote;
  /** What runUsdcxExecutorDeposit wrote on its `submitting` step, replayed on the wallet's row by the test hook. */
  submitted: { usdcxRemoteRecipient: string; cctp: IUsdcxCctpLeg };
}

/**
 * Deposits `units` from the key on `l2` to the Miden account `recipientHex` through runUsdcxExecutorDeposit. Writes go to
 * one endpoint that takes raw transactions, with a local nonce; reads and receipts fail over. Each send is simulated
 * first. Returns once the burn is mined. Nothing more is sent once `signal` is aborted. A key whose USDC does not cover
 * the amount plus the quoted fee is refused by the product before the approve, and again after it before the burn.
 */
export async function submitL2Deposit(
  args: { privateKey: Hex; l2: L2BridgeInSource; units: bigint; recipientHex: string; arc: ArcReadDeps },
  deps: Pick<ArcReadDeps, 'publicClient' | 'clock'> & {
    fetchQuote?: UsdcxExecutorDepositDeps['fetchQuote'];
    isRemoteDomainRegistered?: UsdcxExecutorDepositDeps['isRemoteDomainRegistered'];
  } = {},
  signal?: AbortSignal
): Promise<L2DepositSubmission> {
  const { l2 } = args;
  const reads = l2Reads(l2, { publicClient: deps.publicClient, clock: deps.clock });
  const account = privateKeyToAccount(args.privateKey);
  const remoteRecipient = midenAccountHexToXReserveRecipient(args.recipientHex);
  const amount = formatUnits(args.units, CIRCLE_USDC_DECIMALS);
  const endpoint = await pickWriteEndpoint(reads);
  const endpoints = { write: endpoint, reads: startingAt(reads.endpoints, endpoint) };
  let nonce = await chainRead(`${l2.payout.label} nonce`, endpoints.reads, reads, client =>
    client.getTransactionCount({ address: account.address, blockTag: 'pending' })
  );
  const send = async (what: string, to: Address, data: Hex): Promise<Hash> => {
    const hash = await sendSigned(reads, endpoints, account, { what, to, data, nonce }, signal);
    nonce += 1;
    return hash;
  };
  let approveHash: Hash | undefined;
  // An array, not a `let`: TypeScript keeps a `let` assigned in a callback narrowed to its initial undefined.
  const signedBurns: DepositForBurnWithHookAndFeesArgs[] = [];
  const signer: UsdcxExecutorSigner = {
    approve: async (spender, value) => {
      await simulate('USDC approve', endpoints.write, reads, client =>
        client.simulateContract({
          account: account.address,
          address: l2.source.usdc,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [spender, value]
        })
      );
      approveHash = await send(
        'USDC approve',
        l2.source.usdc,
        encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, value] })
      );
      return approveHash;
    },
    depositForBurnWithHookAndFees: async burn => {
      await simulate('forwarded burn', endpoints.write, reads, client =>
        client.simulateContract({
          account: account.address,
          address: l2.source.tokenMessengerWithFees,
          abi: TOKEN_MESSENGER_WITH_FEES_ABI,
          functionName: 'depositForBurnWithHookAndFees',
          args: burn
        })
      );
      signedBurns.push(burn);
      return send(
        'forwarded burn',
        l2.source.tokenMessengerWithFees,
        encodeFunctionData({ abi: TOKEN_MESSENGER_WITH_FEES_ABI, functionName: 'depositForBurnWithHookAndFees', args: burn })
      );
    }
  };
  const quotes: CctpBurnQuote[] = [];
  const fetchQuote = deps.fetchQuote ?? ((intent: ExecutorBurnIntent) => quoteExecutorBurn(l2.source, intent));
  const writes: Array<Parameters<UsdcxExecutorDepositDeps['updatePhase']>> = [];
  const burnHash = await runUsdcxExecutorDeposit('harness-signed', amount, remoteRecipient, {
    source: l2.source,
    depositor: account.address,
    signer,
    isRemoteDomainRegistered:
      deps.isRemoteDomainRegistered ??
      (async domain => domain === USDCX_REMOTE_DOMAIN && (await readXReserveDomainState(args.arc)).registered),
    readAllowance: spender =>
      chainRead('USDC allowance', endpoints.reads, reads, client =>
        client.readContract({
          address: l2.source.usdc,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [account.address, spender]
        })
      ),
    readBalance: () =>
      chainRead('USDC balance', endpoints.reads, reads, client =>
        client.readContract({
          address: l2.source.usdc,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [account.address]
        })
      ),
    waitForReceipt: async hash => {
      await waitForReceipt(endpoints.reads, reads, hash);
    },
    updatePhase: async (...write) => {
      writes.push(write);
    },
    fetchQuote: async intent => {
      const quote = await fetchQuote(intent);
      quotes.push(quote);
      return quote;
    }
  });
  const submitting = writes.find(([, phase]) => phase === 'submitting')?.[2];
  const burnQuote = quotes.at(-1);
  const [signedBurn] = signedBurns;
  if (!signedBurn || !submitting?.cctp || submitting.usdcxRemoteRecipient === undefined || !burnQuote) {
    throw new Error(`the deposit ${burnHash} signed no burn, or wrote no forwarded CCTP leg, recipient or quote`);
  }
  const [signedAmount, , , , destinationCaller, hookData] = signedBurn;
  return {
    endpoint,
    approveHash,
    burnHash,
    signed: { amount: signedAmount, destinationCaller, hookData },
    quotes,
    burnQuote,
    submitted: { usdcxRemoteRecipient: submitting.usdcxRemoteRecipient, cctp: submitting.cctp }
  };
}
```

- [ ] **Step 7: Run the new tests and every test in `playwright/e2e/helpers/`**

Run: `npx jest --maxWorkers=1 playwright/e2e/helpers/`
Expected: PASS, `arc-usdcx.test.ts` unchanged and green (its messages still say `Arc`).

- [ ] **Step 8: Mutation checks**

| Mutation | Predicted failure |
|---|---|
| `sendSigned` signs with `ARC_CHAIN_ID` again | "approves the amount..." (`chainId` 5042002) |
| `pickWriteEndpoint` compares to `ARC_CHAIN_ID` | every `submitL2Deposit` test (no Base Sepolia endpoint takes writes) |
| Drop `nonce += 1` | "approves the amount..." (nonces `[7, 7]`) |
| Record no quote in the `fetchQuote` wrapper | "approves the amount..." (throws: no quote) |
| Record no burn in `signedBurns` | "approves the amount..." (throws: signed no burn) |
| `readBalance` reads `allowance(key, spender)` instead of `balanceOf(key)` | "approves the amount..." (the balance reads 0, so the product throws `UsdcxExecutorBalanceTooLowError` before the approve) and "sends nothing when the key's USDC..." (the message names a balance of 0, not 23403) |
| `readBalance` reads `balanceOf(l2.source.tokenMessengerWithFees)` | "approves the amount..." (`balanceReads` name the fee entry point, not the key) |
| `needUsdc = units + fee` | "asks for USDC..." (returns undefined: 40_000 covers 23_404) |

For the first `readBalance` row, keep `abi: ERC20_ABI` and change `functionName` to `'allowance'` and `args` to `[account.address, l2.source.tokenMessengerWithFees]`: the stub answers it with the test's `allowance`.

Run each with `npx jest --maxWorkers=1 playwright/e2e/helpers/usdcx-l2-deposit.test.ts`, restore, rerun green.

- [ ] **Step 9: Format and lint**

Run: `F="playwright/e2e/helpers/usdcx-config.ts playwright/e2e/helpers/usdcx-constants.ts playwright/e2e/helpers/arc-usdcx.ts playwright/e2e/helpers/usdcx-l2-deposit.ts playwright/e2e/helpers/usdcx-config.test.ts playwright/e2e/helpers/usdcx-l2-deposit.test.ts playwright/e2e/helpers/usdcx-node-imports.test.ts"; npx prettier --check ${=F} && npx eslint --max-warnings 0 ${=F} && npx eslint --no-eslintrc -c .eslintrc.harness.json --rulesdir playwright/e2e/eslint-rules --max-warnings 0 ${=F}`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add playwright/e2e/helpers/usdcx-config.ts playwright/e2e/helpers/usdcx-constants.ts playwright/e2e/helpers/arc-usdcx.ts playwright/e2e/helpers/usdcx-l2-deposit.ts playwright/e2e/helpers/usdcx-config.test.ts playwright/e2e/helpers/usdcx-l2-deposit.test.ts playwright/e2e/helpers/usdcx-node-imports.test.ts
git commit -m "test(e2e): sign the l2 bridge-in through the wallet's own executor deposit"
```

### Task 4: chain-evidence gates: the source burn, Circle's attestation and forward, the Arc execution

**Files:**
- Create: `playwright/e2e/helpers/usdcx-bridge-in.vectors.json` (captured, see Step 1)
- Create: `playwright/e2e/helpers/usdcx-cctp-proof.ts`
- Modify: `playwright/e2e/helpers/arc-usdcx.ts:956-996` (extract `depositedToRemoteOf` from `confirmDepositToMiden`)
- Test: `playwright/e2e/helpers/usdcx-cctp-proof.test.ts` (new)

**Interfaces:**
- Consumes: Task 3 (`L2BridgeInSource`, `L2DepositSubmission`, `waitForReceipt`, `startingAt`, `errorText`); product `fetchCctpMessages`, `isCctpForwardFailed`, `CctpMessage` (`cctp.ts`), `addressToBytes32` (`executor.ts`), `GENERIC_EXECUTOR_ABI` (`protocol.ts`).
- Produces:
  - `arc-usdcx.ts`: `depositedToRemoteOf(receipt: TransactionReceipt, what: string): DepositedToRemoteEvent` (exactly one `DepositedToRemote` from `ARC_XRESERVE`, or throws).
  - `usdcx-cctp-proof.ts`: `interface CctpMessageFields { version; sourceDomain; destinationDomain; nonce: Hex; sender: Hex; recipient: Hex; destinationCaller: Hex; minFinalityThreshold; finalityThresholdExecuted; body: { version; burnToken: Hex; mintRecipient: Hex; amount: bigint; messageSender: Hex; maxFee: bigint; feeExecuted: bigint; expirationBlock: bigint; hookData: Hex } }`; `decodeCctpMessage(message: Hex): CctpMessageFields`; `sameBurnMessage(sent: Hex, attested: Hex): boolean`; `interface L2BurnProof { sentMessage: Hex; fields: CctpMessageFields; debit: bigint; blockNumber: bigint }`; `confirmL2Burn(submission, expected: { l2; units: bigint; depositor: Address }, reads: ArcReadDeps): Promise<L2BurnProof>`; `interface IrisForward { nonce: Hex; forwardTxHash: Hash; forwardState?: string; seenAtMs: number }`; `waitForIrisForward(args: { l2; burnHash: Hash; sentMessage: Hex }, opts: { timeoutMs: number; pollMs?: number; clock?: ArcClock; fetchMessages?: typeof fetchCctpMessages }): Promise<IrisForward>`; `interface ArcForwardProof { blockNumber: bigint; deposit: DepositedToRemoteEvent }`; `confirmArcForward(forwardTxHash: Hash, expected: { l2; nonce: Hex; units: bigint; remoteRecipient: Hex; remoteToken: Hex }, arc: ArcReadDeps): Promise<ArcForwardProof>`.

- [ ] **Step 1: Capture the vectors (three read-only calls, public data)**

Another party's 5 USDC Base Sepolia executor deposit of 2026-10-16 15:29Z: burn `0xdb8c...ec59`, Arc forward `0x4247...6116`, CCTP nonce `0x2a9c...b054`, Miden recipient `...e0fea500`.

```bash
cd /Users/celrisen/miden/wt-usdcx-bridge-in-l2 && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && node --input-type=module -e '
import { writeFileSync } from "node:fs";
const rpc = async (url, method, params) => {
  const reply = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await reply.json();
  if (!body.result) throw new Error(method + " on " + url + ": " + JSON.stringify(body.error));
  return body.result;
};
const burnHash = "0xdb8c3580aa0fe811b692758c6f50349f6e250a607c01bd348faaa2ec18c2ec59";
const forwardHash = "0x4247d8f8e4786467aad025ce514b2cdcd72bc7fe3757a8f6aa7273ef48256116";
const vectors = {
  source: "A third-party 5 USDC executor deposit from Base Sepolia (84532) of 2026-10-16 15:29Z: its burn receipt (publicnode), Iris sandbox message, and Arc Testnet forward receipt (QuickNode), captured 2026-10-16; public chain and Iris data only",
  burn: { chainId: 84532, transactionHash: burnHash, receipt: await rpc("https://base-sepolia-rpc.publicnode.com", "eth_getTransactionReceipt", [burnHash]) },
  iris: { sourceDomain: 6, body: await (await fetch("https://iris-api-sandbox.circle.com/v2/messages/6?transactionHash=" + burnHash)).json() },
  forward: { transactionHash: forwardHash, receipt: await rpc("https://rpc.quicknode.testnet.arc.io", "eth_getTransactionReceipt", [forwardHash]) },
  expected: {
    depositor: "0x92a119667e0e6733116a8d6416a66b2ce8dc0e94",
    units: "5000000",
    fee: "23053",
    nonce: "0x2a9cf3d4a8817e94fb00e1a17f1d1decc5b136109af01c054ecb69cce9c4b054",
    remoteRecipient: "0x00000000000000000000000000000000e7f744a6a1a1cf9142ee11e3e0fea500",
    remoteToken: "0x000000000000000000000000000000004cbdcaffe75f0a317482224dae643600"
  }
};
writeFileSync("playwright/e2e/helpers/usdcx-bridge-in.vectors.json", JSON.stringify(vectors, null, 2) + "\n");
'
```

Check: `python3 -I -c 'import json;v=json.load(open("playwright/e2e/helpers/usdcx-bridge-in.vectors.json"));print(len(v["burn"]["receipt"]["logs"]), v["iris"]["body"]["messages"][0]["forwardState"], len(v["forward"]["receipt"]["logs"]))'` prints `16 COMPLETE 17` (as read on 2026-10-16).

- [ ] **Step 2: Write the failing tests**

Create `playwright/e2e/helpers/usdcx-cctp-proof.test.ts`:

```ts
/**
 * @jest-environment node
 */
import { createPublicClient, custom, isHex, pad, type Chain, type Hex, type PublicClient } from 'viem';
import { baseSepolia } from 'viem/chains';

import { type ArcClock } from './arc-usdcx';
import vectors from './usdcx-bridge-in.vectors.json';
import { L2_BRIDGE_IN_SOURCES, type L2BridgeInSource } from './usdcx-constants';
import {
  confirmArcForward,
  confirmL2Burn,
  decodeCctpMessage,
  sameBurnMessage,
  waitForIrisForward
} from './usdcx-cctp-proof';
import type { L2DepositSubmission } from './usdcx-l2-deposit';
import type { CctpMessage } from '../../../src/lib/usdcx/cctp';
import { addressToBytes32 } from '../../../src/lib/usdcx/executor';
import { ARC_TESTNET } from '../../../src/lib/walletconnect/config';

function hex(value: unknown): Hex {
  if (!isHex(value)) throw new Error(`${String(value)} is not hex`);
  return value;
}

const BASE = L2_BRIDGE_IN_SOURCES.find(l2 => l2.payout.chainId === baseSepolia.id);
if (!BASE) throw new Error('L2_BRIDGE_IN_SOURCES lost Base Sepolia');
const L2: L2BridgeInSource = BASE;
const UNITS = BigInt(vectors.expected.units);
const FEE = BigInt(vectors.expected.fee);
const NONCE = hex(vectors.expected.nonce);
const BURN_HASH = hex(vectors.burn.transactionHash);
const FORWARD_HASH = hex(vectors.forward.transactionHash);
const DEPOSITOR = hex(vectors.expected.depositor);
const [IRIS_ENTRY] = vectors.iris.body.messages;
if (!IRIS_ENTRY) throw new Error('the vectors lost their Iris message');
const IRIS_MESSAGE = hex(IRIS_ENTRY.message);

/** A client whose every receipt read answers `receipt` for the hash asked, through viem's own receipt formatter. */
function receiptClient(chain: Chain, receipt: unknown): PublicClient {
  return createPublicClient({
    chain,
    cacheTime: 0,
    transport: custom(
      {
        async request({ method, params }: { method: string; params?: unknown }) {
          if (method !== 'eth_getTransactionReceipt') throw new Error(`unexpected ${method}`);
          const [hash] = Array.isArray(params) ? params : [];
          return { ...(receipt !== null && typeof receipt === 'object' ? receipt : {}), transactionHash: hash };
        }
      },
      { retryCount: 0 }
    )
  });
}

function fakeClock(): ArcClock & { slept: number[] } {
  let now = 0;
  const slept: number[] = [];
  return { slept, now: () => now, sleep: async ms => { slept.push(ms); now += ms; } };
}

const baseReads = (receipt: unknown = vectors.burn.receipt) => ({
  endpoints: L2.payout.rpcUrls,
  payoutChain: L2.payout,
  publicClient: () => receiptClient(baseSepolia, receipt),
  clock: fakeClock()
});
const arcReads = (receipt: unknown = vectors.forward.receipt) => ({
  endpoints: ['https://rpc.quicknode.testnet.arc.io'],
  publicClient: () => receiptClient(ARC_TESTNET, receipt),
  clock: fakeClock()
});

/** The captured burn's MessageSent message, read through the gate itself. */
async function sentMessage(): Promise<Hex> {
  const proof = await confirmL2Burn(submission(), { l2: L2, units: UNITS, depositor: DEPOSITOR }, baseReads());
  return proof.sentMessage;
}

/** The deposit as the key would have signed it: the captured burn's own hook data and fee. */
function submission(overrides: Partial<L2DepositSubmission> = {}): L2DepositSubmission {
  const hookData = decodeCctpMessage(IRIS_MESSAGE).body.hookData;
  const quote = { signedQuote: hex('0x'), feeTotalAmount: FEE };
  return {
    endpoint: L2.payout.rpcUrls[0] ?? '',
    burnHash: BURN_HASH,
    signed: { amount: UNITS, destinationCaller: addressToBytes32(L2.source.target.executor), hookData },
    quotes: [quote],
    burnQuote: quote,
    submitted: { usdcxRemoteRecipient: vectors.expected.remoteRecipient, cctp: { sourceDomain: 6, forwarded: true, forwardFee: vectors.expected.fee } },
    ...overrides
  };
}

const irisEntry = (overrides: Partial<CctpMessage> = {}): CctpMessage => ({
  message: IRIS_MESSAGE,
  attestation: hex(IRIS_ENTRY.attestation),
  status: 'complete',
  eventNonce: NONCE,
  forwardState: 'COMPLETE',
  forwardTxHash: FORWARD_HASH,
  ...overrides
});

describe('decodeCctpMessage', () => {
  it("reads the captured burn's CCTP V2 message and its burn body", () => {
    const fields = decodeCctpMessage(IRIS_MESSAGE);
    expect({ ...fields, body: { ...fields.body, hookData: fields.body.hookData.length } }).toEqual({
      version: 1,
      sourceDomain: 6,
      destinationDomain: 26,
      nonce: NONCE,
      sender: pad('0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa'),
      recipient: pad('0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa'),
      destinationCaller: addressToBytes32(L2.source.target.executor).toLowerCase(),
      minFinalityThreshold: 1000,
      finalityThresholdExecuted: 1000,
      body: {
        version: 1,
        burnToken: pad(L2.source.usdc).toLowerCase(),
        mintRecipient: addressToBytes32(L2.source.target.executor).toLowerCase(),
        amount: UNITS,
        messageSender: pad(L2.source.tokenMessengerWithFees).toLowerCase(),
        maxFee: 0n,
        feeExecuted: 0n,
        expirationBlock: 67_693_175n,
        hookData: 2 + 704 * 2
      }
    });
  });

  it('refuses a message shorter than a burn message', () => {
    expect(() => decodeCctpMessage('0x01')).toThrow('CCTP message length: 1 bytes');
  });
});

describe('confirmL2Burn', () => {
  it('proves the captured burn: from the depositor to the fee entry point, one MessageSent as signed, the exact debit', async () => {
    const proof = await confirmL2Burn(submission(), { l2: L2, units: UNITS, depositor: DEPOSITOR }, baseReads());
    expect({ debit: proof.debit, block: proof.blockNumber, sourceDomain: proof.fields.sourceDomain }).toEqual({
      debit: UNITS + FEE,
      block: BigInt(vectors.burn.receipt.blockNumber),
      sourceDomain: 6
    });
    expect(sameBurnMessage(proof.sentMessage, IRIS_MESSAGE)).toBe(true);
  });

  it('names hookData when one signed byte differs', async () => {
    const { signed } = submission();
    const flipped = hex(`${signed.hookData.slice(0, -2)}${signed.hookData.endsWith('00') ? '01' : '00'}`);
    await expect(
      confirmL2Burn(submission({ signed: { ...signed, hookData: flipped } }), { l2: L2, units: UNITS, depositor: DEPOSITOR }, baseReads())
    ).rejects.toThrow(/hookData: 0x/);
  });

  it('names the debit when Circle took other than the quoted fee', async () => {
    const quote = { signedQuote: hex('0x'), feeTotalAmount: FEE - 1n };
    await expect(
      confirmL2Burn(submission({ quotes: [quote], burnQuote: quote }), { l2: L2, units: UNITS, depositor: DEPOSITOR }, baseReads())
    ).rejects.toThrow(`USDC debit: ${UNITS + FEE}, expected ${UNITS + FEE - 1n}`);
  });

  it('names the sender when the key did not send the burn', async () => {
    await expect(
      confirmL2Burn(submission(), { l2: L2, units: UNITS, depositor: '0x4D4A180C637a71FCB9b5BD1186C8ce23C40EBa81' }, baseReads())
    ).rejects.toThrow(/from: 0x92a119667e0e6733116a8d6416a66b2ce8dc0e94, expected 0x4d4a/);
  });
});

describe('sameBurnMessage', () => {
  it('ignores only the bytes Circle fills in after the burn', async () => {
    const sent = await sentMessage();
    expect(sameBurnMessage(sent, IRIS_MESSAGE)).toBe(true);
    // amount, at body offset 68: not Circle's to change
    const amountAt = 2 + (148 + 68 + 31) * 2;
    const changed = hex(`${sent.slice(0, amountAt)}ff${sent.slice(amountAt + 2)}`);
    expect(sameBurnMessage(changed, IRIS_MESSAGE)).toBe(false);
  });
});

describe('waitForIrisForward', () => {
  const args = async () => ({ l2: L2, burnHash: BURN_HASH, sentMessage: await sentMessage() });

  it("reads the captured message through the wallet's own Iris parser", async () => {
    const iris = jest.fn(async () => ({ ok: true, status: 200, json: async () => vectors.iris.body }));
    Object.defineProperty(globalThis, 'fetch', { value: iris, writable: true, configurable: true });
    const forward = await waitForIrisForward(await args(), { timeoutMs: 60_000, clock: fakeClock() });
    expect(forward).toEqual({ nonce: NONCE, forwardTxHash: FORWARD_HASH, forwardState: 'COMPLETE', seenAtMs: 0 });
    expect(iris).toHaveBeenCalledWith(
      `https://iris-api-sandbox.circle.com/v2/messages/6?transactionHash=${BURN_HASH}`,
      expect.anything()
    );
  });

  it('waits through pending reads and a 404, then returns the forward', async () => {
    const reads: CctpMessage[][] = [
      [],
      [
        irisEntry({
          status: 'pending_confirmations',
          attestation: 'PENDING',
          forwardState: undefined,
          forwardTxHash: undefined
        })
      ],
      [irisEntry({ forwardTxHash: undefined, forwardState: 'PENDING' })],
      [irisEntry()]
    ];
    const clock = fakeClock();
    const forward = await waitForIrisForward(await args(), {
      timeoutMs: 60_000,
      clock,
      fetchMessages: async () => reads.shift() ?? []
    });
    expect([forward.forwardTxHash, clock.slept]).toEqual([FORWARD_HASH, [3_000, 3_000, 3_000]]);
  });

  it('fails at once on a forward Circle gave up, and never executes on Arc', async () => {
    const clock = fakeClock();
    await expect(
      waitForIrisForward(await args(), {
        timeoutMs: 60_000,
        clock,
        fetchMessages: async () => [irisEntry({ forwardState: 'FAILED', forwardTxHash: undefined })]
      })
    ).rejects.toThrow('Circle gave up forwarding burn');
    expect(clock.slept).toEqual([]);
  });

  it('times out naming the last status and forward state', async () => {
    await expect(
      waitForIrisForward(await args(), {
        timeoutMs: 9_000,
        clock: fakeClock(),
        fetchMessages: async () => [irisEntry({ status: 'pending_confirmations', attestation: 'PENDING', forwardTxHash: undefined, forwardState: undefined })]
      })
    ).rejects.toThrow(/within 9000 ms: status pending_confirmations, attestation pending, forwardState none/);
  });

  it('refuses two messages for one burn', async () => {
    await expect(
      waitForIrisForward(await args(), { timeoutMs: 9_000, clock: fakeClock(), fetchMessages: async () => [irisEntry(), irisEntry()] })
    ).rejects.toThrow('Iris lists 2 messages for burn');
  });

  it('refuses an attested message that is not the burn', async () => {
    const amountAt = 2 + (148 + 68 + 31) * 2;
    const other = hex(`${IRIS_MESSAGE.slice(0, amountAt)}ff${IRIS_MESSAGE.slice(amountAt + 2)}`);
    await expect(
      waitForIrisForward(await args(), { timeoutMs: 9_000, clock: fakeClock(), fetchMessages: async () => [irisEntry({ message: other })] })
    ).rejects.toThrow("differs from the burn's MessageSent");
  });
});

describe('confirmArcForward', () => {
  const expected = {
    l2: L2,
    nonce: NONCE,
    units: UNITS,
    remoteRecipient: hex(vectors.expected.remoteRecipient),
    remoteToken: hex(vectors.expected.remoteToken)
  };

  it("proves the captured forward executed this burn's nonce into xReserve for its recipient", async () => {
    const proof = await confirmArcForward(FORWARD_HASH, expected, arcReads());
    expect({
      block: proof.blockNumber,
      value: proof.deposit.value,
      depositor: proof.deposit.localDepositor.toLowerCase(),
      recipient: proof.deposit.remoteRecipient
    }).toEqual({
      block: BigInt(vectors.forward.receipt.blockNumber),
      value: UNITS,
      depositor: L2.source.target.handler.toLowerCase(),
      recipient: expected.remoteRecipient
    });
  });

  it("refuses an execution of another burn's nonce", async () => {
    const other = hex(`0x${'ab'.repeat(32)}`);
    await expect(confirmArcForward(FORWARD_HASH, { ...expected, nonce: other }, arcReads())).rejects.toThrow(
      `0 MessageReceived for nonce ${other}, expected 1`
    );
  });

  it('refuses a deposit to another Miden account', async () => {
    const other = hex(`0x${'00'.repeat(16)}${'cd'.repeat(15)}00`);
    await expect(confirmArcForward(FORWARD_HASH, { ...expected, remoteRecipient: other }, arcReads())).rejects.toThrow(
      `remoteRecipient: ${expected.remoteRecipient}, expected ${other}`
    );
  });

  it('refuses a forward that reverted', async () => {
    await expect(
      confirmArcForward(FORWARD_HASH, expected, arcReads({ ...vectors.forward.receipt, status: '0x0' }))
    ).rejects.toThrow('reverted');
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx jest --maxWorkers=1 playwright/e2e/helpers/usdcx-cctp-proof.test.ts`
Expected: FAIL: `Cannot find module './usdcx-cctp-proof'`.

- [ ] **Step 4: Extract `depositedToRemoteOf` in `arc-usdcx.ts`**

Above `confirmDepositToMiden`, add and use it there (replace the inline `parseEventLogs`/`events` block and the `event:` literal):

```ts
/** The one DepositedToRemote Arc's xReserve emitted in `receipt`; throws naming `what` and the count otherwise. */
export function depositedToRemoteOf(receipt: TransactionReceipt, what: string): DepositedToRemoteEvent {
  const events = parseEventLogs({
    abi: XRESERVE_HARNESS_ABI,
    eventName: 'DepositedToRemote',
    logs: receipt.logs
  }).filter(log => isAddressEqual(log.address, ARC_XRESERVE));
  const [event] = events;
  if (!event || events.length !== 1) {
    throw new Error(`${what}: ${events.length} DepositedToRemote events from xReserve, expected 1`);
  }
  return {
    value: event.args.value,
    localDepositor: event.args.localDepositor,
    remoteRecipient: lowerHex(event.args.remoteRecipient),
    remoteDomain: event.args.remoteDomain,
    remoteToken: lowerHex(event.args.remoteToken),
    maxFee: event.args.maxFee,
    hookData: event.args.hookData,
    blockNumber: receipt.blockNumber
  };
}
```

In `confirmDepositToMiden`: `const event = depositedToRemoteOf(depositReceipt, `deposit ${submission.depositHash}`);` and return `event` as `event`. The existing `confirmDepositToMiden` tests keep their exact message (`deposit 0x...: N DepositedToRemote events from xReserve, expected 1`).

- [ ] **Step 5: Create `playwright/e2e/helpers/usdcx-cctp-proof.ts`**

```ts
/**
 * The chain evidence of a usdcx-in-l2 deposit, hop by hop: the source burn and its CCTP message, Circle's attestation and
 * forward on Iris, and the Arc transaction that executed the message into xReserve. Every gate keys on this run's burn
 * hash or CCTP nonce: another party sends deposits through the same executor, handler and xReserve every few minutes.
 */
import {
  hexToBigInt,
  hexToNumber,
  isAddressEqual,
  isHex,
  pad,
  parseAbi,
  parseEventLogs,
  size,
  slice,
  type Address,
  type Hash,
  type Hex
} from 'viem';

import {
  depositedToRemoteOf,
  errorText,
  startingAt,
  waitForReceipt,
  type ArcReadDeps,
  type DepositedToRemoteEvent
} from './arc-usdcx';
import { realArcClock, USDCX_REMOTE_DOMAIN, type ArcClock, type L2BridgeInSource } from './usdcx-constants';
import type { L2DepositSubmission } from './usdcx-l2-deposit';
import { fetchCctpMessages, isCctpForwardFailed, type CctpMessage } from '../../../src/lib/usdcx/cctp';
import { addressToBytes32 } from '../../../src/lib/usdcx/executor';
import { GENERIC_EXECUTOR_ABI } from '../../../src/lib/usdcx/protocol';

const CCTP_EVENTS = parseAbi([
  'event MessageSent(bytes message)',
  'event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)',
  'event Transfer(address indexed from, address indexed to, uint256 value)'
]);
/** The CCTP V2 threshold a PRE_FINALITY quote buys, so Circle attests before source finality. */
const CCTP_FAST_FINALITY_THRESHOLD = 1000;
const HEADER_BYTES = 148;
const BURN_BODY_BYTES = 228;
/** What Circle fills in after the burn: the nonce, the threshold it attested at, the fee taken and the expiry block. */
const IRIS_FILLED: ReadonlyArray<readonly [number, number]> = [
  [12, 44],
  [144, 148],
  [HEADER_BYTES + 164, HEADER_BYTES + 196],
  [HEADER_BYTES + 196, HEADER_BYTES + 228]
];

function lower(value: string): Hex {
  const lowered = value.toLowerCase();
  if (!isHex(lowered)) throw new Error(`${value} is not hex`);
  return lowered;
}

export interface CctpMessageFields {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  nonce: Hex;
  sender: Hex;
  recipient: Hex;
  destinationCaller: Hex;
  minFinalityThreshold: number;
  finalityThresholdExecuted: number;
  body: {
    version: number;
    burnToken: Hex;
    mintRecipient: Hex;
    amount: bigint;
    messageSender: Hex;
    maxFee: bigint;
    feeExecuted: bigint;
    expirationBlock: bigint;
    hookData: Hex;
  };
}

/** A CCTP V2 message with a burn body: a 148-byte header, a 228-byte burn header, then the hook data. */
export function decodeCctpMessage(message: Hex): CctpMessageFields {
  const bytes = size(message);
  if (bytes < HEADER_BYTES + BURN_BODY_BYTES) {
    throw new Error(`CCTP message length: ${bytes} bytes, below the ${HEADER_BYTES + BURN_BODY_BYTES}-byte burn message`);
  }
  const at = (offset: number, length: number): Hex => lower(slice(message, offset, offset + length));
  const body = (offset: number, length: number): Hex => at(HEADER_BYTES + offset, length);
  return {
    version: hexToNumber(at(0, 4)),
    sourceDomain: hexToNumber(at(4, 4)),
    destinationDomain: hexToNumber(at(8, 4)),
    nonce: at(12, 32),
    sender: at(44, 32),
    recipient: at(76, 32),
    destinationCaller: at(108, 32),
    minFinalityThreshold: hexToNumber(at(140, 4)),
    finalityThresholdExecuted: hexToNumber(at(144, 4)),
    body: {
      version: hexToNumber(body(0, 4)),
      burnToken: body(4, 32),
      mintRecipient: body(36, 32),
      amount: hexToBigInt(body(68, 32)),
      messageSender: body(100, 32),
      maxFee: hexToBigInt(body(132, 32)),
      feeExecuted: hexToBigInt(body(164, 32)),
      expirationBlock: hexToBigInt(body(196, 32)),
      hookData: bytes === HEADER_BYTES + BURN_BODY_BYTES ? '0x' : lower(slice(message, HEADER_BYTES + BURN_BODY_BYTES))
    }
  };
}

/** Whether Iris's `attested` message is the burn's `sent` one, apart from the bytes Circle fills in after the burn. */
export function sameBurnMessage(sent: Hex, attested: Hex): boolean {
  if (size(sent) !== size(attested)) return false;
  const masked = (message: Hex): string =>
    IRIS_FILLED.reduce(
      (text, [from, to]) => `${text.slice(0, from * 2)}${'0'.repeat((to - from) * 2)}${text.slice(to * 2)}`,
      message.toLowerCase().slice(2)
    );
  return masked(sent) === masked(attested);
}

export interface L2BurnProof {
  sentMessage: Hex;
  fields: CctpMessageFields;
  /** The source USDC that left the depositor in the burn: the amount plus Circle's fee. */
  debit: bigint;
  blockNumber: bigint;
}

/**
 * The burn's receipt, read from its write endpoint first: from the key to the fee entry point, exactly one MessageSent
 * whose message carries what the key signed (domains, the executor as caller and mint recipient, the fast threshold, the
 * amount and the hook data byte for byte), and a USDC debit of exactly the amount plus the quoted fee.
 */
export async function confirmL2Burn(
  submission: L2DepositSubmission,
  expected: { l2: L2BridgeInSource; units: bigint; depositor: Address },
  reads: ArcReadDeps
): Promise<L2BurnProof> {
  const { source, payout } = expected.l2;
  const where = `burn ${submission.burnHash} on ${payout.networkName}`;
  const receipt = await waitForReceipt(startingAt(reads.endpoints, submission.endpoint), reads, submission.burnHash);
  const sent = parseEventLogs({ abi: CCTP_EVENTS, eventName: 'MessageSent', logs: receipt.logs });
  const [only] = sent;
  if (!only || sent.length !== 1) throw new Error(`${where}: ${sent.length} MessageSent logs, expected 1`);
  const fields = decodeCctpMessage(only.args.message);
  const debit = parseEventLogs({ abi: CCTP_EVENTS, eventName: 'Transfer', logs: receipt.logs })
    .filter(log => isAddressEqual(log.address, source.usdc) && isAddressEqual(log.args.from, expected.depositor))
    .reduce((sum, log) => sum + log.args.value, 0n);
  const executor = lower(addressToBytes32(source.target.executor));
  const checks: ReadonlyArray<readonly [string, string | number | bigint, string | number | bigint]> = [
    ['from', receipt.from.toLowerCase(), expected.depositor.toLowerCase()],
    ['to', (receipt.to ?? 'none').toLowerCase(), source.tokenMessengerWithFees.toLowerCase()],
    ['message version', fields.version, 1],
    ['sourceDomain', fields.sourceDomain, source.domain],
    ['destinationDomain', fields.destinationDomain, source.target.domain],
    ['destinationCaller', fields.destinationCaller, executor],
    ['minFinalityThreshold', fields.minFinalityThreshold, CCTP_FAST_FINALITY_THRESHOLD],
    ['burnToken', fields.body.burnToken, lower(pad(source.usdc))],
    ['mintRecipient', fields.body.mintRecipient, executor],
    ['amount', fields.body.amount, expected.units],
    ['hookData', fields.body.hookData, lower(submission.signed.hookData)],
    ['USDC debit', debit, expected.units + submission.burnQuote.feeTotalAmount]
  ];
  const problems = checks
    .filter(([, actual, wanted]) => actual !== wanted)
    .map(([field, actual, wanted]) => `${field}: ${actual}, expected ${wanted}`);
  if (problems.length > 0) {
    throw new Error(`the forwarded ${where} differs from what the key signed:\n  ${problems.join('\n  ')}`);
  }
  return { sentMessage: only.args.message, fields, debit, blockNumber: receipt.blockNumber };
}

export interface IrisForward {
  nonce: Hex;
  /** The Arc transaction Circle's forwarder sent: the execute the wallet adopts and xReserve's attestation keys on. */
  forwardTxHash: Hash;
  forwardState?: string;
  /** When the harness first read the message attested and forwarded. */
  seenAtMs: number;
}

/**
 * Polls Iris through the wallet's own parser (fetchCctpMessages) until it lists exactly one message for the burn, attested,
 * with a forward transaction: the message must be the burn's MessageSent apart from the bytes Circle fills in, and the
 * nonce Iris names must be the message's. A forward Circle gave up on fails at once: the wallet would offer Execute on
 * Arc, which the harness never does, since an Arc spend from the key could land in an Arc payout window.
 */
export async function waitForIrisForward(
  args: { l2: L2BridgeInSource; burnHash: Hash; sentMessage: Hex },
  opts: { timeoutMs: number; pollMs?: number; clock?: ArcClock; fetchMessages?: typeof fetchCctpMessages }
): Promise<IrisForward> {
  const clock = opts.clock ?? realArcClock;
  const fetchMessages = opts.fetchMessages ?? fetchCctpMessages;
  const { source } = args.l2;
  const where = `burn ${args.burnHash} on ${args.l2.payout.networkName}`;
  const deadline = clock.now() + opts.timeoutMs;
  let last = 'Iris listed no message (it answers 404 until it has indexed the burn)';
  for (;;) {
    let messages: CctpMessage[] | undefined;
    try {
      messages = await fetchMessages(source.domain, args.burnHash, { baseUrl: source.irisApi });
    } catch (error) {
      last = `Iris failed: ${errorText(error)}`;
    }
    if (messages !== undefined && messages.length > 1) {
      throw new Error(`Iris lists ${messages.length} messages for ${where}, expected 1`);
    }
    const entry = messages?.[0];
    if (entry !== undefined) {
      last =
        `status ${entry.status}, attestation ${entry.attestation === 'PENDING' ? 'pending' : 'signed'}, ` +
        `forwardState ${entry.forwardState ?? 'none'}, forwardTxHash ${entry.forwardTxHash ?? 'none'}`;
      if (isCctpForwardFailed(entry.forwardState)) {
        throw new Error(
          `Circle gave up forwarding ${where} (forwardState ${entry.forwardState}): the wallet would offer Execute on ` +
            'Arc, which the harness never does, since an Arc spend from the key could land in an Arc payout window'
        );
      }
      if (entry.status === 'complete' && entry.attestation !== 'PENDING' && entry.forwardTxHash !== undefined) {
        if (!sameBurnMessage(args.sentMessage, entry.message)) {
          throw new Error(`Iris attested a message for ${where} that differs from the burn's MessageSent`);
        }
        const { nonce } = decodeCctpMessage(entry.message);
        if (entry.eventNonce?.toLowerCase() !== nonce) {
          throw new Error(`Iris names nonce ${entry.eventNonce ?? 'none'} for ${where}, but its message carries ${nonce}`);
        }
        return { nonce, forwardTxHash: entry.forwardTxHash, forwardState: entry.forwardState, seenAtMs: clock.now() };
      }
    }
    if (clock.now() >= deadline) {
      throw new Error(
        `Circle has not attested and forwarded ${where} within ${opts.timeoutMs} ms: ${last}. A fast transfer forwarded ` +
          '8-10 s after its burn when probed on 2026-10-16; the wallet tells users about 20 min'
      );
    }
    await clock.sleep(opts.pollMs ?? 3_000);
  }
}

export interface ArcForwardProof {
  blockNumber: bigint;
  deposit: DepositedToRemoteEvent;
}

/**
 * The Arc forward's receipt: exactly one MessageReceived of this burn's nonce from its source domain, called by the
 * executor; exactly one Executed by the executor through the DepositFor handler for the whole amount of Arc USDC and this
 * nonce; and exactly one xReserve DepositedToRemote of the amount, from the handler, to this Miden recipient and token.
 */
export async function confirmArcForward(
  forwardTxHash: Hash,
  expected: { l2: L2BridgeInSource; nonce: Hex; units: bigint; remoteRecipient: Hex; remoteToken: Hex },
  arc: ArcReadDeps
): Promise<ArcForwardProof> {
  const { source } = expected.l2;
  const { target } = source;
  const where = `Arc forward ${forwardTxHash}`;
  const receipt = await waitForReceipt(arc.endpoints, arc, forwardTxHash);
  const problems: string[] = [];
  const received = parseEventLogs({ abi: CCTP_EVENTS, eventName: 'MessageReceived', logs: receipt.logs }).filter(
    log => log.args.nonce.toLowerCase() === expected.nonce
  );
  const [message] = received;
  if (!message || received.length !== 1) {
    problems.push(`${received.length} MessageReceived for nonce ${expected.nonce}, expected 1`);
  } else {
    if (message.args.sourceDomain !== source.domain) {
      problems.push(`MessageReceived sourceDomain: ${message.args.sourceDomain}, expected ${source.domain}`);
    }
    if (!isAddressEqual(message.args.caller, target.executor)) {
      problems.push(`MessageReceived caller: ${message.args.caller}, expected the executor ${target.executor}`);
    }
  }
  const executed = parseEventLogs({ abi: GENERIC_EXECUTOR_ABI, eventName: 'Executed', logs: receipt.logs }).filter(
    log => isAddressEqual(log.address, target.executor)
  );
  const [execution] = executed;
  if (!execution || executed.length !== 1) {
    problems.push(`${executed.length} Executed by the executor, expected 1`);
  } else {
    if (!isAddressEqual(execution.args.handler, target.handler)) {
      problems.push(`Executed handler: ${execution.args.handler}, expected ${target.handler}`);
    }
    if (!isAddressEqual(execution.args.token, target.usdc)) {
      problems.push(`Executed token: ${execution.args.token}, expected ${target.usdc}`);
    }
    if (execution.args.amount !== expected.units) {
      problems.push(`Executed amount: ${execution.args.amount}, expected ${expected.units}`);
    }
    if (execution.args.nonce.toLowerCase() !== expected.nonce) {
      problems.push(`Executed nonce: ${execution.args.nonce}, expected ${expected.nonce}`);
    }
  }
  const deposit = depositedToRemoteOf(receipt, where);
  const checks: ReadonlyArray<readonly [string, string | number | bigint, string | number | bigint]> = [
    ['value', deposit.value, expected.units],
    ['localDepositor', deposit.localDepositor.toLowerCase(), target.handler.toLowerCase()],
    ['remoteRecipient', deposit.remoteRecipient, expected.remoteRecipient.toLowerCase()],
    ['remoteDomain', deposit.remoteDomain, USDCX_REMOTE_DOMAIN],
    ['remoteToken', deposit.remoteToken, expected.remoteToken.toLowerCase()],
    ['maxFee', deposit.maxFee, 0n],
    ['hookData', deposit.hookData, '0x']
  ];
  for (const [field, actual, wanted] of checks) {
    if (actual !== wanted) problems.push(`${field}: ${actual}, expected ${wanted}`);
  }
  if (problems.length > 0) {
    throw new Error(`${where} does not execute this burn into xReserve as signed:\n  ${problems.join('\n  ')}`);
  }
  return { blockNumber: receipt.blockNumber, deposit };
}
```

- [ ] **Step 6: Run the tests to see them pass, then the directory**

Run: `npx jest --maxWorkers=1 playwright/e2e/helpers/`
Expected: PASS. The four event signatures were checked against the captured topics on 2026-10-16 (`MessageSent` `0x8c526166...`, `MessageReceived` `0xff48c13e...`, `Executed` `0x133aa6b2...`, `DepositedToRemote` `0x2eef4ec6...`); if a decode still finds 0 logs, fix the signature, never the test.

- [ ] **Step 7: Mutation checks**

| Mutation | Predicted failure |
|---|---|
| Drop the `hookData` row from `confirmL2Burn`'s checks | "names hookData when one signed byte differs" |
| Leave the amount bytes out of the masked comparison by adding `[HEADER_BYTES + 68, HEADER_BYTES + 100]` to `IRIS_FILLED` | `sameBurnMessage` test and "refuses an attested message that is not the burn" |
| Remove the `isCctpForwardFailed` throw | "fails at once on a forward Circle gave up" (times out instead, `slept` not empty) |
| Filter `MessageReceived` by nothing | "refuses an execution of another burn's nonce" |
| Debit counts every USDC Transfer | "proves the captured burn" (the debit grows past `UNITS + FEE`) |

Run each with `npx jest --maxWorkers=1 playwright/e2e/helpers/usdcx-cctp-proof.test.ts`, restore, rerun green.

- [ ] **Step 8: Format and lint**

Run: `F="playwright/e2e/helpers/arc-usdcx.ts playwright/e2e/helpers/usdcx-cctp-proof.ts playwright/e2e/helpers/usdcx-cctp-proof.test.ts"; npx prettier --check ${=F} playwright/e2e/helpers/usdcx-bridge-in.vectors.json && npx eslint --max-warnings 0 ${=F} && npx eslint --no-eslintrc -c .eslintrc.harness.json --rulesdir playwright/e2e/eslint-rules --max-warnings 0 ${=F}`
Expected: clean (run `npx prettier --write playwright/e2e/helpers/usdcx-bridge-in.vectors.json` first if the captured JSON's spacing differs).

- [ ] **Step 9: Commit**

```bash
git add playwright/e2e/helpers/arc-usdcx.ts playwright/e2e/helpers/usdcx-cctp-proof.ts playwright/e2e/helpers/usdcx-cctp-proof.test.ts playwright/e2e/helpers/usdcx-bridge-in.vectors.json
git commit -m "test(e2e): prove the l2 burn, circle's forward and the arc execution of a bridge-in"
```

### Task 5: move the receive leg out of the round-trip spec

A pure move so both bridge-in specs share one receive leg. Only two values become parameters: the step budget and how soon after the attestation the row must settle.

**Files:**
- Create: `playwright/e2e/helpers/usdcx-receive.ts`
- Modify: `playwright/e2e/tests/usdcx/usdcx-roundtrip.spec.ts:123-127`, `:156-162`, `:187-213`, `:375-479`, `:653-659`, `:768-774` and imports

**Interfaces:**
- Consumes: existing `bridgeReceiveState`, `enText` (`bridge.ts`), `describeTransactionRow`, `openHistoryDetails`, `readTransactionRow` (`history.ts`), `consumeFeeAndVault`, `historyPill`, `waitForConsumeOf`, `UsdcxWalletIds` (`usdcx-legs.ts`), `PhaseTimeline`, `pollUntil`, `sampleInBackground`, `jsonObject`, `jsonString`, `FeeTerm`, `NamedStep`, `RunEvidence`, `StepContext` (`usdcx-run.ts`).
- Produces: `interface ReceiveTracker`, `trackReceiveRows(wallet, positiveId: string, negativeId: string | undefined): ReceiveTracker`, `interface ReceivedDeposit { positiveId: string; tracker: ReceiveTracker; attestedAt: number; mintNoteId: Hex }`, `interface ReceiveOptions { vaultBefore: bigint; terms: ReadonlyArray<readonly [string, bigint]>; where: StepContext; onGuardian: StepContext; evidence: RunEvidence; budgetMs: number; readyWithinMs: number }`, `receiveLeg(step, wallet, ids, deposit: ReceivedDeposit, opts: ReceiveOptions): Promise<{ consumeId: string; fee: FeeTerm; vault: bigint }>`.

- [ ] **Step 1: Create the helper by moving the code**

Create `playwright/e2e/helpers/usdcx-receive.ts` with this header, then paste `ReceiveTracker` (spec `:123-127`), `trackReceiveRows` (`:187-213`) and `receiveLeg` (`:375-479`) unchanged except as listed after the block:

```ts
/**
 * The receive leg both bridge-in specs share (usdcx-roundtrip.spec.ts and usdcx-in-l2.spec.ts): the wallet's tracking
 * rows sampled from the moment they exist, then the service worker's own claim of the mint, the row's adoption and the
 * vault.
 */
import { expect } from '@playwright/test';
import type { Hex } from 'viem';

import { bridgeReceiveState, enText } from './bridge';
import { describeTransactionRow, openHistoryDetails, readTransactionRow } from './history';
import { DEPOSIT_UNITS } from './usdcx-constants';
import { consumeFeeAndVault, historyPill, waitForConsumeOf, type UsdcxWalletIds } from './usdcx-legs';
import {
  jsonObject,
  jsonString,
  PhaseTimeline,
  pollUntil,
  sampleInBackground,
  type FeeTerm,
  type NamedStep,
  type RunEvidence,
  type StepContext
} from './usdcx-run';
import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';

export interface ReceivedDeposit {
  positiveId: string;
  tracker: ReceiveTracker;
  /** When the harness first saw Circle's xReserve attestation. */
  attestedAt: number;
  mintNoteId: Hex;
}

export interface ReceiveOptions {
  vaultBefore: bigint;
  terms: ReadonlyArray<readonly [string, bigint]>;
  where: StepContext;
  onGuardian: StepContext;
  evidence: RunEvidence;
  budgetMs: number;
  /** How soon after `attestedAt` the row must read `ready` or `received`. */
  readyWithinMs: number;
}
```

Edits to the moved code:
- `interface ReceiveTracker` and `function trackReceiveRows` gain `export`.
- `async function receiveLeg(... deposit: DepositRun, opts: ReceiveOptions)` becomes `export async function receiveLeg(... deposit: ReceivedDeposit, opts: ReceiveOptions)`.
- `BUDGET.receive` (two places) becomes `opts.budgetMs`.
- The settle bound becomes:

```ts
      // The watcher reconciles within one 8 s tick of the attestation, give or take Circle's API.
      const settledAt = Math.min(positive.firstAt('ready') ?? Infinity, positive.firstAt('received') ?? Infinity);
      expect(
        settledAt,
        `POSITIVE stayed delivering ${opts.readyWithinMs / 1000} s after the attestation: ${positive.describe()}`
      ).toBeLessThanOrEqual(deposit.attestedAt + opts.readyWithinMs);
```

- [ ] **Step 2: Point the round-trip spec at the helper**

In `usdcx-roundtrip.spec.ts`: delete the moved `ReceiveTracker`, `ReceiveOptions`, `trackReceiveRows` and `receiveLeg`; make `DepositRun` read `interface DepositRun extends ReceivedDeposit { submission: DepositSubmission; intent: DecodedDepositIntent; mint: MidenNoteRead }`; add `import { receiveLeg, trackReceiveRows, type ReceivedDeposit, type ReceiveTracker } from '../../helpers/usdcx-receive';`; drop the imports only the moved code used (`describeTransactionRow`, `openHistoryDetails`, `readTransactionRow`, `enText`, `consumeFeeAndVault`, `historyPill`, `waitForConsumeOf`, `jsonObject`, `jsonString`, `PhaseTimeline`, `sampleInBackground`, `FeeTerm`, and `pollUntil`, `bridgeReceiveState`, `Hex` if no longer used); keep `ReceiveTracker` only if `DepositRun` or `assertNegativeFailed` names it. Both `receiveLeg` calls gain `budgetMs: BUDGET.receive, readyWithinMs: 20_000`.

- [ ] **Step 3: Check the move is exact**

Run (after `npx prettier --write` on both files, so the check sees the formatted text):
`git diff -U0 playwright/e2e/tests/usdcx/usdcx-roundtrip.spec.ts | grep '^+' | grep -v '^+++' | grep -v -e '^+import .* from ' -e '^+interface DepositRun extends ReceivedDeposit {$' -e '^+ *evidence,$' -e '^+ *budgetMs: BUDGET\.receive,$' -e '^+ *readyWithinMs: 20_000$'`
Expected: no output (grep exits 1). The filter lets through only what the move itself rewrites: one-line imports (the `usdcx-receive` import, the `bridge` import without `enText`, the `history` import that prettier collapses to `readTransactionRows`), the `DepositRun` header (its four moved members are removed lines only), and in each `receiveLeg` call the comma prettier adds after `evidence` and the two new arguments on their own lines. If prettier wraps the `usdcx-receive` import, its member lines print here too; nothing else may.

Then compare the moved bodies with the removed lines:
`diff <(git diff -U0 playwright/e2e/tests/usdcx/usdcx-roundtrip.spec.ts | grep '^-' | grep -v '^---' | sed 's/^-//') playwright/e2e/helpers/usdcx-receive.ts`
Expected: only these differences, and blank lines: the helper's header comment, imports, `ReceivedDeposit` and `ReceiveOptions` blocks against the spec's removed import lines, old `ReceiveOptions`, `DepositRun` header and four members, and the two old `evidence` lines; the `export` on `ReceiveTracker`, `trackReceiveRows` and `receiveLeg`; `deposit: DepositRun` against `deposit: ReceivedDeposit`; `BUDGET.receive` against `opts.budgetMs` (two lines); and the settle-bound comment and `expect` of Step 1.

Run: `npx eslint --max-warnings 0 playwright/e2e/helpers/usdcx-receive.ts playwright/e2e/tests/usdcx/usdcx-roundtrip.spec.ts && npx eslint --no-eslintrc -c .eslintrc.harness.json --rulesdir playwright/e2e/eslint-rules --max-warnings 0 playwright/e2e/helpers/usdcx-receive.ts playwright/e2e/tests/usdcx/usdcx-roundtrip.spec.ts && npx prettier --check playwright/e2e/helpers/usdcx-receive.ts playwright/e2e/tests/usdcx/usdcx-roundtrip.spec.ts`
Expected: clean (an unused import shows here as `no-unused-vars`; remove it). The spec runs only live, so CI's type check is its compile gate.

- [ ] **Step 4: Run the tests in the new helper's directory**

Run: `npx jest --maxWorkers=1 playwright/e2e/helpers/`
Expected: PASS (no helper test imports the spec; this proves the new helper's imports resolve under jest). The Playwright listing in `spec-selection.test.ts`, which compiles the round-trip spec with the helper, runs in Task 6, where that test changes.

- [ ] **Step 5: Commit**

```bash
git add playwright/e2e/helpers/usdcx-receive.ts playwright/e2e/tests/usdcx/usdcx-roundtrip.spec.ts
git commit -m "refactor(e2e): share the usdcx receive leg between the bridge-in specs"
```

### Task 6: the `usdcx-in-l2` spec and the bridge helper fields

**Files:**
- Modify: `playwright/e2e/helpers/bridge.ts:541-551` (`CreateUsdcxBridgeReceiveArgs`), `:573-587` (`BridgeReceiveStateSnapshot`, a `type`, not an interface), `:615-628` (the object `parseBridgeReceiveState` returns)
- Test: `playwright/e2e/helpers/bridge.test.ts:138-170`, `playwright/e2e/harness/spec-selection.test.ts:78-117`
- Create: `playwright/e2e/tests/usdcx/usdcx-in-l2.spec.ts`

**Interfaces:**
- Consumes: Tasks 2 to 5.
- Produces: `CreateUsdcxBridgeReceiveArgs` gains `usdcxRemoteRecipient?: string` and `cctp?: { sourceDomain: number; forwarded?: boolean; forwardFee?: string }`; `BridgeReceiveStateSnapshot.usdcxExecuteTxHash?: string`. The describe title `USDCx L2 bridge-in from the harness key, forwarded by Circle to Arc` and test titles `Guardian wallet receives a deposit from <Base Sepolia|Arbitrum Sepolia> that Circle forwards to Arc, then mints and claims it` (Step 3 here and Task 7 pin them).

- [ ] **Step 1: Write the failing helper test**

In `bridge.test.ts`, the test "keeps every field the hook returns, typed": add `usdcxExecuteTxHash: '0x4247d8f8e4786467aad025ce514b2cdcd72bc7fe3757a8f6aa7273ef48256116'` to both the input object and the expected object.

Run: `npx jest --maxWorkers=1 playwright/e2e/helpers/bridge.test.ts`
Expected: FAIL: the parsed state lacks `usdcxExecuteTxHash`.

- [ ] **Step 2: Implement the helper fields**

In `bridge.ts`, add to `CreateUsdcxBridgeReceiveArgs`:

```ts
  /** An executor-route deposit: what runUsdcxExecutorDeposit wrote on its `submitting` step (usdcx-l2-deposit.ts). */
  usdcxRemoteRecipient?: string;
  cctp?: { sourceDomain: number; forwarded?: boolean; forwardFee?: string };
```

to the `BridgeReceiveStateSnapshot` type, after `usdcxRemoteRecipient`:

```ts
  /** The Arc transaction the row took as its execute: Circle's forward, on the executor route. */
  usdcxExecuteTxHash?: string;
```

and to the object `parseBridgeReceiveState` returns: `usdcxExecuteTxHash: text('usdcxExecuteTxHash'),`.

Run: `npx jest --maxWorkers=1 playwright/e2e/helpers/`
Expected: PASS for every test in the directory of `bridge.ts`.

- [ ] **Step 3: Pin the new spec in the live-suite listing test**

`spec-selection.test.ts` pins every test `playwright.usdcx.config.ts` lists, each runner grep, each live spec's throw-not-skip `beforeAll`, and that no other config lists a live spec; `usdcx-burn-l2` (#1496) extended the same constants. Below `L2_BURN_TESTS`, add:

```ts
const L2_BRIDGE_IN_TESTS = ['Base Sepolia', 'Arbitrum Sepolia'].map(
  chain =>
    'usdcx-in-l2.spec.ts › USDCx L2 bridge-in from the harness key, forwarded by Circle to Arc › ' +
    `Guardian wallet receives a deposit from ${chain} that Circle forwards to Arc, then mints and claims it`
);
```

and extend:
- `USDCX_LIVE_TESTS` with `...L2_BRIDGE_IN_TESTS`;
- `USDCX_RUNNER_GREPS` with `['USDCx L2 bridge-in', L2_BRIDGE_IN_TESTS]` (the runner's grep for `usdcx-in-l2`, Task 7);
- `USDCX_LIVE_SPECS` with `['usdcx-in-l2.spec.ts', 1]`;
- `USDCX_LIVE_SPEC` with `|usdcx-in-l2\.spec\.ts`.

The two burn-only lists ("waits for each burn's own payout", "refuses to burn ... while xReserve cannot pay the burn out") stay as they are: `usdcx-in-l2` burns nothing to the key.

Run: `npx jest --maxWorkers=1 playwright/e2e/harness/spec-selection.test.ts`
Expected: FAIL: the listing lacks the two `usdcx-in-l2` tests, the `USDCx L2 bridge-in` grep selects nothing, and reading `usdcx-in-l2.spec.ts` throws `ENOENT`.

- [ ] **Step 4: Create the spec**

Create `playwright/e2e/tests/usdcx/usdcx-in-l2.spec.ts`:

```ts
import { formatUnits } from 'viem';

import { matchUsdcxDepositAttestation } from '../../../../src/lib/usdcx/attestation-protocol';
import { CIRCLE_USDC_DECIMALS } from '../../../../src/lib/usdcx/protocol';
import { midenAccountHexToXReserveRecipient } from '../../../../src/lib/usdcx/recipient';
import { expect, test } from '../../fixtures/two-wallets';
import {
  arcEndpoints,
  arcHost,
  assertDepositIntent,
  readXReserveDomainState,
  waitForXReserveAttestation,
  type ArcReadDeps
} from '../../helpers/arc-usdcx';
import { vaultBalanceOfCurrentAccount } from '../../helpers/balance-truth';
import { bridgeReceiveState, createUsdcxBridgeReceive } from '../../helpers/bridge';
import { readTransactionRows } from '../../helpers/history';
import { confirmArcForward, confirmL2Burn, waitForIrisForward } from '../../helpers/usdcx-cctp-proof';
import {
  ARC_ATTESTATION_API,
  ARC_READ_STEP_BUDGET_MS,
  ARC_USDC,
  DEPOSIT_UNITS,
  L2_BRIDGE_IN_SOURCES,
  USDCX_REMOTE_DOMAIN
} from '../../helpers/usdcx-constants';
import { guardianFailureContext, guardianIdentity } from '../../helpers/usdcx-guardian';
import {
  l2KeyShortfall,
  l2Reads,
  quoteL2Deposit,
  readL2KeyFunds,
  submitL2Deposit
} from '../../helpers/usdcx-l2-deposit';
import { attachEvidence, createGuardianUsdcxWallet, pageWhere, resolveUsdcxIds } from '../../helpers/usdcx-legs';
import { deriveUsdcxMintNoteId, waitForUsdcxMint } from '../../helpers/usdcx-miden';
import { receiveLeg, trackReceiveRows } from '../../helpers/usdcx-receive';
import {
  assertUsdcxLiveRun,
  depositClaimProblem,
  namedSteps,
  newRunEvidence,
  pollUntil,
  takeRunArcKey,
  type StepContext
} from '../../helpers/usdcx-run';

const BUDGET = {
  wallet: 180_000,
  // Each read step outlasts a stall on every endpoint before the last one answers, on Arc and on each L2.
  arcState: ARC_READ_STEP_BUDGET_MS,
  l2Key: ARC_READ_STEP_BUDGET_MS + 15_000,
  depositSubmit: 300_000,
  trackingRow: 10_000,
  sourceBurn: ARC_READ_STEP_BUDGET_MS,
  // A fast transfer forwarded in 8-10 s when probed; Circle falls back to source finality (15-20 min) when its fast
  // allowance runs out, and the wallet tells users about 20 min.
  iris: 1_500_000,
  arcForward: 150_000,
  rowForward: 60_000,
  attest: 120_000,
  mint: 180_000,
  receive: 360_000,
  check: 60_000
} as const;
/** The reconciler takes Circle's forward on one 8 s tick and finds its attestation on the next. */
const READY_WITHIN_MS = 30_000;

/**
 * A deposit the harness key signs on Base Sepolia, and one on Arbitrum Sepolia, through the wallet's own executor-route
 * deposit: Circle attests and forwards it to Arc, its executor deposits into xReserve for a fresh Guardian wallet, and
 * the relayer mints. Run only through `yarn e2e:real --suite usdcx-in-l2`. Each test ends once the wallet claimed the
 * mint and its row reads received.
 */
test.describe('USDCx L2 bridge-in from the harness key, forwarded by Circle to Arc', () => {
  // The injected fee faucet masks the wallet's own native-asset discovery (two-wallets.ts:840).
  test.use({ injectFeeFaucet: false });
  // ~2 min setup + 52.7 min of step budgets, 25 of them Circle's attestation at source finality, <= 55 min.
  test.describe.configure({ timeout: 3_300_000 });
  test.beforeAll(() => {
    assertUsdcxLiveRun(process.env);
    takeRunArcKey(process.env);
  });

  for (const l2 of L2_BRIDGE_IN_SOURCES) {
    const { payout: chain, source } = l2;
    test(`Guardian wallet receives a deposit from ${chain.networkName} that Circle forwards to Arc, then mints and claims it`, async ({
      walletA,
      envConfig,
      steps
    }) => {
      const step = namedSteps(steps);
      const arc: ArcReadDeps = { endpoints: arcEndpoints(process.env.E2E_ARC_RPC_URL) };
      const reads = l2Reads(l2);
      const where = pageWhere(walletA);
      const evidence = newRunEvidence(`usdcx-in-l2 ${chain.reviewNetwork}`);
      const secrets: string[] = [];
      const cleanups: Array<() => Promise<void>> = [];
      let passed = false;
      try {
        const { identity, ids } = await step(
          'wallet',
          BUDGET.wallet,
          async () => {
            const identity = await guardianIdentity(envConfig.guardianUrl);
            const address = await createGuardianUsdcxWallet(walletA, envConfig.guardianUrl);
            const ids = await resolveUsdcxIds(walletA.page, address);
            // A base fee that outgrew the deposit would leave its mint unclaimed until the receive step timed out.
            const unclaimable = depositClaimProblem(DEPOSIT_UNITS, ids.baseFee);
            if (unclaimable !== undefined) throw new Error(unclaimable);
            expect(await vaultBalanceOfCurrentAccount(walletA.page, ids.native), 'a fresh account holds nothing').toBe(
              0n
            );
            const written = (await readTransactionRows(walletA.page)).filter(
              row => row.type === 'consume' || row.type === 'send' || row.type === 'bridged-send'
            );
            expect(written, 'nothing has deployed the account yet').toEqual([]);
            return { identity, ids };
          },
          async () => `guardian ${envConfig.guardianUrl}`
        );
        const onGuardian: StepContext = () => guardianFailureContext(identity);
        evidence.guardian = {
          url: identity.url,
          version: identity.version,
          gitCommit: identity.gitCommit,
          commitment: identity.commitment
        };
        evidence.ids.address = ids.address;
        evidence.ids.native = ids.native;
        evidence.ids.sourceChainId = String(chain.chainId);

        const xreserve = await step('arc_state', BUDGET.arcState, async () => {
          const state = await readXReserveDomainState(arc);
          expect(
            { registered: state.registered, paused: state.paused, depositsPaused: state.depositsPaused },
            `xReserve domain ${USDCX_REMOTE_DOMAIN} read on ${arcHost(state.endpoint)}`
          ).toEqual({ registered: true, paused: false, depositsPaused: false });
          expect(state.remoteToken.toLowerCase(), "xReserve's remote token is the wallet's native faucet").toBe(
            midenAccountHexToXReserveRecipient(ids.nativeHex)
          );
          return state;
        });

        // R is derived in Node from the account id, apart from the wallet's own derivation (usdcx/deposit-target.ts).
        const recipient = midenAccountHexToXReserveRecipient(ids.accountHex);
        const funded = await step('l2_key', BUDGET.l2Key, async () => {
          const { key, role } = takeRunArcKey(process.env);
          expect(role, 'usdcx-in-l2 deposits from the harness key').toBe('harness');
          secrets.push(key.privateKey);
          const funds = await readL2KeyFunds(key.address, reads);
          const quote = await quoteL2Deposit(l2, { units: DEPOSIT_UNITS, recipient, depositor: key.address });
          const shortfall = l2KeyShortfall({
            label: chain.networkName,
            address: key.address,
            ...funds,
            units: DEPOSIT_UNITS,
            fee: quote.feeTotalAmount
          });
          if (shortfall !== undefined) throw new Error(shortfall);
          return { key, funds, fee: quote.feeTotalAmount };
        });
        evidence.ids.arcKey = funded.key.address;
        evidence.ids.arcKeyRole = 'harness';
        evidence.notes.push(
          `key on ${chain.networkName}: ${funded.funds.wei} wei, ${funded.funds.usdc} USDC base units, quoted fee ${funded.fee}`
        );

        // An overrun step runs on after the test failed; the signal stops it before it sends the approve or the burn.
        const submission = await step('deposit_submit', BUDGET.depositSubmit, signal =>
          submitL2Deposit(
            { privateKey: funded.key.privateKey, l2, units: DEPOSIT_UNITS, recipientHex: ids.accountHex, arc },
            {},
            signal
          )
        );
        const submittedAt = Date.now();
        evidence.hashes.approve = submission.approveHash ?? 'none';
        evidence.hashes.burn = submission.burnHash;
        evidence.fees.push({ name: 'circle forward fee', amount: submission.burnQuote.feeTotalAmount, kind: 'exact' });
        evidence.notes.push(
          `approve ${submission.approveHash ? 'sent' : 'not needed'}, ${submission.quotes.length} quote(s), ` +
            `writes via ${arcHost(submission.endpoint)}`
        );

        // The row the deposit screen would have made, with the product's own submitting write replayed on it.
        const rowId = await step('tracking_row', BUDGET.trackingRow, () =>
          createUsdcxBridgeReceive(walletA, {
            accountId: ids.address,
            amount: DEPOSIT_UNITS.toString(),
            faucetId: ids.native,
            sourceChainId: chain.chainId,
            sourceAddress: funded.key.address,
            sourceAmount: formatUnits(DEPOSIT_UNITS, CIRCLE_USDC_DECIMALS),
            sourceSymbol: 'USDC',
            evmTxHash: submission.burnHash,
            usdcxRemoteRecipient: submission.submitted.usdcxRemoteRecipient,
            cctp: submission.submitted.cctp
          })
        );
        evidence.ids.positiveRow = rowId;
        const tracker = trackReceiveRows(walletA, rowId, undefined);
        cleanups.push(() => tracker.stop().catch(() => undefined));

        const burn = await step('source_burn', BUDGET.sourceBurn, () =>
          confirmL2Burn(submission, { l2, units: DEPOSIT_UNITS, depositor: funded.key.address }, reads)
        );
        evidence.ids.burnBlock = String(burn.blockNumber);

        const iris = await step('iris', BUDGET.iris, () =>
          waitForIrisForward(
            { l2, burnHash: submission.burnHash, sentMessage: burn.sentMessage },
            { timeoutMs: BUDGET.iris - 15_000 }
          )
        );
        evidence.hashes.forward = iris.forwardTxHash;
        evidence.ids.cctpNonce = iris.nonce;
        evidence.latenciesMs.submitToForwardSeen = iris.seenAtMs - submittedAt;

        const executed = await step('arc_forward', BUDGET.arcForward, () =>
          confirmArcForward(
            iris.forwardTxHash,
            { l2, nonce: iris.nonce, units: DEPOSIT_UNITS, remoteRecipient: recipient, remoteToken: xreserve.remoteToken },
            arc
          )
        );
        evidence.ids.forwardBlock = String(executed.blockNumber);

        await step('row_forward', BUDGET.rowForward, () =>
          pollUntil(
            "the wallet's row taking Circle's Arc forward as its execute",
            () => bridgeReceiveState(walletA, rowId),
            state => state.usdcxExecuteTxHash?.toLowerCase() === iris.forwardTxHash.toLowerCase(),
            {
              timeoutMs: BUDGET.rowForward - 5_000,
              intervalMs: 3_000,
              describe: async last =>
                `row phase ${last?.phase ?? 'unread'}, execute ${last?.usdcxExecuteTxHash ?? 'none'}, ` +
                `error ${last?.error ?? 'none'}; ${await where()}`
            }
          )
        );

        const attested = await step('attest', BUDGET.attest, async () => {
          const attestation = await waitForXReserveAttestation(iris.forwardTxHash, {
            baseUrl: ARC_ATTESTATION_API,
            timeoutMs: BUDGET.attest - 15_000,
            pollMs: 3_000
          });
          const attestedAt = Date.now();
          // An executor deposit's depositor is the DepositFor handler, never the key (attestation-protocol.ts).
          const { intent, signer } = await assertDepositIntent(attestation, {
            amount: DEPOSIT_UNITS,
            remoteToken: xreserve.remoteToken,
            remoteRecipient: recipient,
            localToken: ARC_USDC,
            localDepositor: source.target.handler
          });
          const verdict = matchUsdcxDepositAttestation([attestation], {
            remoteRecipient: recipient,
            remoteToken: xreserve.remoteToken,
            amount: DEPOSIT_UNITS,
            remoteDomain: USDCX_REMOTE_DOMAIN
          });
          expect(verdict.kind, "the wallet's own matcher accepts Circle's attestation").toBe('attested');
          evidence.ids.attestationSigner = signer;
          evidence.hashes.attestationMessage = attestation.messageHash;
          return { intent, attestedAt };
        });

        const mintNoteId = await step('mint', BUDGET.mint, async () => {
          // Derived, not discovered: a mint to any other account or of any other amount cannot satisfy this read.
          const mintNoteId = await deriveUsdcxMintNoteId({
            faucetHex: ids.nativeHex,
            recipientHex: ids.accountHex,
            units: DEPOSIT_UNITS,
            nonce: attested.intent.nonce
          });
          const read = await waitForUsdcxMint(envConfig.rpcUrl, {
            mintNoteId,
            depositHash: iris.forwardTxHash,
            nonce: attested.intent.nonce,
            faucetBech32: ids.nativeBare,
            accountBech32: ids.bare,
            // The account was created in this run, so every faucet note to it is recent.
            sinceBlock: 0,
            timeoutMs: BUDGET.mint - 15_000
          });
          expect(
            {
              committed: read.committed,
              sender: read.senderHex?.toLowerCase(),
              assets: read.assets.map(asset => ({ faucetHex: asset.faucetHex.toLowerCase(), amount: asset.amount }))
            },
            `mint note ${mintNoteId}`
          ).toEqual({
            committed: true,
            sender: ids.nativeHex.toLowerCase(),
            assets: [{ faucetHex: ids.nativeHex.toLowerCase(), amount: DEPOSIT_UNITS }]
          });
          return mintNoteId;
        });
        evidence.ids.mintNote = mintNoteId;
        evidence.latenciesMs.attestationToMint = Date.now() - attested.attestedAt;

        const received = await receiveLeg(
          step,
          walletA,
          ids,
          { positiveId: rowId, tracker, attestedAt: attested.attestedAt, mintNoteId },
          {
            vaultBefore: 0n,
            terms: [],
            where,
            onGuardian,
            evidence,
            budgetMs: BUDGET.receive,
            readyWithinMs: READY_WITHIN_MS
          }
        );
        evidence.fees.push(received.fee);
        evidence.ids.mintConsume = received.consumeId;

        await step(
          'receive_deploy',
          BUDGET.check,
          async () => {
            const transactions = (await readTransactionRows(walletA.page)).filter(
              row => row.type !== 'bridged-receive'
            );
            expect(
              transactions.map(row => row.id),
              'the mint consume is the first transaction and the deploy'
            ).toEqual([received.consumeId]);
            await walletA.assertGuardianAuth(ids.address, {
              signerCount: 2,
              threshold: 2,
              guardianCommitment: identity.commitment
            });
          },
          onGuardian
        );
        passed = true;
      } finally {
        for (const cleanup of cleanups) await cleanup();
        await attachEvidence(test.info(), 'usdcx-in-l2-evidence.json', evidence, secrets).catch((error: unknown) => {
          if (passed) throw error;
        });
      }
    });
  }
});
```

- [ ] **Step 5: Run the listing test to see it pass**

Run: `npx jest --maxWorkers=1 playwright/e2e/harness/spec-selection.test.ts`
Expected: PASS. Its Playwright listing loads the spec and its whole import graph in Node, so an SDK or runtime import fails it here; it also compiles Task 5's round-trip spec against the moved receive leg.

- [ ] **Step 6: Lint and format the spec, helper and tests**

Run: `F="playwright/e2e/helpers/bridge.ts playwright/e2e/helpers/bridge.test.ts playwright/e2e/harness/spec-selection.test.ts playwright/e2e/tests/usdcx/usdcx-in-l2.spec.ts"; npx prettier --check ${=F} && npx eslint --max-warnings 0 ${=F} && npx eslint --no-eslintrc -c .eslintrc.harness.json --rulesdir playwright/e2e/eslint-rules --max-warnings 0 ${=F}`
Expected: clean.

No jest test runs the spec's body: its gates are the Task 3 and Task 4 unit tests of what it composes, the Playwright listings of Step 5 and Task 7 (which load and compile it), CI's type check, and the first live run.

- [ ] **Step 7: Commit**

```bash
git add playwright/e2e/helpers/bridge.ts playwright/e2e/helpers/bridge.test.ts playwright/e2e/harness/spec-selection.test.ts playwright/e2e/tests/usdcx/usdcx-in-l2.spec.ts
git commit -m "test(e2e): usdcx-in-l2 bridges in from base and arbitrum sepolia through circle's forward"
```

### Task 7: the runner suite, the per-chain key preflight and the stub

**Files:**
- Modify: `scripts/e2e-real.mjs:95-130` (copies), `:141-232` (suite), `:234-295` (usage), `:1355-1403` (L2 RPC probe split), `:1620-1640` (`resolveArcKey`), `:1978-1981` (probe dispatch)
- Modify: `scripts/e2e-real.fetch-stub.mjs:17-60`, `:115-128`, `:150-170`
- Test: `scripts/e2e-real.test.ts`

**Interfaces:**
- Consumes: Task 3 (`L2_BRIDGE_IN_SOURCES`, `L2_BRIDGE_IN_GAS` in `usdcx-constants.ts`), Task 6 (titles).
- Produces (runner exports): `SUITES['usdcx-in-l2']` with `spendsHarnessL2: true`, `L2_BRIDGE_IN_CHAINS: Array<{ name: string; chainId: number; domain: number; usdc: string; tokenMessengerWithFees: string; rpcs: string[] }>`, `IRIS_API_TESTNET`, `L2_BRIDGE_IN_GAS`, `L2_BRIDGE_IN_USDC_FLOOR_UNITS`, `l2KeyGasProblem(chain, address, wei: bigint, gasPrice: bigint): string | undefined`, `l2KeyUsdcProblem(chain, address, units: bigint): string | undefined`. Preflight check labels: `<chain> RPC`, `<chain> write endpoint`, `<chain> bridge-in contracts`, `<chain> key`, `<chain> Iris fees`.

- [ ] **Step 1: Write the failing tests**

In `scripts/e2e-real.test.ts`, add `IRIS_API_TESTNET`, `L2_BRIDGE_IN_CHAINS`, `L2_BRIDGE_IN_GAS`, `l2KeyGasProblem`, `l2KeyUsdcProblem`, `writeHarnessArcKey` to the runner import.

In `describe('the usdcx suites')`: add `'usdcx-in-l2': 'USDCx L2 bridge-in from the harness key, forwarded by Circle to Arc'` to `OWN`; the first test becomes "find the five describes and eight tests" with `toHaveLength(8)` and:

```ts
    expect(listed.tests.filter(test => test.startsWith(`${OWN['usdcx-in-l2']} > `))).toEqual([
      `${OWN['usdcx-in-l2']} > Guardian wallet receives a deposit from Arbitrum Sepolia that Circle forwards to Arc, then mints and claims it`,
      `${OWN['usdcx-in-l2']} > Guardian wallet receives a deposit from Base Sepolia that Circle forwards to Arc, then mints and claims it`
    ]);
```

and add:

```ts
  it('spends the harness key on the L2s in usdcx-in-l2 alone', () => {
    expect(Object.keys(SUITES).filter(name => SUITES[name].spendsHarnessL2)).toEqual(['usdcx-in-l2']);
  });
```

Extend both `it.each(['usdcx', 'usdcx-in', 'usdcx-burn', 'usdcx-burn-l2'])` lists in "the usdcx suites refuse what would not apply" with `'usdcx-in-l2'`, and the `resolveOperatorInput` accept list with `['usdcx-in-l2', {}]`.

Add at the end of `describe('a usdcx run')` (`:1942`), whose tests are full runs under the stub. Not beside "refuses usdcx-in with no key and no harness key": that describe (`:1038`) passes `--preflight-only` to every invocation, as its header comment says, and a preflight-only run never creates a key, so the first mutation row of Step 6 could not fail there.

```ts
  // A full run (not --preflight-only, which never creates a key) under the stub, which answers every request and
  // stands in for the build and the test: the refusal comes before either.
  it('refuses usdcx-in-l2 with no harness key, naming how to make and fund one, and creates none', () => {
    const home = freshHome();
    const res = stubbed(['--suite', 'usdcx-in-l2'], DOCUMENT, { HOME: home });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(
      '--suite usdcx-in-l2 deposits from the harness key on Base Sepolia and Arbitrum Sepolia, and there is none yet: ' +
        'run --suite usdcx-burn-l2 first'
    );
    expect(existsSync(path.join(home, '.miden-e2e', 'arc-keys', 'harness.json'))).toBe(false);
    expect(res.requests).not.toContain('SPAWN');
  }, 35_000);
```

Add a copies block after "the usdcx-burn-l2 copies":

```ts
describe('the usdcx-in-l2 copies are the ones the harness and the wallet use', () => {
  it("copies the harness's bridge-in chains in its order, each with the route the wallet takes", () => {
    expect(L2_BRIDGE_IN_CHAINS).toEqual(
      harness.L2_BRIDGE_IN_SOURCES.map(l2 => ({
        name: l2.payout.networkName,
        chainId: l2.payout.chainId,
        domain: l2.source.domain,
        usdc: l2.source.usdc,
        tokenMessengerWithFees: l2.source.tokenMessengerWithFees,
        rpcs: [...l2.payout.rpcUrls]
      }))
    );
    for (const chain of L2_BRIDGE_IN_CHAINS) {
      const route = wallet.getUsdcxExecutorSource(chain.chainId);
      expect([route.domain, route.usdc, route.tokenMessengerWithFees, route.irisApi]).toEqual([
        chain.domain,
        chain.usdc,
        chain.tokenMessengerWithFees,
        IRIS_API_TESTNET
      ]);
    }
    expect(L2_BRIDGE_IN_GAS).toBe(harness.L2_BRIDGE_IN_GAS);
  });

  it('names the chain, the address and the minimum in each top-up message', () => {
    const [base] = L2_BRIDGE_IN_CHAINS;
    const address = '0x4D4A180C637a71FCB9b5BD1186C8ce23C40EBa81';
    expect(l2KeyGasProblem(base, address, 0n, 6_000_000n)).toBe(
      `top up the key on Base Sepolia: ${address} holds 0 ETH, below the 0.000012 ETH one bridge-in needs ` +
        `(1000000 gas at twice the 0.006 gwei gas price); send Base Sepolia ETH to ${address}`
    );
    expect(l2KeyGasProblem(base, address, 12_000_000_000_000n, 6_000_000n)).toBeUndefined();
    expect(l2KeyUsdcProblem(base, address, 50_000n)).toBe(
      `top up the key on Base Sepolia: ${address} holds 0.05 USDC, below the 0.101 USDC one bridge-in takes ` +
        "(0.001 deposited and twice Circle's forward fee, up to 0.05 each); a green usdcx-burn-l2 run pays it about " +
        '0.99 USDC there'
    );
    expect(l2KeyUsdcProblem(base, address, 101_000n)).toBeUndefined();
  });
});
```

Inside `describe('the usdcx preflight')`, add:

```ts
  const keyedHome = async () => {
    const home = freshHome();
    await writeHarnessArcKey(path.join(home, '.miden-e2e', 'arc-keys', 'harness.json'), ARC_KEY);
    return home;
  };

  it("asks usdcx-in-l2 the Arc deposit questions, then on each L2 the chain, a write endpoint, the fee entry point, the key's ETH and USDC, and Iris", async () => {
    const { address } = privateKeyToAccount(ARC_KEY);
    const res = preflight('usdcx-in-l2', DOCUMENT, { HOME: await keyedHome() });
    expect(res.output).toContain('✓ preflight passed (19 checks)');
    expect(res.status).toBe(0);
    expect(
      missing(
        res.requests,
        L2_BRIDGE_IN_CHAINS.flatMap(chain => [
          `${chain.rpcs[0]} eth_chainId []`,
          `${chain.rpcs[0]} eth_sendRawTransaction ["0x00"]`,
          `${chain.rpcs[0]} eth_getCode ["${chain.tokenMessengerWithFees}","latest"]`,
          `${chain.rpcs[0]} eth_getBalance ["${address}","latest"]`,
          `${chain.rpcs[0]} eth_gasPrice []`,
          `${IRIS_API_TESTNET}/v2/burn/USDC/fees/${chain.domain}/26`
        ])
      )
    ).toEqual([]);
    expect(res.requests).not.toContain(XRESERVE_CALLS.gatewayMinter);
    expect(res.output).toContain(address);
    expect(res.output).not.toContain(ARC_KEY.slice(2));
  }, 35_000);

  it('fails each L2 key check with a top-up message when the key holds no ETH there, before any build', async () => {
    const { address } = privateKeyToAccount(ARC_KEY);
    const res = preflight('usdcx-in-l2', DOCUMENT, { HOME: await keyedHome() }, { l2Wei: '0x0' });
    expect(failedChecks(res.output)).toEqual(['Base Sepolia key', 'Arbitrum Sepolia key']);
    expect(res.output).toContain(`top up the key on Base Sepolia: ${address} holds 0 ETH, below the 0.000012 ETH`);
    expect(res.output).toContain(`top up the key on Arbitrum Sepolia: ${address} holds 0 ETH`);
    expect(res.status).toBe(1);
    expect(res.requests).not.toContain('SPAWN');
  }, 35_000);

  it('fails the L2 key checks when the key holds too little USDC there', async () => {
    const res = preflight('usdcx-in-l2', DOCUMENT, { HOME: await keyedHome() }, { l2UsdcUnits: '50000' });
    expect(failedChecks(res.output)).toEqual(['Base Sepolia key', 'Arbitrum Sepolia key']);
    expect(res.output).toContain('holds 0.05 USDC, below the 0.101 USDC one bridge-in takes');
  }, 35_000);

  it('fails a chain whose fee entry point has no code', async () => {
    const res = preflight(
      'usdcx-in-l2',
      DOCUMENT,
      { HOME: await keyedHome() },
      { l2NoCode: ['0x8745d906d67c346e5eb1aeeed38eb87f34df0c0a'] }
    );
    expect(failedChecks(res.output)).toEqual(['Base Sepolia bridge-in contracts', 'Arbitrum Sepolia bridge-in contracts']);
  }, 35_000);

  // A refusal would otherwise fail deposit_submit only after the build and the wallet's creation.
  it('fails a chain none of whose endpoints takes raw transactions, naming each refusal', async () => {
    const res = preflight(
      'usdcx-in-l2',
      DOCUMENT,
      { HOME: await keyedHome() },
      { l2RawTransaction: { code: -32601, message: 'the method eth_sendRawTransaction does not exist/is not available' } }
    );
    expect(failedChecks(res.output)).toEqual(['Base Sepolia write endpoint', 'Arbitrum Sepolia write endpoint']);
    expect(res.output).toContain(
      'no endpoint takes raw transactions: base-sepolia-rpc.publicnode.com refused eth_sendRawTransaction'
    );
    expect(res.status).toBe(1);
    expect(res.requests).not.toContain('SPAWN');
  }, 35_000);
```

`ARC_KEY`, `missing`, `failedChecks`, `XRESERVE_CALLS` already exist in that describe.

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx jest --maxWorkers=1 scripts/e2e-real.test.ts`
Expected: FAIL: the new imports are undefined, `--suite usdcx-in-l2` is unknown, the listing finds 6 tests.

- [ ] **Step 3: Implement the runner**

Below `L2_PAYOUT_CHAINS`, add:

```js
/**
 * The chains usdcx-in-l2 deposits from: each chain's Circle domain, USDC, fee entry point and the endpoints the harness
 * reads it through (L2_BRIDGE_IN_SOURCES in usdcx-constants.ts); e2e-real.test.ts pins each copy to the harness and the
 * wallet.
 */
export const L2_BRIDGE_IN_CHAINS = [
  {
    name: 'Base Sepolia',
    chainId: 84532,
    domain: 6,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    tokenMessengerWithFees: '0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A',
    rpcs: [
      'https://base-sepolia-rpc.publicnode.com',
      'https://base-sepolia.gateway.tenderly.co',
      'https://sepolia.base.org'
    ]
  },
  {
    name: 'Arbitrum Sepolia',
    chainId: 421614,
    domain: 3,
    usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    tokenMessengerWithFees: '0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A',
    rpcs: [
      'https://sepolia-rollup.arbitrum.io/rpc',
      'https://arbitrum-sepolia-rpc.publicnode.com',
      'https://arbitrum-sepolia.gateway.tenderly.co'
    ]
  }
];
/** Circle's sandbox Iris, which prices and attests every testnet executor deposit (the fixture's irisUrl). */
export const IRIS_API_TESTNET = 'https://iris-api-sandbox.circle.com';
/** One bridge-in's gas: an approve and the forwarded burn, each sent at 1.2x its estimate (usdcx-constants.ts). */
export const L2_BRIDGE_IN_GAS = 1_000_000n;
/** One 0.001 USDC deposit and twice a forward fee of up to 0.05 USDC (0.022404 on 2026-10-16), which its approve covers. */
export const L2_BRIDGE_IN_USDC_FLOOR_UNITS = 101_000n;
```

Add the suite to `SUITES`, before `usdcx-burn-l2`:

```js
  // Its own suite, after usdcx-in and before usdcx-burn-l2 (E2E USDCx's L2 job): it spends from the harness key on Base
  // Sepolia and Arbitrum Sepolia, where usdcx-burn-l2 proves each payout as that key's balance rising by exactly it.
  'usdcx-in-l2': {
    config: 'playwright.usdcx.config.ts',
    grep: 'USDCx L2 bridge-in',
    probes: ['usdcx', 'usdcx-guardian', 'l2-bridge-in'],
    networks: ['testnet'],
    usdcx: true,
    spendsHarnessL2: true,
    headlessByDefault: true,
    retries: 0,
    describe:
      'Guardian wallets: a CCTP deposit the harness key signs on Base Sepolia and Arbitrum Sepolia, forwarded to Arc, minted, claimed'
  },
```

In `USAGE`, replace the sentence `usdcx-burn-l2 burns to that key's address on Base Sepolia and Arbitrum Sepolia, where Circle's payouts stay: the key holds no ETH there and never spends.` (it starts mid-line at `e2e-real.mjs:276`, after `or an exported E2E_ARC_PRIVATE_KEY that does.`, which stays, and ends at `:277`) with the block below, its first line starting where the old sentence did. "the usage" test (`e2e-real.test.ts:2309`) pins `usdcx-burn-l2 burns to that key's address on Base Sepolia and Arbitrum Sepolia` on one line, which the block keeps:

```
usdcx-burn-l2 burns to that key's address on Base Sepolia and Arbitrum Sepolia,
and usdcx-in-l2 deposits back from it there: 0.001 USDC and Circle's forward
fee per chain, plus gas in ETH, which is sent to the key by hand. usdcx-in-l2
needs an existing harness key and never creates one.
```

Split the endpoint loop out of `probeL2Payout`:

```js
/** The `chain.rpcs` serving `chain.chainId`, in order, recorded as `<name> RPC` with every endpoint's state. */
async function probeL2Rpc(chain) {
  const states = [];
  const serving = [];
  for (const url of chain.rpcs) {
    const host = endpointHost(url);
    try {
      const chainId = Number(await arcRpc(url, 'eth_chainId', []));
      if (chainId !== chain.chainId) {
        states.push(`${host} reports chain ${chainId}`);
        continue;
      }
      states.push(`${host} #${Number(await arcRpc(url, 'eth_blockNumber', []))}`);
      serving.push(url);
    } catch (err) {
      states.push(`${host} ${err.message}`);
    }
  }
  record(
    serving.length > 0,
    `${chain.name} RPC`,
    serving.length === 0 ? `no endpoint serves chain ${chain.chainId}: ${states.join('; ')}` : states.join('; ')
  );
  return serving;
}
```

and start `probeL2Payout` with `const [healthy] = await probeL2Rpc(chain);` in place of its loop and `record`.

Add the bridge-in probe and its messages:

```js
/** `value` in units of 10^-decimals, every digit kept: a gas floor reads 0.000012, never 0.0000. */
function exactUnits(value, decimals) {
  const raw = BigInt(value).toString().padStart(decimals + 1, '0');
  const whole = raw.slice(0, -decimals);
  const frac = raw.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * Why the key lacks ETH for one bridge-in on `chain`, or undefined. Twice the gas price: a send bids its max fee, and the
 * node refuses one the balance cannot cover at that bid. Exported for test.
 */
export function l2KeyGasProblem(chain, address, wei, gasPrice) {
  const floor = L2_BRIDGE_IN_GAS * gasPrice * 2n;
  if (wei >= floor) return undefined;
  return (
    `top up the key on ${chain.name}: ${address} holds ${exactUnits(wei, 18)} ETH, below the ${exactUnits(floor, 18)} ` +
    `ETH one bridge-in needs (${L2_BRIDGE_IN_GAS} gas at twice the ${exactUnits(gasPrice, 9)} gwei gas price); ` +
    `send ${chain.name} ETH to ${address}`
  );
}

/** Why the key lacks USDC for one bridge-in on `chain`, or undefined. Exported for test. */
export function l2KeyUsdcProblem(chain, address, units) {
  if (units >= L2_BRIDGE_IN_USDC_FLOOR_UNITS) return undefined;
  return (
    `top up the key on ${chain.name}: ${address} holds ${formatUnits(units, USDCX_DECIMALS)} USDC, below the ` +
    `${formatUnits(L2_BRIDGE_IN_USDC_FLOOR_UNITS, USDCX_DECIMALS)} USDC one bridge-in takes (0.001 deposited and twice ` +
    "Circle's forward fee, up to 0.05 each); a green usdcx-burn-l2 run pays it about 0.99 USDC there"
  );
}

/**
 * The first of `serving` that would relay the deposit's approve and burn, chosen as pickWriteEndpoint (arc-usdcx.ts)
 * chooses it: an empty raw transaction costs nothing, and an endpoint that fails to decode it takes writes.
 */
async function probeL2WriteEndpoint(chain, serving) {
  const states = [];
  for (const url of serving) {
    const host = endpointHost(url);
    try {
      await arcRpc(url, 'eth_sendRawTransaction', ['0x00']);
      states.push(`${host} accepted an empty raw transaction`);
    } catch (err) {
      if (err.code === -32602 || /decode|rlp|typed transaction/i.test(err.message)) {
        return record(true, `${chain.name} write endpoint`, `${host} takes raw transactions (it failed to decode 0x00)`);
      }
      states.push(`${host} refused eth_sendRawTransaction: ${err.message}`);
    }
  }
  return record(false, `${chain.name} write endpoint`, `no endpoint takes raw transactions: ${states.join('; ')}`);
}

/**
 * What one usdcx-in-l2 test spends on `chain`, asked before the build: an endpoint serving the chain and one taking
 * writes, the fee entry point and the USDC with code, the harness key's ETH and USDC, and Circle's fee table for a fast
 * burn to Arc. The spec checks the key again against the live quote. Only the key's address is ever printed.
 */
async function probeL2BridgeIn(chain, arcKey) {
  const serving = await probeL2Rpc(chain);
  const [healthy] = serving;
  if (healthy === undefined) return;
  await probeL2WriteEndpoint(chain, serving);
  try {
    const empty = [];
    for (const [name, address] of [
      ['TokenMessengerWithFees', chain.tokenMessengerWithFees],
      ['USDC', chain.usdc]
    ]) {
      if (codeBytes(await arcRpc(healthy, 'eth_getCode', [address, 'latest'])) === 0) empty.push(`${name} ${address}`);
    }
    record(
      empty.length === 0,
      `${chain.name} bridge-in contracts`,
      empty.length === 0 ? `TokenMessengerWithFees and USDC ${chain.usdc} have code` : `${empty.join(' and ')} has no code`
    );
  } catch (err) {
    record(false, `${chain.name} bridge-in contracts`, `${endpointHost(healthy)}: ${err.message}`);
  }
  try {
    const wei = BigInt(await arcRpc(healthy, 'eth_getBalance', [arcKey.address, 'latest']));
    const gasPrice = BigInt(await arcRpc(healthy, 'eth_gasPrice', []));
    const units = BigInt(
      await arcRpc(healthy, 'eth_call', [{ to: chain.usdc, data: calldata(ARC_SELECTORS.balanceOf, arcKey.address) }, 'latest'])
    );
    const problem = l2KeyGasProblem(chain, arcKey.address, wei, gasPrice) ?? l2KeyUsdcProblem(chain, arcKey.address, units);
    record(
      problem === undefined,
      `${chain.name} key`,
      problem ?? `${arcKey.address} holds ${exactUnits(wei, 18)} ETH and ${formatUnits(units, USDCX_DECIMALS)} USDC`
    );
  } catch (err) {
    record(false, `${chain.name} key`, `could not read ${arcKey.address}: ${err.message}`);
  }
  const url = `${IRIS_API_TESTNET}/v2/burn/USDC/fees/${chain.domain}/${ARC_CIRCLE_DOMAIN}`;
  try {
    const { status, body } = await circleGet(url);
    const fast = Array.isArray(body) && body.some(entry => entry?.finalityThreshold === 1000);
    record(
      status === 200 && fast,
      `${chain.name} Iris fees`,
      status === 200 && fast
        ? `Circle prices a fast burn from domain ${chain.domain} to Arc`
        : `HTTP ${status}, no fast-transfer fee from domain ${chain.domain}`
    );
  } catch (err) {
    record(false, `${chain.name} Iris fees`, `${url}: ${err.message}`);
  }
}
```

In `resolveArcKey`, replace the `harnessArcKey` call and add the refusal:

```js
  // usdcx-in-l2 spends what earlier runs paid the harness key on the L2s, so a key made now would hold nothing there.
  const create = !suite.arcKey && !suite.spendsHarnessL2 && !opts.preflightOnly;
  const harness = await harnessArcKey(HARNESS_ARC_KEY_FILE, { create });
  if (harness.missing && suite.arcKey) {
    // unchanged usdcx-in refusal
  }
  if (harness.missing && suite.spendsHarnessL2) {
    return {
      error:
        `--suite ${opts.suite} deposits from the harness key on Base Sepolia and Arbitrum Sepolia, and there is none ` +
        `yet: run --suite usdcx-burn-l2 first, which creates ${HARNESS_ARC_KEY_FILE} and has Circle pay it USDC there, ` +
        'then send the key ETH on both chains'
    };
  }
```

In `runSuite`, after the `l2-payout` block:

```js
  if (needs.includes('l2-bridge-in')) {
    for (const chain of L2_BRIDGE_IN_CHAINS) await probeL2BridgeIn(chain, arcKey);
  }
```

- [ ] **Step 4: Teach the stub the new reads**

In `scripts/e2e-real.fetch-stub.mjs`, add to `ANSWERS`:

```js
  // The harness key on each L2: 0.01 ETH, the gas price Base Sepolia had on 2026-10-16, and two payouts' USDC.
  l2Wei: '0x2386f26fc10000',
  l2GasPrice: '0x5b8d80',
  l2UsdcUnits: '1977802',
  // Every L2 endpoint's answer to the empty raw transaction: a decode failure, so it takes writes.
  l2RawTransaction: { code: -32602, message: 'failed to decode signed transaction' },
  irisFees: [
    { finalityThreshold: 1000, minimumFee: 1.3 },
    { finalityThreshold: 2000, minimumFee: 0 }
  ],
```

add to `l2Answer`:

```js
    case 'eth_sendRawTransaction':
      return { error: answers.l2RawTransaction };
    case 'eth_getBalance':
      return { result: answers.l2Wei };
    case 'eth_gasPrice':
      return { result: answers.l2GasPrice };
    case 'eth_call':
      return String(params[0]?.data).startsWith('0x70a08231')
        ? { result: word(BigInt(answers.l2UsdcUnits).toString(16)) }
        : { error: { code: 3, message: 'reverted' } };
```

and before `if (url.endsWith('/v1/info'))` in the `fetch` stub:

```js
  if (url.includes('/v2/burn/USDC/fees/')) return json(answers.irisFees);
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx jest --maxWorkers=1 scripts/e2e-real.test.ts`
Expected: PASS, the existing `usdcx-burn-l2` preflight still at 17 checks.

- [ ] **Step 6: Mutation checks**

| Mutation | Predicted failure |
|---|---|
| `create = !suite.arcKey && !opts.preflightOnly` (drop the L2 term) | "refuses usdcx-in-l2 with no harness key" (a key file now exists, and the run reaches the probes) |
| Drop the `spendsHarnessL2` refusal | same test (no refusal message) |
| Floor without the `* 2n` | "names the chain, the address and the minimum" (0.000006) and "fails each L2 key check" |
| Skip `probeL2BridgeIn` for the second chain | "asks usdcx-in-l2 ..." (14 checks: the 5 Arbitrum records are gone, and its requests are missing) |
| Drop the `probeL2WriteEndpoint` call | "asks usdcx-in-l2 ..." (17 checks, no `eth_sendRawTransaction` request) and "fails a chain none of whose endpoints takes raw transactions" |
| Grep `USDCx L2` | "--suite usdcx-in-l2 greps exactly the tests of its own describe" |

Run each with `npx jest --maxWorkers=1 scripts/e2e-real.test.ts -t 'usdcx-in-l2|top-up|raw transactions'`, restore, rerun green.

- [ ] **Step 7: Format and lint**

Run: `npx prettier --check scripts/e2e-real.mjs scripts/e2e-real.fetch-stub.mjs scripts/e2e-real.test.ts && npx eslint --max-warnings 0 scripts/e2e-real.mjs scripts/e2e-real.fetch-stub.mjs scripts/e2e-real.test.ts`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add scripts/e2e-real.mjs scripts/e2e-real.fetch-stub.mjs scripts/e2e-real.test.ts
git commit -m "test(e2e): run usdcx-in-l2 through e2e-real with a per-chain key preflight"
```

### Task 8: split E2E USDCx into an Arc job and an L2 job

**Files:**
- Modify: `.github/workflows/e2e-usdcx.yml` (whole file)
- Test: `playwright/e2e/harness/usdcx-workflow.test.ts`, `playwright/e2e/harness/linked-pr-injection.test.ts:281`, `:360`

**Interfaces:**
- Consumes: Task 7's suite name.
- Produces: jobs `chrome-usdcx-arc` and `chrome-usdcx-l2`; step ids `usdcx_in`, `usdcx_burn`, `usdcx_round_trip`, `usdcx_in_l2`, `usdcx_burn_l2`.

- [ ] **Step 1: Write the failing workflow tests**

In `playwright/e2e/harness/usdcx-workflow.test.ts`, replace the `steps`/`stepNamed` helpers (lines 32-42) with per-job ones:

```ts
const ARC_JOB = 'chrome-usdcx-arc';
const L2_JOB = 'chrome-usdcx-l2';

/** A job's lines, from its `  <id>:` line to the next line at that indent (a job or a comment above one). */
function jobBlock(id: string): string {
  const lines = workflow.split('\n');
  const at = lines.indexOf(`  ${id}:`);
  if (at === -1) throw new Error(`no job ${id}`);
  const next = lines.findIndex((line, index) => index > at && /^ {2}\S/.test(line));
  return lines.slice(at, next === -1 ? lines.length : next).join('\n');
}
/** A job's own key, read from the lines above its steps. */
const jobKey = (id: string, key: string): string | undefined =>
  new RegExp(`^ {4}${key}: (.+)$`, 'm').exec(jobBlock(id).split('\n    steps:\n')[0] ?? '')?.[1];
/** A job's steps, each from its `      - ` to the next one; a comment above a step ends the step before it. */
const stepsOf = (id: string): string[] => {
  const block = jobBlock(id);
  return block.slice(block.indexOf('\n    steps:\n') + '\n    steps:\n'.length).split(/\n(?= {6}- )/);
};
const steps = [...stepsOf(ARC_JOB), ...stepsOf(L2_JOB)];
const isNamed = (step: string, name: string): boolean =>
  step.split('\n').some(line => line.trim().replace(/^- /, '') === `name: ${name}`);
const runOf = (step: string): string | undefined => /^ {6}(?:- | {2})run: (.+)$/m.exec(step)?.[1];
const stepNamed = (id: string, name: string): string => {
  const found = stepsOf(id).filter(step => isNamed(step, name));
  if (found.length !== 1) throw new Error(`${found.length} steps named ${name} in ${id}`);
  return found[0]!;
};
const isSuite = (step: string): boolean => runOf(step)?.startsWith(RUNNER) === true;
/** A step without its comment lines, which belong to the step after it. */
const bare = (step: string): string =>
  step
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
    .join('\n');
```

Replace the job, secret, write, order, suite and upload tests (lines 100-186) with:

```ts
  it('is two jobs, the Arc suites then the L2 suites, each on a runner of its own', () => {
    expect(topLevel('jobs').filter(line => /^ {2}\S/.test(line))).toEqual([`  ${ARC_JOB}:`, `  ${L2_JOB}:`]);
  });

  it('reads one secret, once in each job, in the env of the step that writes the key file', () => {
    expect(workflow.match(/\bsecrets\./g)).toHaveLength(2);
    for (const job of [ARC_JOB, L2_JOB]) {
      const step = stepNamed(job, WRITE_STEP);
      expect(step).toContain(`\n        env:\n          ${SECRET}: \${{ secrets.${SECRET} }}\n`);
      expect(runOf(step)).toBe('node scripts/write-ci-harness-arc-key.mjs');
    }
    // No workflow or job env: every step would see it, the dependency install and the builds among them.
    expect(workflow).not.toMatch(/^ {0,4}env:/m);
  });

  it("gives the L2 job the Arc job's setup, step for step, through the key write", () => {
    const setup = (job: string) => {
      const list = stepsOf(job).map(bare);
      return list.slice(0, list.findIndex(step => isNamed(step, WRITE_STEP)) + 1);
    };
    expect(setup(L2_JOB)).toEqual(setup(ARC_JOB));
  });
```

Keep "writes the key file 0600..." but read `runOf(stepNamed(ARC_JOB, WRITE_STEP))`. Then:

```ts
  it.each([ARC_JOB, L2_JOB])('writes the key after the dependency install and before the first suite, in %s', job => {
    const list = stepsOf(job);
    const installs = list.flatMap((step, index) =>
      /yarn install|\.\/\.github\/actions\/yarn-install/.test(step) ? [index] : []
    );
    const write = list.indexOf(stepNamed(job, WRITE_STEP));
    expect(installs).not.toHaveLength(0);
    expect(write).toBeGreaterThan(Math.max(...installs));
    expect(list.findIndex(isSuite)).toBeGreaterThan(write);
  });

  it('runs the three Arc suites in the Arc job in turn, with no key flag, no env, no if and no continue-on-error', () => {
    const suites = stepsOf(ARC_JOB).filter(isSuite);
    expect(suites.map(runOf)).toEqual([
      `${RUNNER} --suite usdcx-in`,
      `${RUNNER} --suite usdcx-burn`,
      `${RUNNER} --suite usdcx`
    ]);
    // A red suite can leave a payout or a deposit landing on the key inside the next one's payout window.
    for (const step of suites) expect(step).not.toMatch(/^ {8}(env|if|continue-on-error):/m);
    expect(suites[0]).toMatch(/^ {8}id: usdcx_in$/m);
  });

  // usdcx-in-l2 spends from the key on both L2s and usdcx-burn-l2 proves each payout as the rise of that balance from a
  // read right before its burn: every deposit is mined before usdcx-in-l2's step ends, so order inside the job suffices.
  it('runs usdcx-in-l2 then usdcx-burn-l2 in the L2 job, usdcx-burn-l2 after a red usdcx-in-l2 too but never after a failed setup step', () => {
    const [inL2, burnL2, ...rest] = stepsOf(L2_JOB).filter(isSuite);
    expect([runOf(inL2 ?? ''), runOf(burnL2 ?? ''), rest]).toEqual([
      `${RUNNER} --suite usdcx-in-l2`,
      `${RUNNER} --suite usdcx-burn-l2`,
      []
    ]);
    expect(inL2).not.toMatch(/^ {8}(env|if|continue-on-error):/m);
    expect(inL2).toMatch(/^ {8}id: usdcx_in_l2$/m);
    expect(burnL2?.match(/^ {8}(env|if|continue-on-error):.*$/gm)).toEqual([
      `        if: \${{ !cancelled() && steps.usdcx_in_l2.outcome != 'skipped' }}`
    ]);
  });

  // Its suites read Base Sepolia and Arbitrum Sepolia, where nothing an Arc suite leaves pending lands, so it runs after a
  // red Arc job, never in a cancelled run. Its own setup guards the key: a failed step there skips usdcx-in-l2, which has
  // no condition, and with it usdcx-burn-l2, so no L2 suite runs on a missing key file.
  it('starts the L2 job after the Arc job, red or green, but never in a cancelled run', () => {
    expect(jobKey(L2_JOB, 'needs')).toBe(ARC_JOB);
    expect(jobKey(L2_JOB, 'if')).toBe(`\${{ !cancelled() }}`);
    expect(jobBlock(ARC_JOB)).not.toMatch(/^ {4}outputs:/m);
  });

  it.each([
    [ARC_JOB, `\${{ github.event_name == 'workflow_dispatch' && 240 || 210 }}`],
    [L2_JOB, `\${{ github.event_name == 'workflow_dispatch' && 260 || 230 }}`]
  ])('gives %s its own ceiling', (job, ceiling) => {
    expect(jobKey(job, 'timeout-minutes')).toBe(ceiling);
  });

  it('uploads test-results after each suite that ran, whatever it did, failing no step after it, and never the key or the lock', () => {
    const uploads = steps.filter(step => step.includes('uses: actions/upload-artifact@'));
    expect(uploads).toHaveLength(5);
    for (const upload of uploads) {
      const id = /^ {8}if: always\(\) && steps\.(\w+)\.outcome != 'skipped'$/m.exec(upload)?.[1];
      expect(steps[steps.indexOf(upload) - 1]).toMatch(new RegExp(`^ {8}id: ${id}$`, 'm'));
      // The next suite runs only when every step before it passed, so a failed upload would skip it.
      expect(upload).toMatch(/^ {8}continue-on-error: true$/m);
      expect(upload.match(/^ {10}path:.*$/gm)).toEqual(['          path: test-results/']);
      expect(upload).not.toMatch(/\.miden-e2e|arc-keys|harness\.json|~\/|\$HOME/);
    }
  });
```

The "caches, uploads and checks out no path that holds the key file" test reads `steps` (now both jobs) unchanged.

In `linked-pr-injection.test.ts`, replace `'e2e-usdcx.yml chrome-usdcx-testnet',` (line 281) with `'e2e-usdcx.yml chrome-usdcx-arc',` and `'e2e-usdcx.yml chrome-usdcx-l2',`, and replace `'e2e-usdcx.yml chrome-usdcx-testnet: push 295, dispatch 325',` (line 360) with:

```ts
      'e2e-usdcx.yml chrome-usdcx-arc: push 210, dispatch 240',
      'e2e-usdcx.yml chrome-usdcx-l2: push 230, dispatch 260',
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx jest --maxWorkers=1 playwright/e2e/harness/usdcx-workflow.test.ts playwright/e2e/harness/linked-pr-injection.test.ts`
Expected: FAIL: `no job chrome-usdcx-arc`.

- [ ] **Step 3: Write the two-job workflow**

Rewrite `.github/workflows/e2e-usdcx.yml`. The header and the Arc job:

```yaml
name: E2E USDCx

# Runs the live USDCx suites on the extension after every push to main, through the runner `yarn e2e:real` uses
# (scripts/e2e-real.mjs), in two jobs. The Arc job runs usdcx-in (a deposit from the CI key into a fresh Guardian wallet),
# usdcx-burn (a Send burn to that key from a fresh standard and a fresh Guardian wallet, each waiting for Circle's payout)
# and usdcx (the round trip: burn, payout, deposit back). The L2 job then runs usdcx-in-l2 (a deposit the same key signs
# on Base Sepolia and on Arbitrum Sepolia, which Circle forwards to Arc, its relayer mints and the wallet claims) and
# usdcx-burn-l2 (Send burns from fresh Guardian wallets to the key's address on both L2s, each waiting for Circle's payout
# there and the wallet's own confirmation). Nothing is a double: public Miden testnet and its faucet, the hosted
# Guardian, Arc Testnet, Base Sepolia, Arbitrum Sepolia, Circle's Iris, forwarder and executor, xReserve, its attestation
# service and Gateway. A red payout or forward step can be Circle's doing rather than the wallet's, and its message says
# so. The runner probes every service before it builds, builds the extension itself for each suite and runs the browser
# headless.
#
# The suites burn to and deposit from ONE key, so each burn's payout refills what the deposits spend: a green run leaves
# it about 2.9 USDC richer on Arc and about 0.97 USDC richer on each L2 (a 0.99 payout less a 0.023 deposit with Circle's
# fee). On the L2s it also pays gas in ETH, which is sent to it by hand. CI has its own key, the repository secret
# USDCX_HARNESS_ARC_KEY: never a developer's harness key and never the iOS job's. In each job only the step that writes
# it to the runner's key file reads the secret; the suites read the file through the runner, and no cache or upload
# includes it.
#
# Not a per-PR gate: it spends public testnet funds and depends on services the project does not run.

on:
  push:
    branches:
      - main
  workflow_dispatch:

permissions:
  contents: read
  # The linked-PR injections list a dispatched branch's open pull request and read its description.
  pull-requests: read

# Two runs would pay into and spend from the one key, which breaks each run's payout proof, so every run, from any
# branch, queues on this one group with both its jobs and none is cancelled once it started: a cancelled run can leave a
# payout that lands in the next run's window. GitHub keeps one waiting run per group, so a run still waiting when a newer
# one queues is cancelled before it starts.
concurrency:
  group: usdcx-harness-arc-key
  cancel-in-progress: false

jobs:
  chrome-usdcx-arc:
    name: USDCx E2E (Chrome, Arc Testnet)
    runs-on: warp-ubuntu-latest-x64-8x
    # The suites' own budgets come to 160 min: usdcx-in 30, usdcx-burn two tests of 35 and usdcx 60
    # (playwright.usdcx.config.ts). Each suite's preflight and build add about 5, and a cold setup about 30 (the CLI
    # compile, the Playwright browsers' 12 and apt's 6), so 205, rounded up to 210. A dispatch may first build a linked
    # web-sdk PR from source, and its CLI cold, on this runner (30 more).
    timeout-minutes: ${{ github.event_name == 'workflow_dispatch' && 240 || 210 }}
    steps:
```

followed by the current setup steps, unchanged, from `- uses: actions/checkout@v4` through `Write the CI harness Arc key`, then the current `usdcx-in`, `usdcx-burn` and `usdcx (round trip)` steps with their uploads and the current comment above them (`e2e-usdcx.yml:113-117`), minus its parenthetical `(usdcx-burn-l2, last, is paid on other chains and runs whatever they did)` in the first sentence; its last sentence, about a failed upload, stays. The `usdcx-burn-l2` step and its upload leave this job.

Then the L2 job:

```yaml
  # After the Arc job, red or green: its suites leave nothing pending on Base Sepolia or Arbitrum Sepolia, so a red one
  # cannot break an L2 proof. Never in a cancelled run. This job's own setup guards the key: a failed step skips
  # usdcx-in-l2 and, through its condition, usdcx-burn-l2. `needs` also keeps the two jobs from spending from the key
  # at once.
  chrome-usdcx-l2:
    name: USDCx E2E (Chrome, Base and Arbitrum Sepolia)
    needs: chrome-usdcx-arc
    if: ${{ !cancelled() }}
    runs-on: warp-ubuntu-latest-x64-8x
    # usdcx-in-l2 two tests of 55 (25 of each wait on Circle's attestation, which can fall back to source finality) and
    # usdcx-burn-l2 two of 38 come to 186; with two preflights and builds (10) and a cold setup (30), 226, rounded up to
    # 230. A dispatch's from-source builds add 30.
    timeout-minutes: ${{ github.event_name == 'workflow_dispatch' && 260 || 230 }}
    steps:
```

followed by the same setup steps as the Arc job (copy them, comments included, through `Write the CI harness Arc key`), then:

```yaml
      # usdcx-in-l2 spends from the key on both L2s, and usdcx-burn-l2 proves each payout as the rise of the key's balance
      # there from a read taken right before its burn. Every deposit is mined before usdcx-in-l2's step ends, so running
      # them in this order is enough.
      - name: Run usdcx-in-l2
        id: usdcx_in_l2
        run: node scripts/e2e-real.mjs --suite usdcx-in-l2
      - name: Upload usdcx-in-l2 results
        if: always() && steps.usdcx_in_l2.outcome != 'skipped'
        continue-on-error: true
        uses: actions/upload-artifact@v4
        with:
          name: usdcx-in-l2-e2e-${{ github.run_id }}
          path: test-results/
          retention-days: 7
          if-no-files-found: ignore

      # After a red usdcx-in-l2 too: its deposits are mined before its step ends, and a burn it broadcast but never saw
      # mined would fail usdcx-burn-l2 as key-moved, naming such a deposit. Never once a setup step failed, which
      # usdcx-in-l2 not being skipped shows.
      - name: Run usdcx-burn-l2
        id: usdcx_burn_l2
        if: ${{ !cancelled() && steps.usdcx_in_l2.outcome != 'skipped' }}
        run: node scripts/e2e-real.mjs --suite usdcx-burn-l2
      - name: Upload usdcx-burn-l2 results
        if: always() && steps.usdcx_burn_l2.outcome != 'skipped'
        continue-on-error: true
        uses: actions/upload-artifact@v4
        with:
          name: usdcx-burn-l2-e2e-${{ github.run_id }}
          path: test-results/
          retention-days: 7
          if-no-files-found: ignore
```

If the parallel Sepolia-burn change has landed (a third `usdcx-burn-l2` test), the L2 ceiling is `270 || 300` with the comment's sum reading 224 + 40 = 264; change the pins in both test files to match.

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx jest --maxWorkers=1 playwright/e2e/harness/usdcx-workflow.test.ts playwright/e2e/harness/linked-pr-injection.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation checks**

| Mutation | Predicted failure |
|---|---|
| `if: ${{ always() }}` on the L2 job | "starts the L2 job after the Arc job..." |
| Drop the L2 job's `if:` (a red Arc job then skips it) | same test (`if` undefined) |
| Drop `needs:` from the L2 job | same test (`needs` undefined) |
| Give `Run usdcx-in-l2` an `if:` | "runs usdcx-in-l2 then usdcx-burn-l2..." |
| Swap the two L2 suite steps | same test |
| Drop `Write the CI harness Arc key` from the L2 job | "reads one secret, once in each job" and the setup-parity test |

Run each with the Step 4 command, restore, rerun green.

- [ ] **Step 6: Format and lint the tests**

Run: `F="playwright/e2e/harness/usdcx-workflow.test.ts playwright/e2e/harness/linked-pr-injection.test.ts"; npx prettier --check ${=F} && npx eslint --max-warnings 0 ${=F} && npx eslint --no-eslintrc -c .eslintrc.harness.json --rulesdir playwright/e2e/eslint-rules --max-warnings 0 ${=F}`
Expected: clean. Leave the YAML's formatting as written (match the existing file; no prettier pass on it).

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/e2e-usdcx.yml playwright/e2e/harness/usdcx-workflow.test.ts playwright/e2e/harness/linked-pr-injection.test.ts
git commit -m "ci(e2e): split the usdcx workflow into an arc job and an l2 job"
```

### Task 9: docs, config comment, CHANGELOG

**Files:**
- Modify: `playwright/e2e/docs/e2e-architecture.md:186`, `:370-381`, `:387`, `:395-397`, `:409-416` (`:411` included)
- Modify: `playwright.usdcx.config.ts:5`
- Modify: `CHANGELOG.md` (one line)

- [ ] **Step 1: Update the docs**

- `:186`: after "...and also waits for the wallet's own Confirmed there;" add "`--suite usdcx-in-l2` deposits from the harness key on both L2s through Circle's forward to Arc and waits for the wallet's claim;".
- Suites table (after the `usdcx-in` row), add:

```markdown
| `usdcx-in-l2` | `yarn e2e:real --suite usdcx-in-l2` | The harness key deposits 0.001 USDC plus Circle's forward fee on Base Sepolia, and the same on Arbitrum Sepolia, signed in Node through the wallet's own executor deposit, into a fresh Guardian wallet each. Each test proves the burn and its CCTP message, Circle's attestation and forward on Iris, the Arc execution into xReserve, Circle's xReserve attestation, the mint, and the wallet's own claim and row. Up to 110 min (25 of each test is room for Circle to fall back to source finality). |
```

- "Where each USDCx suite runs": the first row's workflow cell becomes "E2E USDCx's Arc job (`e2e-usdcx.yml`) ..."; replace the `usdcx-burn-l2` row with:

```markdown
| `usdcx-in-l2`, then `usdcx-burn-l2` (extension) | E2E USDCx's L2 job, after the Arc job whatever it did, never in a cancelled run (its suites read other chains, so a red Arc suite cannot break their proofs); `usdcx-in-l2` runs once the job's own setup passed, and `usdcx-burn-l2` after it, red or green; on a branch by dispatch; by hand, `yarn e2e:real --suite <name>` | The same key as the Arc suites, at its address on each L2 |
```

- `:387`: add `usdcx-in-l2-evidence.json` to the evidence file list ("which names the source chain as `sourceChainId`").
- `:397`: replace "Each `usdcx-burn-l2` run adds about 0.99 USDC to the key's address on Base Sepolia and on Arbitrum Sepolia, where it holds no ETH and never spends; the payout proof reads only the rise, so what gathers there does not matter." with: "Each `usdcx-burn-l2` run adds about 0.99 USDC to the key's address on Base Sepolia and on Arbitrum Sepolia, and each `usdcx-in-l2` run spends about 0.023 USDC there per chain (the deposit and Circle's forward fee) and a little ETH for gas. The key's ETH on the L2s is sent by hand; `usdcx-in-l2`'s preflight fails before the build, naming the chain, the key's address and the minimum, when the key holds too little ETH or USDC there. The L2 suites run in one job, `usdcx-in-l2` first: its deposits are mined before its step ends, and `usdcx-burn-l2` reads its balance right before each burn, so a deposit never lands inside a payout window."
- The CI-key paragraph (`:409`): "The step after the install, and no other step," becomes "In each of E2E USDCx's two jobs, the step after the install, and no other step,".
- `:411`: "and about 0.99 USDC richer on each L2, so it needs no refill while main is green." becomes "and about 0.97 USDC richer on each L2 (a 0.99 payout less `usdcx-in-l2`'s 0.023 deposit with Circle's fee), so its USDC needs no refill while main is green; its ETH on the L2s pays `usdcx-in-l2`'s gas and is refilled by hand (below)." (The workflow header of Task 8 gives the same 0.97.)
- Under "Fund it" (`:416`), add a bullet: "- **Fund its L2 gas:** send Base Sepolia ETH and Arbitrum Sepolia ETH to the same address (0.02 ETH each lasts hundreds of runs at testnet gas prices), while no E2E USDCx run is going."

- [ ] **Step 2: Update the config comment**

`playwright.usdcx.config.ts:5`: `usdcx|usdcx-in|usdcx-burn|usdcx-burn-l2` becomes `usdcx|usdcx-in|usdcx-burn|usdcx-in-l2|usdcx-burn-l2`.

- [ ] **Step 3: Add the CHANGELOG line**

Check the release tag (Global Constraints), then add under `## 1.17.5 (TBD)` / `### Fixes`, after PR 1's line:

```markdown
- [FIX][ci] A fifth live USDCx suite, `usdcx-in-l2`, deposits 0.001 USDC plus Circle's forward fee from the harness key on Base Sepolia and on Arbitrum Sepolia through the wallet's own executor deposit, and passes only once the burn, Circle's attestation and forward, the Arc execution, the mint and the wallet's claim are each proven; its preflight names the chain, the key and the minimum when the key needs ETH or USDC there, and E2E USDCx now runs the Arc suites and then the L2 suites as two jobs.
```

- [ ] **Step 4: Check the text**

Run (zsh; UTF-8 byte patterns, since macOS grep has no `-P`, and a positive control first so an empty answer means something):
`printf 'a\xe2\x80\x94b\n' | grep -c -e $'\xe2\x80\x94' && git diff origin/main -- . | grep '^+' | grep -c -e $'\xe2\x80\x94' -e $'\xe2\x80\x93'`
Expected: `1`, then `0` (grep exits 1 on the second count; that is the pass). Then `npx prettier --check playwright.usdcx.config.ts`. While #1498 is unmerged the diff against origin/main also carries its 33 files; their added lines held no dash at this plan's pre-flight (count 0), so the check still reads this change.

- [ ] **Step 5: Commit**

```bash
git add playwright/e2e/docs/e2e-architecture.md playwright.usdcx.config.ts CHANGELOG.md
git commit -m "docs(e2e): document usdcx-in-l2, the l2 job and the key's l2 gas"
```

---

## After both PRs

- The key already holds ETH on both L2s (bridged by hand, user 2026-10-16), so the first push run after PR 2 merges should pass `<chain> key`. The top-up message is for later runs: once a balance runs low, `usdcx-in-l2` reds at its preflight with that message, and `usdcx-burn-l2` still runs after it, as intended, since the preflight sent nothing. Before that first run, read the key's Arbitrum Sepolia ETH once more: the pre-flight read found 0 there (Global Constraints).
- First live runs to watch: the `source_burn` hook-data comparison (Review Focus 1), the first 0.001 USDC forwarded burn on each L2 (an on-chain minimum would fail `deposit_submit` at the burn's simulation), and the `<chain> write endpoint` preflight on the real hosts (the empty-raw-transaction answers of the six L2 endpoints were not probed while planning).

## Plan critique log

Each finding was checked against origin/main 25695aa9c before it was applied.

| # | Finding | Verdict | What changed, or why not |
|---|---|---|---|
| 1 | Task 3's burn check fails on hex case | Applied | Checked with viem 2.55.4: `padHex` keeps checksum case, a parsed raw transaction's `data` is lowercase, and decoded bytes32 and bytes come back lowercase. The test now compares the burn's calldata with `encodeFunctionData(...).toLowerCase()`. The approve check stays decoded, because its address arg comes back checksummed like the fixture's. |
| 2 | `spec-selection.test.ts` goes red | Applied | It pins every listed test (`:84`, `:133-135`), the runner greps, the throw-not-skip specs and the other-config regex, and #1496 extended it. Task 6 now has a pin step that is watched failing, then passing, and the file is in its lint and commit lists. |
| 3 | The L2 job's setup-passed gate rests on a false reason | Applied (the critic's preferred fix) | The L2 job writes its own key, and `usdcx-in-l2` refuses a missing key. Its own setup skips both L2 suites. The job now has `if: ${{ !cancelled() }}` and the Arc job has no `outputs:`. Updated: Global Constraints, the Task 8 test, the YAML, the comments, the mutation table, the docs row, the watch list and After both PRs. This is open question 1. |
| 4 | Sepolia "one entry later" is false; the tip cap is speculative | Applied | On main, `payoutChainFor` throws for 11155111. The field, the option, the `sendSigned` branch, the test and the mutation row are removed. The Sepolia note now lists what it really needs, including the parallel Sepolia-burn change that lifts that refusal. |
| 5 | Task 1 misses the source-route check | Applied | New test: the source has no domain and `TARGET` keeps its own. It expects the rejection, an empty `calls` and no registration read. Added the mutation row `source.midenDomain ?? 10007`. |
| 6 | Three failure predictions are wrong | Applied, plus two more | Fixed: Task 1 Step 2 (the activity mock message), Task 3 (`undefined`, since 40_000 covers 23_404) and Task 7 (14 checks, after finding 9 adds a fifth record per chain). The same import-order error was in Task 1's mutation table. Restoring `./constant` now predicts the SDK mock message (`constant.ts:4` loads `effective-endpoints`, which imports the SDK first). Importing from `./deposit` now predicts the activity message (`deposit.ts:3`). |
| 7 | Task 5's exact-move check cannot pass | Applied | Two checks replace it. A `-U0` filter allows only one-line imports, the `DepositRun` header and the `evidence,`, `budgetMs` and `readyWithinMs` lines. A `diff` of the removed lines against the helper lists the expected differences. `enText`, `bridgeReceiveState` and `Hex` joined the drop list. |
| 8 | The hookData gate compares a rebuilt intent | Applied | The signer records the tuple it received, and `L2DepositSubmission.signed` (`amount`, `destinationCaller`, `hookData`) replaces `intent`. `confirmL2Burn` compares against it. Tasks 3 and 4 and Review Focus 1 are updated, plus a mutation row. An array holds the tuple because TypeScript keeps a callback-assigned `let` narrowed to `undefined`. |
| 9 | The preflight misses the L2 write endpoint and two watch items | Applied (Arbitrum gas as a measurement) | `probeL2Rpc` now returns every serving endpoint. `probeL2WriteEndpoint` records `<chain> write endpoint` and classifies the answer as `acceptsRawTransactions` does. Added the stub answer, a failure test, the request pin, 19 checks and a mutation row. The 0.001 minimum joined the watch list: every forwarded burn read on 2026-10-16 (about 17 h of Base Sepolia, 2 h of Arbitrum Sepolia) was 5 USDC or more. Arbitrum gas was measured instead of watched: three recent forwarded burns used 698,683 gas with `gasUsedForL1` 0. That number is now in the `L2_BRIDGE_IN_GAS` doc. |
| 10 | Test scope and stale comments | Applied | Task 6 runs all of `playwright/e2e/helpers/`. Task 3 rewrites the `arc-usdcx.ts` header. Task 2 names `mobile-adapter.ts:31-34` as the second install site. |
| 11 | The overlap argument states an unknown as fact | Applied | Point 5 now limits itself to the probed burn and points to the refund watch item (`refundAddress` is the key, `executor.ts:209`, `:294`). |

No finding was rejected. Probes this revision: 31 read-only JSON-RPC calls to the public Base Sepolia and Arbitrum Sepolia endpoints (`eth_blockNumber`, `eth_getLogs`, `eth_getTransactionReceipt`). No `eth_sendRawTransaction` was sent, so the six L2 hosts' write classification is left to the new preflight record.

## Pre-flight (re-anchored onto #1498)

Checked on 2026-10-16 against `wiktor/usdcx-bridge-in-l2` at 854b56d3f, the head of #1498, which includes main 2d093db96 (#1499). Read-only: `cat`, `sed`, `grep` and `git`, plus three public JSON-RPC reads per L2 of the key's address (`eth_getBalance`, USDC `balanceOf`, `eth_gasPrice`). No jest, tsc, lint, build or E2E ran; no key was read.

Since 25695aa9c, the critique's base, these files changed: `CHANGELOG.md`, 28 locale files, `EvmBridgeDepositScreen.tsx` and `EvmBridgeDepositStatus.tsx` with their tests, `BridgeClaimSection.tsx`, `HistoryDetails.tsx` with their tests, `src/lib/usdcx/executor.ts` and its test, `src/lib/walletconnect/config.ts` and `native.ts` with their tests, and the new `src/lib/walletconnect/testing/chains.ts`. Nothing under `playwright/`, `scripts/` or `.github/` changed, so every anchor there was checked for accuracy, not for drift.

### What the new base changes for this plan

- **#1498, `executor.ts`.** `UsdcxExecutorDepositDeps` gains a required `readBalance(): Promise<bigint>`. `runUsdcxExecutorDeposit` calls it after the allowance read and before the first quote, and again after the approval's receipt before the second quote. Both times it throws `UsdcxExecutorBalanceTooLowError` when the balance is short of the amount plus that quote's fee. The new exports (`UsdcxExecutorBalanceTooLowError`, `isUsdcxExecutorBalanceTooLowError`, `UsdcxExecutorFeeShortfall`, `usdcxExecutorFeeShortfall`) are defined in the file and import nothing. The line numbers moved: the deps interface is now `:260-275`, the domain read `:312` and `refundAddress` `:249` and `:351`. The `:15-31` import block Task 1 replaces did not move. Task 3's `submitL2Deposit` left out `readBalance`, so it would have failed CI's type check and thrown `readBalance is not a function` at run time. It now passes the key's L2 USDC `balanceOf`.
- **#1498, the screen.** `EvmBridgeDepositScreen.tsx` re-reads the balance every 10 s and passes `readBalance` through `readBalanceOrFail`. The plan never drives that screen: the spec makes its row through the E2E hook, so this needs no change.
- **#1499, `walletconnect/config.ts`.** `ARC_MAINNET` (5042) is now defined locally in place of viem's `arc`, and `evmExplorerUrl` is new. `native.ts` refuses an add-chain request that has no public RPC. The plan reads `ARC_TESTNET` (unchanged), `EVM_CHAIN_DEFINITIONS` (its Base Sepolia and Arbitrum Sepolia entries are unchanged, and no testnet fixture names 5042) and `getChain`, through `payoutChainFor` (unchanged for 84532 and 421614). No plan change.
- **CHANGELOG.** `## 1.17.5 (TBD)` / `### Fixes` now has four entries: `usdcx-burn-l2`, then #1495, #1498 and #1499. The latest release tag is v1.17.4, both locally and on origin. `CHANGELOG.md merge=union` holds.
- **`e2e-usdcx.yml`** is unchanged: one job, `chrome-usdcx-testnet`, with ceilings of 295 for a push and 325 for a dispatch. Task 8's premises hold, apart from the comment fix in change 23.

### Changes made to this plan

1. Architecture: lists `runUsdcxExecutorDeposit`'s balance reads and its #1498 refusals, in call order.
2. Global Constraints: the key holds ETH on both L2s (the user's decision), so the top-up message is for later runs. Adds the pre-flight read and drops the stale "1_977_802 USDC units and 0 ETH on each L2".
3. Why one job's order is enough, point 5: `refundAddress` anchors move from `executor.ts:209`, `:294` to `:249`, `:351`.
4. Review Focus 4: adds the product's own balance refusal and the Task 3 test that pins it.
5. Size: Task 3 is now about +440 / -30.
6. PR 1: adds that it builds on #1498, so its base is #1498's branch until #1498 merges.
7. Task 1 Files: anchors `:1-31`, `:213-268` become `:15-31`, `:260-275`, `:310-315`.
8. Task 1 Interfaces: #1498's exports and the required `readBalance` stay as they are and need no import.
9. Task 1 Step 1: adds a note that `makeDeps` logs `readBalance`, with the full call order. An empty `calls` therefore pins both refusals ahead of every read.
10. Task 1 Step 2: explains why the three domain tests still fail. `makeDeps`'s balance of 10_000_000 covers the fee, so nothing else throws.
11. Task 1 Step 4: gives the domain read's line (312) and says #1498's code stays untouched.
12. Task 2 Step 3: the CHANGELOG line goes right after the `usdcx-burn-l2` entry, which is the section's first. Notes that v1.17.4 is the latest release.
13. Task 3 Interfaces: `readBalance` is required, with the whole call order.
14. Task 3 test: `l2Chain` takes `usdc` and records the calldata of every `balanceOf` call in `balanceReads`.
15. Task 3 test: the main test pins two `balanceOf(key)` reads; the no-approve test pins one.
16. Task 3 test: new test, "sends nothing when the key's USDC does not cover the amount and Circle's fee" (23_403 units: the product refuses before the approve, and nothing is sent).
17. Task 3 code: `submitL2Deposit` passes `readBalance`, which reads `balanceOf(key)` on the route's USDC through `chainRead` on `endpoints.reads` (write endpoint first).
18. Task 3 code: the module header and `submitL2Deposit`'s doc name the product's balance checks.
19. Task 3 mutations: adds two `readBalance` rows (one reads the allowance, one reads the fee entry point's balance), with how to apply the first.
20. Task 6 Files: `bridge.ts` anchors become `:541-551`, `:573-587` (a `type`) and `:615-628`.
21. Task 7 Step 1: the full-run refusal test moves into `describe('a usdcx run')` (`:1942`). The describe at `:1038` passes `--preflight-only` to every call, so the `create` mutation row could never fail there.
22. Task 7 Step 3: the USAGE sentence starts mid-line at `e2e-real.mjs:276`, and "the usage" test (`:2309`) pins its first clause on one line.
23. Task 8 Step 3: the Arc job keeps the comment at `:113-117` minus its parenthetical about `usdcx-burn-l2`. The old text said to drop the "last sentence", but that sentence is about uploads.
24. Task 9: adds the `:411` update (about 0.97 USDC richer per L2, and the ETH refilled by hand), so the doc agrees with the workflow header.
25. Task 9 Step 4: notes that while #1498 is unmerged, `git diff origin/main` also carries its 33 files, which have no dash (count 0).
26. After both PRs: the key already holds ETH, and the top-up message is for later runs. Re-read the Arbitrum Sepolia ETH before the first run.

### Premises checked that hold

- Task 1:
  - `executor.ts:15` imports `lib/miden/activity` ahead of `./constant` (`:18-30`), and `deposit.ts:3` imports it too.
  - The class and guard are at `deposit.ts:42-55`, and the throw at `:106`.
  - `constant.ts:4` loads `effective-endpoints`, whose line 1 imports `@miden-sdk/miden-sdk/lazy`.
  - `protocol.ts` exports every constant and ABI Task 1 imports.
  - `schema.ts:426` drops a usdcx route that has no `midenDomain`.
  - `executor.test.ts` mocks `lib/miden/activity` and the runtime, and `deposit.test.ts:12-18` imports the error and guard from `./deposit`.
  - So every Step 2 prediction and mutation prediction holds.
- Task 2: hooks `:6`, `:24-49`, `:83-111`, `bridge-receive.ts:260-261` and `mobile-adapter.ts:31-34` are as stated, and `IUsdcxCctpLeg` has `sourceDomain`, `forwarded?` and `forwardFee?`.
- Task 3:
  - `arc-usdcx.ts` has `ERC20_ABI` at `:56`, `chainOf` at `:207`, `onFirstEndpoint` at `:221`, `pickWriteEndpoint` at `:682`, `startingAt` at `:725`, `arcRead` at `:729`, `simulate` at `:744`, `sendSigned` at `:769` and `waitForReceipt` at `:818`.
  - A pre-aborted signal fails at `refuseSendIfAborted` with "USDC approve not sent", after both balance reads.
  - The fixture's executor routes for 84532 and 421614 match `getUsdcxExecutorSource`'s reads.
- Task 4: `confirmDepositToMiden` is at `:959`, and `errorText`, `lowerHex` and `XRESERVE_HARNESS_ABI` are as used.
- Task 5: the spec anchors hold to within the doc comments above them (`trackReceiveRows` `:191`, `receiveLeg` `:376`, and the two calls at `:653`, `:768`).
- Task 7:
  - The count of 19 checks is Miden RPC, Miden faucet API and Guardian identity, plus 6 from `probeUsdcx` (no `arc-payout`, no `funded-key`), plus 5 per L2. The mutation counts of 14 and 17 follow.
  - `usdcx-burn-l2` stays at 17.
  - `resolveArcKey` runs at `runSuite`'s first line, before `installPinnedCli`, so a refusal logs no SPAWN.
- Task 8:
  - In `linked-pr-injection.test.ts`, 210 + 30 = 240 and 230 + 30 = 260 meet `dispatchMinutes` (x64-8x with the CLI is 30).
  - Its `jobs()` parser skips the comment above the L2 job.
  - Without a `pull_request` trigger, `if: ${{ !cancelled() }}` never reaches `ifCanHoldOnPullRequest`, which could not parse it.
  - Only the two tests named in Task 8 (and older plans) name `chrome-usdcx-testnet`.
- Task 9: anchors `:186`, `:370-381`, `:387`, `:395-397`, `:409`, `:416` and `playwright.usdcx.config.ts:5` hold.

### Conflict scan

| Tasks | Shared file or interface | What one produces, what the other consumes | Verdict |
|---|---|---|---|
| 1, 3 | `executor.ts` exports; `usdcx-node-imports.test.ts` | Task 1 makes the executor load in Node and keeps `UsdcxExecutorDepositDeps` (with #1498's required `readBalance`). Task 3 imports it and now passes `readBalance`. Both append to the node-imports test, and Task 3's `it` relies on Task 1's two mocks to mean "no SDK" | Consistent after changes 13-17 |
| 1, 4 | `executor.ts` (`addressToBytes32`), `protocol.ts` (`GENERIC_EXECUTOR_ABI`) | Task 4 imports both in Node; that is safe only after Task 1 | Consistent; Task 4 runs after Task 1 |
| 1, 6 | the spec's import graph | `spec-selection.test.ts` loads `usdcx-l2-deposit.ts`, and through it `executor.ts`, in Node | Consistent after Task 1 |
| 2, 3 | the `submitting` write | Task 3's `submitted` is what `runUsdcxExecutorDeposit` writes (`usdcxRemoteRecipient`, and `cctp` with `sourceDomain`, `forwarded`, `forwardFee`). Task 2's hook takes `Pick<IUsdcxCctpLeg, ...>` of the same fields. #1498 did not change that write (`executor.ts:353-357`) | Consistent |
| 2, 6 | hook args and state | Task 2 adds `usdcxRemoteRecipient`, `cctp` and the state's `usdcxExecuteTxHash`; Task 6's `bridge.ts` mirrors all three under the same names | Consistent |
| 2, 9 | `CHANGELOG.md` | Task 9 adds PR 2's line after PR 1's (Task 2), under `1.17.5 (TBD)` (`merge=union`) | Consistent |
| 3, 4 | `arc-usdcx.ts`; `L2DepositSubmission` | Task 3 exports `waitForReceipt` and `startingAt` and makes them chain-generic. Task 4 uses them with `ArcReadDeps` that carry `payoutChain`, and consumes `endpoint`, `burnHash`, `signed` and `burnQuote`. Task 4's own edit is anchored by name (`confirmDepositToMiden`), so Task 3's line shifts cannot misplace it | Consistent |
| 3, 6 | `usdcx-l2-deposit.ts` API | The spec calls `l2Reads(l2)`, `readL2KeyFunds`, `quoteL2Deposit`, `l2KeyShortfall({ label, address, ...funds, units, fee })` and `submitL2Deposit(args, {}, signal)`, all as produced | Consistent |
| 3, 7 | `L2_BRIDGE_IN_SOURCES`, `L2_BRIDGE_IN_GAS` | Task 7's copies are pinned to Task 3's. The runner's fixed USDC floor (0.101) is stricter than the spec's live need (0.001 plus twice the quote) while the fee stays at or under 0.05, and the product's own check (amount plus fee) is the loosest | Consistent; three layers, strictest first |
| 4, 6 | gate signatures | The spec's calls of `confirmL2Burn`, `waitForIrisForward` and `confirmArcForward` match Task 4's produced signatures | Consistent |
| 5, 6 | `usdcx-receive.ts` | The spec calls `trackReceiveRows(wallet, rowId, undefined)` and `receiveLeg(..., { budgetMs, readyWithinMs, ... })` as Task 5 produces them | Consistent |
| 6, 7 | test titles, grep | `USDCx L2 bridge-in` matches only the new describe, and none of the four existing greps (`USDCx round trip`, `funded Arc key`, `USDCx burn through the Send UI`, `USDCx L2 burn`) matches its titles | Consistent |
| 7, 8 | suite name | The workflow runs `--suite usdcx-in-l2`, which Task 7 defines | Consistent |
| 8, 9 | job shape in the docs | Task 9's rows say "after the Arc job whatever it did, never in a cancelled run", which matches `if: ${{ !cancelled() }}`. Its `:411` line matches the YAML header's 0.97 | Consistent after change 24 |

| Task | Its tests vs its code; files it creates vs files later touched | Verdict |
|---|---|---|
| 1 | The three domain tests use `makeDeps` (with `readBalance`); refusals precede every read. The node-imports test is touched again by Task 3 (an append) | Consistent |
| 2 | Both new tests use the hook as changed, and the second reaches the reconciler only because of the `cctp` spread. `CHANGELOG.md` is touched again by Task 9 | Consistent |
| 3 | After changes 14-19, every `submitL2Deposit` test runs `readBalance` through the stub's `balanceOf`. `arc-usdcx.ts` is touched again by Task 4, and `usdcx-l2-deposit.ts`, which Task 3 creates, only feeds Tasks 4 and 6 | Consistent |
| 4 | Every message a test expects is the format of the code's checks (`${field}: ${actual}, expected ${wanted}`); the vectors file is created here and only read later | Consistent |
| 5 | A pure move checked by two diffs; `usdcx-receive.ts` is created here and imported by Task 6 | Consistent |
| 6 | The listing test is pinned before the spec exists (it fails with ENOENT) and passes after | Consistent |
| 7 | Was inconsistent: the full-run refusal test sat in a describe whose invocations are all `--preflight-only`. Fixed by change 21 | Fixed |
| 8 | The `jobBlock` and `stepsOf` helpers read the YAML Step 3 writes; the setup-parity test needs the L2 job's setup copied with its comments | Consistent |
| 9 | Docs only; Step 4's dash check covers #1498's lines too (0 today) | Consistent |

### Doubts that need a ruling

1. **The key's Arbitrum Sepolia ETH reads 0.** All three Arbitrum Sepolia endpoints (`sepolia-rollup.arbitrum.io/rpc`, publicnode, tenderly) report 0 wei and nonce 0 for `0x4D4A180C637a71FCB9b5BD1186C8ce23C40EBa81`. Base Sepolia reports 0.024 ETH. Either the bridge to Arbitrum Sepolia had not landed at the read, or it went to another address. The plan keeps the user's decision (the top-up message is for later runs); someone should confirm the Arbitrum balance before the first push run after PR 2 merges.
2. **Base of PR 1.** PR 1 edits the `executor.ts` that #1498 changed, and this branch is at #1498's head. Open PR 1 on #1498's branch now, or wait until #1498 merges and open it on main? (Recommended: wait for #1498 to merge, then base PR 1 on main.)
3. **One consumer outside the CPU rule's run list.** `EvmBridgeDepositScreen.usdcx.test.tsx` calls `jest.requireActual('lib/usdcx/executor')` while mocking `lib/usdcx/deposit` without the error class. After Task 1 the executor no longer imports `./deposit`, so it loads the same or better, and CI runs that file. Should Task 1 Step 5 also run that one file with `--maxWorkers=1`? (Recommended: yes, one file; it is the only test outside `src/lib/usdcx/` that loads the real executor.)
4. **Settled only by running Task 3.** The `balanceReads` assertion compares the calldata viem's `readContract` sends with `encodeFunctionData` of the same call. Both go through one encoder (which lowercases the address), so they should be byte-equal; Task 3 Step 7 is the first run that proves it.
