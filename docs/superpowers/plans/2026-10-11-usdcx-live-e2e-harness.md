<!-- Tasks: 14 (Tasks 19-32 of the 32-task PR 1 plan 2026-10-10-usdcx-live-e2e-pr1.md, numbers unchanged). PR 1b of 2: E2E harness, extension suites, runner and docs. -->

# USDCx Live E2E Harness (PR 1b) Implementation Plan

> **Stacked on PR 1a (wiktor/usdcx-fixes); branch wiktor/usdcx-live-e2e off it; re-anchor any snippet that PR 1a changed.**

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three local `yarn e2e:real` suites, `usdcx`, `usdcx-in` and `usdcx-burn`, that drive fresh extension wallets on live testnet through a public faucet grant, a Send-UI burn to a fresh Arc key, Circle's Gateway payout and the wallet's own confirmation of it, a Node-signed deposit back through xReserve, Circle's attestation, the relayer's mint and the wallet's consume, every hop checked to the base unit. The product fixes they depend on are PR 1a (`2026-10-11-usdcx-fixes.md`).

**Architecture:** 14 TDD tasks in four groups, committed as spec section 14's PR 1 commits 9-13 (commit 10 lands after 11 and 12, because its grep-contract tests read their spec titles). The shared harness (Tasks 19-24, commit 9) adds Node-side modules under `playwright/e2e/helpers/`: constants read from the product tables, the Arc legs over viem with injectable clients and clock, the Miden chain oracle in a child process on the SDK's browser WASM build, the hosted Guardian's identity, typed row readers and the Send-UI burn driver, each unit-tested against captured public chain data with no network. The extension specs (Tasks 25-28, commits 11-12) live under `playwright/e2e/tests/usdcx/` with a Playwright config no CI job collects; their pure decisions sit in `helpers/usdcx-run.ts` with jest tests, and the live runs happen only in Delivery. The runner (Tasks 29-31, commit 10) adds the suites, refusals, probes and per-phase child environments to `scripts/e2e-real.mjs`; docs and CHANGELOG close the PR (Task 32, commit 13). Tasks 19-32 consume PR 1a's interfaces (Appendix A.1, A.2): the persisted `usdcxRemoteRecipient` and `readyAt` row fields, the decoder and matcher in `src/lib/usdcx/attestation.ts`, the test hooks and test ids of Task 18, and the Sepolia executor source.

**Tech Stack:** TypeScript (no `any`, no `as` in src), Jest 30 (swc, `@jest-environment node` for harness and runner tests), Playwright 1.61 with the Chrome extension fixtures, viem (Arc Testnet reads, local signing, ABI decoding), `@miden-sdk/miden-sdk` 0.17.3 (the chain oracle loads its browser WASM build in a Node child), Node 22 for `scripts/e2e-real.mjs`.

**Spec:** docs/superpowers/specs/2026-10-09-usdcx-live-e2e-design.md (PR 1 of its section 14, commits 9-13)

Reading this plan:
- Tasks are numbered 19-32 and keep the numbers they have in the 32-task PR 1 plan; Tasks 1-18 are PR 1a and are cited by number, not repeated. Each heading ends with its partition key, and a reference such as "Task 24 (p3-arc)" points at it. "Appendix A" (end of file) is the cross-task interface contract, kept whole; the tasks cite it as "contract N.M" or "interfaces section N".
- Edits are exact text replacements anchored on quoted current text, applied top to bottom. A `path:N-M` cite inside a task names the file as it stands at the start of that task; a cite marked origin/main, @main or "on main" names origin/main 6856c9f6a, identical to the drafting base 791adbd3f for every file this PR touches except `CHANGELOG.md` (#1402 added one line at :15, so #1401's line is now :17). A cite to a file PR 1a changed names the file as it stands after PR 1a; re-anchor such a snippet on its quoted text. When a line number and the quoted text disagree, the text wins.
- A fenced block whose last line is empty ends in a newline; the empty line is not an extra blank line in the file.
- `(spike-dependent: <what>)` marks a point the step 1 spike decides. Spike v2 on main (2026-10-10 evening) already answered three: under `E2E_HEADLESS=1` the page kept `visibilityState` `visible` and the watcher lock, so the headless default (Q8) stands; the wallet confirmed the payout 27.4 s after the burn's consume (4.8 s after the payout block), inside `WALLET_CONFIRM_TIMEOUT_MS`; the deposit back was attested 5 s after its block, minted in 35 s and auto-consumed in 40 s. Markers on those points stand as written. Still open: freezing the step budgets, and `burnOutputs`'s decode by role (no burn row's `resultBytes` has been decoded yet).

## Global Constraints

- Base: branch `wiktor/usdcx-live-e2e` in `/Users/celrisen/miden/wt-usdcx-e2e`, created off `wiktor/usdcx-fixes` (PR 1a, on origin/main 6856c9f6a with the spec commits) once Tasks 1-18 are committed there (Setup, before Task 19). The PR's base branch is `wiktor/usdcx-fixes` until PR 1a merges.
- Toolchain: `export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"`; jest runs as `yarn jest <paths> --maxWorkers=2`; node_modules must hold `@miden-sdk/miden-sdk` 0.17.3 (package.json:161).
- New jest tests under `playwright/` and `scripts/` start with the `@jest-environment node` docblock (jest.config.ts:152 defaults to jsdom).
- Commits: one per spec commit, the single-line message of spec 14 step 2 verbatim, no trailers of any kind, `git add` by explicit path, never `git add -A`, never amend.
- No em dash (U+2014) or en dash (U+2013) anywhere: code, comments, copy, test titles, commit messages, PR text.
- Comments match each file's density and say why, never what.
- English copy: Task 20 reads PR 1a's keys from `public/_locales/en/en.json` and `messages.json`; this PR adds none. Never run prettier on `public/_locales`.
- CHANGELOG: PR 1a already edited #1100's line (:7) and added the `[FIX][all]` line; this PR adds only the `[FIX][ci]` suites line under `## 1.17.2 (TBD)`; #1401's and #1402's lines unchanged (Q1).
- Live suites: testnet only, retries 0, `maxFailures` 1; `playwright.usdcx.config.ts` timeout 3_600_000; `usdcx-in` describe 1_800_000; `usdcx-burn` describe 1_500_000.
- Constants (no env overrides): `BURN_UNITS` 10_000_000n, `DEPOSIT_UNITS` 1_000_000n, `GAS_RESERVE_UNITS` 50_000n, `GRANT_MARGIN_UNITS` 1_000_000n, `PAYOUT_TIMEOUT_MS` 600_000, `WALLET_CONFIRM_TIMEOUT_MS` 120_000, `ARC_LOG_CHUNK` 1000 (100 on drpc).
- Guards: every usdcx describe throws in `test.beforeAll` unless `E2E_REAL_USDCX === 'true'` and `E2E_NETWORK === 'testnet'`; `usdcx-in` also throws without `E2E_ARC_PRIVATE_KEY`; no `test.skip`.
- Isolation: `playwright.e2e.config.ts` testIgnore gains `'**/usdcx/**'`; no USDCx spec is named `guardian-*.spec.ts` or `bridge-out-epoch-guardian.spec.ts` or lives under `tests/bridge`.
- Guardian: the hosted `https://guardian.openzeppelin.com` only, read from `getEnvironmentConfig().guardianUrl`; `process.env.GUARDIAN_URL` is never read.
- Payout gate (D3): red 10 min after the burn's consume without exactly one GatewayMinter `AttestationUsed` log for the key whose `gatewayMint` calldata carries the burn note id; the wallet's own `destinationBalanceConfirmed` is a hard gate as well (Q6), and the deposit back runs only after it.
- Fees are read from the rows that paid them, never pinned; a landed path's fee is bounded, `0 < f <= baseFee x FEE_RESERVE_MULTIPLE`, and recorded as `bounded` (Q5(d)).
- Arc RPC order: `--arc-rpc` / `E2E_ARC_RPC_URL` first, then drpc, QuickNode, and `rpc.testnet.arc.io` last (the wallet's own Arc RPC).
- Key ledger: `~/.miden-e2e/arc-keys/<iso>-<address>.json`, mode 0600 in a 0700 directory, written before the burn, never logged, attached or committed.
- Runner refusals, by name and never by value: `--network devnet`, `--skip-build`, exported `E2E_EVM_RPC_URL`, `MIDEN_E2E_USDCX_CHAIN`, `MIDEN_FEE_FAUCET_ID` or `GUARDIAN_URL`, and the key errors.
- Never call `midenCli.mint`, `ensureFeeFunded`, `fundAccountForFees` or `claimAllNotes` in a usdcx spec: each adds a consume row or overlaps a requeued Guardian consume.
- Review is a standard review only, no review-council (D12).
- The worktree may host another session's build or spike: never run `yarn install`, a build, an E2E run or `git checkout` while one is running there.

## Review Focus

The failure mode in the harness most likely to slip past the drafted tests. It has a pinning test in its owning task, mutation-checked on the final tree.

1. **A caller still using the chain oracle's removed positional form** (Task 23, p3-miden-oracle). Between commits 9 and 12, `tests/bridge/bridge-out-usdcx.spec.ts` still calls `usdcx-chain-evidence.mjs <rpcUrl> <faucet> ...`. It skips without `USDCX_TESTNET_REPO`, but anyone who runs it must get a loud failure, never an RPC URL read as a subcommand argument. Pinned by `refuses the removed positional form, an RPC URL first, with its usage line` (usdcx-miden.test.ts), and Step 7 of that task lists every caller.

## Task Index

Execution order. Commit 10 is made by Task 31, after commits 11 and 12: its grep-contract tests read the describes those commits add.

| Task | Key | Title | Spec commit |
|---|---|---|---|
| 19 | `p3-constants` | USDCx harness constants in usdcx-constants.ts | 9, deferred to Task 24 |
| 20 | `p3-row-readers` | Row readers: history projection, bridged-send rows, en copy and bridged-receive hooks | 9, deferred to Task 24 |
| 21 | `p3-bridge-out-usdcx` | bridgeOutUsdcx and readNativeDisplaySymbol, the Send UI burn driver | 9, deferred to Task 24 |
| 22 | `p3-guardian` | Guardian identity, failure context and burn-row checks in usdcx-guardian.ts | 9, deferred to Task 24 |
| 23 | `p3-miden-oracle` | Miden chain oracle: usdcx-chain-evidence.mjs subcommands and usdcx-miden.ts | 9, deferred to Task 24 |
| 24 | `p3-arc` | Arc Testnet legs in arc-usdcx.ts: keys, payout gate, deposit, attestation | 9, made here |
| 25 | `p5-config-isolation` | A Playwright config of its own for the USDCx live suites, ignored by the base config | 11, deferred to Task 27 |
| 26 | `p5-roundtrip` | The shared run helpers, the grant and burn legs, and the extension Guardian round trip | 11, deferred to Task 27 |
| 27 | `p5-bridge-in` | The extension funded-key bridge-in describe | 11, made here |
| 28 | `p5-burn-retarget` | The USDCx burn spec onto the public faucet grant, moved to tests/usdcx | 12, made here |
| 29 | `p4-args-env` | The usdcx SUITES, --arc-rpc/--arc-key, the usdcx refusals and run() unset | 10, deferred to Task 31 |
| 30 | `p4-probes` | Bounded 429/-32005 retry, the usdcx probes and the fetch stub | 10, deferred to Task 31 |
| 31 | `p4-suites` | Per-phase child env, the pinned CLI before the build, headless by default, USAGE | 10, made here |
| 32 | `p5-docs-changelog` | The USDCx live suites and the key ledger in e2e-architecture.md, and the CHANGELOG | 13, made here |

## Setup (once, before Task 19)

Run only when no other session is using this worktree: another session's build or spike may be running there.

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
git status --short                          # must print nothing tracked
git switch wiktor/usdcx-fixes              # Tasks 1-18 committed here (PR 1a)
git log --oneline origin/main..HEAD         # four spec commits, then PR 1a's commits
git switch -c wiktor/usdcx-live-e2e
yarn install --frozen-lockfile
grep '"version"' node_modules/@miden-sdk/miden-sdk/package.json
```

Expected: the SDK version reads `"version": "0.17.3",`. Tasks 19-32 consume the product tree PR 1a builds; if PR 1a changed a file a snippet below quotes, the quoted text wins over its line number. If PR 1a has already merged into main, start from origin/main instead of `wiktor/usdcx-fixes`. This plan file stays untracked unless the controller commits it.

The spec 14 step 1 proof spike has already run on main (spike v2, see the header); Delivery step 1 records what remains open.

---

### Task 19: USDCx harness constants in usdcx-constants.ts (p3-constants)

The fixed numbers of spec section 5 and the Arc Testnet addresses, read from the product tables so harness and wallet cannot drift. Every p3 task ends at its green run; the last p3 task (Task 24, p3-arc) makes commit 9 with every p3 path. All six p3 tasks were drafted and run green in a scratch copy of origin/main's `playwright/` tree over the worktree's `src/` (the src modules p3 imports are identical on both): jest, prettier, eslint, `tsc --noEmit` on the touched import graph and `lint:e2e`; every oracle subcommand except `burn-outputs` was also run against testnet.

**Files:**
- Create: `playwright/e2e/helpers/usdcx-constants.ts`
- Create: `playwright/e2e/helpers/arc-usdcx.test.ts` (constants block only; the Arc task replaces its imports and appends)

**Interfaces:**
- Consumes: `getUsdcxXReserveSource(chainId): UsdcxXReserveSource` (src/lib/usdcx/constant.ts:288-292), `ARC_TESTNET` (src/lib/walletconnect/config.ts:12-19), `USDCX_REMOTE_DOMAIN` (constant.ts:329), `USDCX_BURN_TAG` (:335), `USDCX_BURN_WITHDRAWAL_ATTACHMENT_SCHEME` (:337), `minimumUsdcxPayout(chainId: number, amount: bigint): bigint` (:238-243), `FEE_RESERVE_MULTIPLE` (src/lib/miden/fees/spendable.ts:84; that module imports only `metadata/scale` and a type, so Node can load it).
- Produces (contract 3.1): `BURN_UNITS = 10_000_000n`, `DEPOSIT_UNITS = 1_000_000n`, `GAS_RESERVE_UNITS = 50_000n`, `GRANT_MARGIN_UNITS = 1_000_000n`, `PAYOUT_TIMEOUT_MS = 600_000`, `WALLET_CONFIRM_TIMEOUT_MS = 120_000`, `ARC_LOG_CHUNK = 1000`, `ARC_DRPC_LOG_CHUNK = 100`, `GATEWAY_MINTER: Address`, `ATTESTATION_USED_TOPIC: Hex`, `ARC_DRPC_URL`, `ARC_QUICKNODE_URL`, `ARC_PUBLIC_URL: string`, `DEFAULT_ARC_RPCS: readonly string[]`, `ARC_KEY_LEDGER_DIR: string`, `ARC_CHAIN_ID: number`, `ARC_XRESERVE: Address`, `ARC_USDC: Address`, `ARC_ATTESTATION_API: string`, `ARC_CIRCLE_DOMAIN: number`, `GUARDIAN_ECDSA_SCHEME = 'ecdsa'`, re-exports `USDCX_REMOTE_DOMAIN`, `USDCX_BURN_TAG`, `USDCX_BURN_WITHDRAWAL_ATTACHMENT_SCHEME`, `minimumUsdcxPayout`, `FEE_RESERVE_MULTIPLE`. Also `interface ArcClock { now(): number; sleep(ms: number): Promise<void> }` and `realArcClock: ArcClock`, defined here (not in arc-usdcx.ts) so usdcx-miden.ts, written before arc-usdcx.ts, can use them; arc-usdcx.ts re-exports both, so the contract's import path holds.

Spike evidence for the two spike-dependent budgets (spike v2 on main, 2026-10-10 20:10Z): Circle paid 25 s after submit and the wallet confirmed 2.3 s after the payout, so `PAYOUT_TIMEOUT_MS` 600_000 and `WALLET_CONFIRM_TIMEOUT_MS` 120_000 stand. (spike-dependent: frozen by spec 14 step 1; the controller may lower them.)

- [ ] **Step 1: Write the failing test.** Create `playwright/e2e/helpers/arc-usdcx.test.ts`:

```ts
/**
 * @jest-environment node
 */
import os from 'os';
import path from 'path';
import { keccak256, toBytes } from 'viem';

import {
  ARC_ATTESTATION_API,
  ARC_CHAIN_ID,
  ARC_CIRCLE_DOMAIN,
  ARC_DRPC_URL,
  ARC_KEY_LEDGER_DIR,
  ARC_PUBLIC_URL,
  ARC_QUICKNODE_URL,
  ARC_USDC,
  ARC_XRESERVE,
  ATTESTATION_USED_TOPIC,
  BURN_UNITS,
  DEFAULT_ARC_RPCS,
  DEPOSIT_UNITS,
  GAS_RESERVE_UNITS,
  GRANT_MARGIN_UNITS,
  minimumUsdcxPayout
} from './usdcx-constants';

describe('usdcx-constants', () => {
  it("reads the Arc Testnet xReserve source from the wallet's own table", () => {
    expect(ARC_CHAIN_ID).toBe(5042002);
    expect(ARC_XRESERVE).toBe('0x008888878f94C0d87defdf0B07f46B93C1934442');
    expect(ARC_USDC).toBe('0x3600000000000000000000000000000000000000');
    expect(ARC_ATTESTATION_API).toBe('https://xreserve-api-testnet.circle.com');
    expect(ARC_CIRCLE_DOMAIN).toBe(26);
  });

  it('names the GatewayMinter mint event by its signature hash', () => {
    expect(ATTESTATION_USED_TOPIC).toBe(
      keccak256(toBytes('AttestationUsed(address,address,bytes32,uint32,bytes32,bytes32,uint256)'))
    );
  });

  it("reads Arc through drpc, then QuickNode, and the wallet's own arc.io last", () => {
    expect(DEFAULT_ARC_RPCS).toEqual([ARC_DRPC_URL, ARC_QUICKNODE_URL, ARC_PUBLIC_URL]);
    expect(ARC_PUBLIC_URL).toBe('https://rpc.testnet.arc.io');
  });

  it('keeps the key ledger in the home directory, outside the repository', () => {
    expect(ARC_KEY_LEDGER_DIR).toBe(path.join(os.homedir(), '.miden-e2e', 'arc-keys'));
  });

  it('sizes the round trip so the payout floor and the deposit back both fit', () => {
    expect(BURN_UNITS).toBe(10_000_000n);
    expect(GRANT_MARGIN_UNITS).toBe(1_000_000n);
    expect(minimumUsdcxPayout(ARC_CHAIN_ID, BURN_UNITS) >= DEPOSIT_UNITS + GAS_RESERVE_UNITS).toBe(true);
  });
});
```

Mutation notes:
- "reads the Arc Testnet xReserve source": set `ARC_XRESERVE = ARC_SOURCE.usdc`; its `toBe` fails.
- "names the GatewayMinter mint event": change one hex digit of `ATTESTATION_USED_TOPIC`; `toBe(keccak256(...))` fails.
- "reads Arc through drpc ...": put `ARC_PUBLIC_URL` first in `DEFAULT_ARC_RPCS`; `toEqual` fails.
- "keeps the key ledger ...": drop `'.miden-e2e'` from the join; `toBe` fails.
- "sizes the round trip ...": set `GAS_RESERVE_UNITS = 9_000_000n`; the `>=` check reads false.

- [ ] **Step 2: Run it and see it fail.**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
yarn jest playwright/e2e/helpers/arc-usdcx.test.ts --maxWorkers=2
```

Expected: the suite fails to load with `Cannot find module './usdcx-constants' from 'playwright/e2e/helpers/arc-usdcx.test.ts'`.

- [ ] **Step 3: Implement.** Create `playwright/e2e/helpers/usdcx-constants.ts`:

```ts
/**
 * The fixed numbers of the USDCx live suites (spec section 5) and the Arc Testnet addresses, read from the product's
 * own tables so the harness and the wallet cannot drift apart. Nothing here reads the environment.
 */
import os from 'os';
import path from 'path';
import type { Address, Hex } from 'viem';

import { getUsdcxXReserveSource } from '../../../src/lib/usdcx/constant';
import { ARC_TESTNET } from '../../../src/lib/walletconnect/config';

export {
  minimumUsdcxPayout,
  USDCX_BURN_TAG,
  USDCX_BURN_WITHDRAWAL_ATTACHMENT_SCHEME,
  USDCX_REMOTE_DOMAIN
} from '../../../src/lib/usdcx/constant';
export { FEE_RESERVE_MULTIPLE } from '../../../src/lib/miden/fees/spendable';

/** The UI burn: 10 USDCx. */
export const BURN_UNITS = 10_000_000n;
/** The deposit back: 1 USDC. */
export const DEPOSIT_UNITS = 1_000_000n;
/** Arc gas is paid in USDC; approve plus depositToRemote cost 0.0038-0.0067 USDC (spec section 3). */
export const GAS_RESERVE_UNITS = 50_000n;
/** What the grant must leave above the burn for the burn's own fees. */
export const GRANT_MARGIN_UNITS = 1_000_000n;
/** D3: red this long after the burn's consume without a destination mint. */
export const PAYOUT_TIMEOUT_MS = 600_000;
/** Step 8b: the wallet's own confirmation of a payout the harness already proved. */
export const WALLET_CONFIRM_TIMEOUT_MS = 120_000;
export const ARC_LOG_CHUNK = 1000;
/** drpc refuses a 1000-block eth_getLogs with a misleading "ranges over 10000 blocks" message. */
export const ARC_DRPC_LOG_CHUNK = 100;

export const GATEWAY_MINTER: Address = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B';
/** GatewayMinter's `AttestationUsed(address,address,bytes32,uint32,bytes32,bytes32,uint256)`, the payout's mint. */
export const ATTESTATION_USED_TOPIC: Hex = '0xbb312ce0cc311b2cb0746e09ccd2f91fdb9e2ac755d2f11c65300eb0d0fffd63';

export const ARC_DRPC_URL = 'https://rpc.drpc.testnet.arc.io';
export const ARC_QUICKNODE_URL = 'https://rpc.quicknode.testnet.arc.io';
export const ARC_PUBLIC_URL: string = ARC_TESTNET.rpcUrls.default.http[0];
/** arc.io is the wallet's only Arc RPC (burn snapshot and payout confirmation), so the harness reads it last. */
export const DEFAULT_ARC_RPCS: readonly string[] = [ARC_DRPC_URL, ARC_QUICKNODE_URL, ARC_PUBLIC_URL];
/** Per-run Arc keys, mode 0600, outside test-results and the repository. */
export const ARC_KEY_LEDGER_DIR = path.join(os.homedir(), '.miden-e2e', 'arc-keys');

export const ARC_CHAIN_ID: number = ARC_TESTNET.id;
const ARC_SOURCE = getUsdcxXReserveSource(ARC_TESTNET.id);
export const ARC_XRESERVE: Address = ARC_SOURCE.xReserve;
export const ARC_USDC: Address = ARC_SOURCE.usdc;
export const ARC_ATTESTATION_API: string = ARC_SOURCE.attestationApi;
export const ARC_CIRCLE_DOMAIN: number = ARC_SOURCE.domain;
export const GUARDIAN_ECDSA_SCHEME = 'ecdsa';

/** Every wait in the Arc and Miden oracles runs on this, so unit tests drive time instead of sleeping. */
export interface ArcClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realArcClock: ArcClock = {
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms))
};
```

- [ ] **Step 4: Run it and see it pass.** Same command. Expected: `Tests: 5 passed, 5 total`.

- [ ] **Step 5: Format and lint.**

```bash
npx prettier --write playwright/e2e/helpers/usdcx-constants.ts playwright/e2e/helpers/arc-usdcx.test.ts
npx eslint --max-warnings 0 playwright/e2e/helpers/usdcx-constants.ts playwright/e2e/helpers/arc-usdcx.test.ts
```

Expected: no output from eslint, exit 0.

- [ ] **Step 6: Commit deferred to Task 24 (p3-arc).**

---

### Task 20: Row readers: history projection, bridged-send rows, en copy and bridged-receive hooks (p3-row-readers)

`readTransactionRows` gains `extraInputs` (JSON-safe), `stageTimestamps`, `submitEvidence` and `resultReleasedAt`; `readBridgedSendRows` becomes that projection plus a typed `BridgedSendRow`; `enText`, `createUsdcxBridgeReceive` and `bridgeReceiveState` are added. The in-page projection becomes an exported function passed to `page.evaluate`, the pattern `installFetchInstrumentation` already uses (playwright/e2e/harness/network-capture.ts:163, run in jest by harness/fetch-instrumentation.test.ts:47 and in the worker at network-capture.ts:436), so jest runs the exact code the page runs against fake-indexeddb.

**Files:**
- Modify: `playwright/e2e/helpers/history.ts` (:74-76, :124-126, :160-239)
- Modify: `playwright/e2e/helpers/history.test.ts` (whole file)
- Modify: `playwright/e2e/helpers/bridge.ts` (:1-7, :281-305, :370-427)
- Create: `playwright/e2e/helpers/bridge.test.ts`
- Modify: `playwright/e2e/helpers/drain-progress.test.ts` (:398) - FORCED CROSS-PARTITION EDIT: this file is in no partition's list, but its test pins the old projection (it seeds `stageTimestamps: { syncing: 1 }` at :389 and expects the row without it at :398), so the new projection fails it. The edit adds the field to the expectation; the commit 9 file set gains this path.

**Interfaces:**
- Consumes: `swOf(w: ChromeWalletPageApi): Worker` (playwright/e2e/helpers/swap.ts:52), `ChromeWalletPageApi` (wallet-page.ts:209), the service-worker hooks `__TEST_CREATE_BRIDGE_RECEIVE__` and `__TEST_BRIDGE_RECEIVE_STATE__` (src/lib/miden/activity/bridge-in-test-hooks.ts:72-83, :89-101; their new fields come from p2 commit 8), `public/_locales/en/en.json` (flat `key: value`, `$name$` placeholders; `usdcxWithdrawalNotice` :6, `guardianHistoryPartial` :34).
- Produces (history.ts, contract 3.5): `type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }`; `TransactionRowSnapshot` gains `extraInputs?: { [key: string]: JsonValue }`, `stageTimestamps?: Record<string, number>`, `submitEvidence?: JsonValue[]`, `resultReleasedAt?: number`, and (only from `readTransactionRowsWithBytes`) `outputNoteIds?: string[]`, `requestBytes?: number[]`, `resultBytes?: string`; `interface TransactionRowsQuery { dbName: string; storeName: string; type?: string; withBytes?: boolean }`; `readTransactionRowsInPage(query: TransactionRowsQuery): Promise<TransactionRowSnapshot[] | null>`; `readTransactionRowsWithBytes(page: Page, type: string): Promise<TransactionRowSnapshot[]>`. `TxStatus`, `readTransactionRows(page)`, `readTransactionRowsOrNull(page)`, `readTransactionRow(page, id)`, `openHistoryDetails(wallet, rowId)` keep their signatures.
- Produces (bridge.ts, contract 3.6): `interface UsdcxBalanceSnapshotRow { balance: string; blockNumber: string }`, `interface UsdcxBurnRow`, `interface BridgedSendExtraInputsRow`, `interface BridgedSendRow` (fields exactly as contract 3.6, `extraInputs?: BridgedSendExtraInputsRow`), `readBridgedSendRows(page: Page): Promise<BridgedSendRow[]>`, `bridgedSendRowOf(row: TransactionRowSnapshot): BridgedSendRow`, `enText(key: string, values?: Record<string, string>): string`, `interface CreateUsdcxBridgeReceiveArgs { accountId: string; amount: string; faucetId: string; sourceChainId: number; sourceAddress: string; sourceAmount: string; sourceSymbol: string; evmTxHash: Hash }`, `createUsdcxBridgeReceive(wallet: ChromeWalletPageApi, args: CreateUsdcxBridgeReceiveArgs): Promise<string>`, `type BridgeReceivePhase = 'submitting' | 'delivering' | 'ready' | 'received' | 'failed'`, `type BridgeReceiveStateSnapshot` (contract 3.6 fields), `parseBridgeReceiveState(value: unknown): BridgeReceiveStateSnapshot`, `bridgeReceiveState(wallet: ChromeWalletPageApi, txId: string): Promise<BridgeReceiveStateSnapshot>`.
- `enText` is stricter than the contract on purpose: a value whose `$name$` the copy lacks throws, so `enText('usdcxMidenFees', { symbol })` cannot quietly return the old "MIDEN fees" before p2 commit 5 lands.

- [ ] **Step 1: Write the failing tests.** Replace the whole of `playwright/e2e/helpers/history.test.ts` with:

```ts
/**
 * @jest-environment node
 */
import 'fake-indexeddb/auto';

import { describeTransactionRow, readTransactionRowsInPage, TxStatus } from './history';

it('names the Unconfirmed status instead of printing its number', () => {
  expect(TxStatus.Unconfirmed).toBe(4);
  expect(describeTransactionRow({ id: 'r1', status: 4 })).toContain(' Unconfirmed ');
});

describe('readTransactionRowsInPage', () => {
  // Not TridentMain: jest.setup.js reopens that one at the wallet's real schema after every test.
  const query = { dbName: 'HistoryProjectionTest', storeName: 'transactions' };

  const seed = async (rows: Array<Record<string, unknown>>): Promise<void> => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(query.dbName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(query.storeName, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(query.storeName, 'readwrite');
      for (const row of rows) tx.objectStore(query.storeName).put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  };

  afterEach(
    () =>
      new Promise<void>(resolve => {
        const request = indexedDB.deleteDatabase(query.dbName);
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
      })
  );

  it('carries extraInputs JSON-safe: bigints as decimal strings and bytes as base64, at any depth', async () => {
    await seed([
      {
        id: 'b1',
        type: 'bridged-send',
        status: 2,
        feeAmount: 133n,
        extraInputs: {
          provider: 'usdcx',
          destinationNetwork: 5042002,
          usdcxBurn: { noteId: '0xab', destinationBalanceBefore: { balance: '0', blockNumber: '66531904' } },
          nested: [1n, new Uint8Array([1, 2, 255]), null, undefined],
          absent: undefined
        }
      }
    ]);

    const [row] = (await readTransactionRowsInPage(query)) ?? [];

    expect(row?.feeAmount).toBe('133');
    expect(row?.extraInputs).toEqual({
      provider: 'usdcx',
      destinationNetwork: 5042002,
      usdcxBurn: { noteId: '0xab', destinationBalanceBefore: { balance: '0', blockNumber: '66531904' } },
      nested: ['1', 'AQL/', null, null]
    });
  });

  it('carries stageTimestamps, submitEvidence and resultReleasedAt', async () => {
    await seed([
      {
        id: 'b1',
        type: 'bridged-send',
        stageTimestamps: { syncing: 1791663048764, 'creating-proposal': 1791663049003, broken: 'x' },
        submitEvidence: [
          { attemptId: 'a1', capturedAt: 1791663051, outputNoteIds: ['0x96', '0x4b'], verdict: undefined }
        ],
        resultReleasedAt: 1791663653
      }
    ]);

    const [row] = (await readTransactionRowsInPage(query)) ?? [];

    expect(row?.stageTimestamps).toEqual({ syncing: 1791663048764, 'creating-proposal': 1791663049003 });
    expect(row?.submitEvidence).toEqual([{ attemptId: 'a1', capturedAt: 1791663051, outputNoteIds: ['0x96', '0x4b'] }]);
    expect(row?.resultReleasedAt).toBe(1791663653);
  });

  it('leaves the byte fields out unless asked, and reads one type when asked', async () => {
    await seed([
      {
        id: 'b1',
        type: 'bridged-send',
        outputNoteIds: ['0x96'],
        requestBytes: new Uint8Array([7, 8]),
        resultBytes: new Uint8Array([0, 1, 2])
      },
      { id: 'c1', type: 'consume' }
    ]);

    const plain = (await readTransactionRowsInPage(query)) ?? [];
    const withBytes = (await readTransactionRowsInPage({ ...query, type: 'bridged-send', withBytes: true })) ?? [];

    expect(plain.map(row => [row.id, row.requestBytes, row.resultBytes, row.outputNoteIds])).toEqual([
      ['b1', undefined, undefined, undefined],
      ['c1', undefined, undefined, undefined]
    ]);
    expect(withBytes.map(row => [row.id, row.requestBytes, row.resultBytes, row.outputNoteIds])).toEqual([
      ['b1', [7, 8], 'AAEC', ['0x96']]
    ]);
  });

  it('encodes a result larger than one call can spread', async () => {
    const resultBytes = new Uint8Array(600_000).map((_, index) => index % 251);
    await seed([{ id: 'b1', type: 'bridged-send', resultBytes }]);

    const [row] = (await readTransactionRowsInPage({ ...query, withBytes: true })) ?? [];

    expect(Buffer.from(row?.resultBytes ?? '', 'base64').equals(Buffer.from(resultBytes))).toBe(true);
  });

  it('is null, not empty, when the database has no transactions store', async () => {
    await expect(readTransactionRowsInPage({ dbName: query.dbName, storeName: 'missing' })).resolves.toBeNull();
  });
});
```

Create `playwright/e2e/helpers/bridge.test.ts`:

```ts
/**
 * @jest-environment node
 */
import fs from 'fs';
import path from 'path';

import { bridgedSendRowOf, enText, parseBridgeReceiveState } from './bridge';

const EN = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../public/_locales/en/en.json'), 'utf8'));

describe('enText', () => {
  it('returns the English copy verbatim when it has no placeholder', () => {
    expect(enText('usdcxWithdrawalNotice')).toBe(EN.usdcxWithdrawalNotice);
  });

  it('replaces every placeholder it is given', () => {
    expect(enText('guardianHistoryPartial', { count: '3' })).toBe(
      String(EN.guardianHistoryPartial).split('$count$').join('3')
    );
  });

  it('throws on a key the English bundle does not have', () => {
    expect(() => enText('noSuchKeyAnywhere')).toThrow('has no "noSuchKeyAnywhere"');
  });

  it('throws when a placeholder is left unreplaced', () => {
    expect(() => enText('guardianHistoryPartial')).toThrow('still holds $count$');
  });

  it('throws on a value the copy has no placeholder for, so stale copy cannot pass', () => {
    expect(() => enText('usdcxWithdrawalNotice', { symbol: 'USDCX' })).toThrow('has no $symbol$');
  });
});

describe('bridgedSendRowOf', () => {
  const projected = {
    id: '5a249251-3b28-4100-b291-fc5396b61271',
    type: 'bridged-send',
    status: 2,
    stage: 'complete',
    stageTimestamps: { 'creating-proposal': 1791663049003, 'signing-proposal': 1791663049686 },
    displayMessage: 'USDCx burn submitted',
    transactionId: '0xdaca157101a0be401b08c153bcaa530b3644bd6bd68a613d18b203462e1e42b5',
    outputNoteIds: ['0x96711658ddfa001c82aefced0d235827cc727e297eec3fbecd15ca10265f434b'],
    requestBytes: [1, 2],
    feeAmount: '133',
    feeFaucetId: 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0_qr7qqq9wr6w',
    completedAt: 1791663053,
    resultBytes: 'AAEC',
    submitEvidence: [{ attemptId: '5826a0ee', source: 'pin' }],
    extraInputs: {
      provider: 'usdcx',
      destinationAddress: '0x405b05F75F8D299FCd413a3d77F89EDDCBa78026',
      destinationNetwork: 5042002,
      sourceFaucetId: 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0_qr7qqq9wr6w',
      claimStatus: 'not-applicable',
      usdcxBurn: {
        noteId: '0x96711658ddfa001c82aefced0d235827cc727e297eec3fbecd15ca10265f434b',
        destinationDomain: 26,
        phase: 'confirmed',
        attemptCount: 0,
        destinationBalanceBefore: { balance: '0', blockNumber: '66531904' },
        destinationBalanceConfirmed: { balance: '9983600', blockNumber: '66531958' }
      }
    }
  };

  it('types a USDCx burn row field by field, including both destination balances', () => {
    expect(bridgedSendRowOf(projected)).toEqual({
      id: '5a249251-3b28-4100-b291-fc5396b61271',
      status: 2,
      stage: 'complete',
      stageTimestamps: { 'creating-proposal': 1791663049003, 'signing-proposal': 1791663049686 },
      displayMessage: 'USDCx burn submitted',
      transactionId: '0xdaca157101a0be401b08c153bcaa530b3644bd6bd68a613d18b203462e1e42b5',
      outputNoteIds: ['0x96711658ddfa001c82aefced0d235827cc727e297eec3fbecd15ca10265f434b'],
      requestBytes: [1, 2],
      feeAmount: '133',
      feeFaucetId: 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0_qr7qqq9wr6w',
      completedAt: 1791663053,
      resultBytes: 'AAEC',
      submitEvidence: [{ attemptId: '5826a0ee', source: 'pin' }],
      extraInputs: {
        provider: 'usdcx',
        destinationAddress: '0x405b05F75F8D299FCd413a3d77F89EDDCBa78026',
        destinationNetwork: 5042002,
        claimStatus: 'not-applicable',
        usdcxBurn: {
          noteId: '0x96711658ddfa001c82aefced0d235827cc727e297eec3fbecd15ca10265f434b',
          destinationDomain: 26,
          phase: 'confirmed',
          attemptCount: 0,
          destinationBalanceBefore: { balance: '0', blockNumber: '66531904' },
          destinationBalanceConfirmed: { balance: '9983600', blockNumber: '66531958' }
        }
      }
    });
  });

  it('drops a usdcxBurn that lacks its note id, domain or phase rather than half-typing it', () => {
    const row = bridgedSendRowOf({ ...projected, extraInputs: { provider: 'usdcx', usdcxBurn: { noteId: '0x96' } } });
    expect(row.extraInputs?.usdcxBurn).toBeUndefined();
    expect(row.extraInputs?.provider).toBe('usdcx');
  });

  it('reads a row with no status as -1, as the old reader did', () => {
    expect(bridgedSendRowOf({ id: 'r1' }).status).toBe(-1);
    expect(bridgedSendRowOf({ id: 'r1' }).extraInputs).toBeUndefined();
  });
});

describe('parseBridgeReceiveState', () => {
  it('keeps every field the hook returns, typed', () => {
    expect(
      parseBridgeReceiveState({
        found: true,
        phase: 'failed',
        displayMessage: 'Bridged from EVM',
        status: 3,
        amount: '2000000000',
        faucetId: 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0_qr7qqq9wr6w',
        evmTxHash: '0x370bf19aefa34f6f07d7b731d5b5f323a364c6f4116a22768d4e44a16ffeca4d',
        error: 'Circle attested this deposit to a different Miden account.',
        midenNoteId: '0xbf20',
        sourceChainId: 5042002,
        usdcxRemoteRecipient: '0x000000000000000000000000000000008da911727d5b53916f2c221c00c09100',
        readyAt: 1791663100
      })
    ).toEqual({
      found: true,
      phase: 'failed',
      displayMessage: 'Bridged from EVM',
      status: 3,
      amount: '2000000000',
      faucetId: 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0_qr7qqq9wr6w',
      evmTxHash: '0x370bf19aefa34f6f07d7b731d5b5f323a364c6f4116a22768d4e44a16ffeca4d',
      error: 'Circle attested this deposit to a different Miden account.',
      midenNoteId: '0xbf20',
      sourceChainId: 5042002,
      usdcxRemoteRecipient: '0x000000000000000000000000000000008da911727d5b53916f2c221c00c09100',
      readyAt: 1791663100
    });
  });

  it('reads a missing row as not found', () => {
    expect(parseBridgeReceiveState({ found: false })).toEqual({ found: false });
  });

  it('refuses a phase the wallet does not have', () => {
    expect(() => parseBridgeReceiveState({ found: true, phase: 'settled' })).toThrow('unknown phase "settled"');
  });

  it('refuses an answer that is not a state object', () => {
    expect(() => parseBridgeReceiveState(null)).toThrow('not a state object');
  });
});
```

In `playwright/e2e/helpers/drain-progress.test.ts:398`, before:

```ts
        { id: 'q1', status: 0, type: 'send', amount: '5' }
```

after:

```ts
        { id: 'q1', status: 0, type: 'send', amount: '5', stageTimestamps: { syncing: 1 } }
```

Mutation notes:
- history "carries extraInputs JSON-safe ...": make `toJson`'s `case 'bigint'` return `undefined`; `nested[0]` reads `null` and `toEqual` fails.
- history "carries stageTimestamps, submitEvidence and resultReleasedAt": project `stageTimestamps: row.stageTimestamps` raw; `broken: 'x'` survives and `toEqual` fails.
- history "leaves the byte fields out unless asked ...": drop the `if (query.withBytes)` guard; the plain read's b1 carries `[7, 8]` and the first `toEqual` fails.
- history "encodes a result larger than one call can spread": replace the chunk loop with one `String.fromCharCode(...bytes)`; it throws `RangeError: Maximum call stack size exceeded`.
- history "is null, not empty, when the database has no transactions store": return `[]` for a missing store; `toBeNull` fails.
- drain-progress "streams the rows ..." (edited expectation): drop `stageTimestamps: numbers(row.stageTimestamps)` from the projection; the q1 row loses the field and `toEqual` fails.
- enText "returns the English copy verbatim ...": return `key`; `toBe` fails.
- enText "replaces every placeholder it is given": skip the `split/join`; the copy keeps `$count$` and the unreplaced check throws.
- enText "throws on a key the English bundle does not have": return `''` for a missing key; `toThrow` fails.
- enText "throws when a placeholder is left unreplaced": delete the `unreplaced` check; `toThrow` fails.
- enText "throws on a value the copy has no placeholder for ...": delete the `template.includes(placeholder)` check; `toThrow` fails.
- bridgedSendRowOf "types a USDCx burn row ...": drop the `destinationBalanceConfirmed` line of `usdcxBurnOf`; `toEqual` fails.
- bridgedSendRowOf "drops a usdcxBurn that lacks ...": delete the `noteId === undefined || ...` guard; `toBeUndefined` fails.
- bridgedSendRowOf "reads a row with no status as -1 ...": map `status: row.status ?? 0`; `toBe(-1)` fails.
- parseBridgeReceiveState "keeps every field ...": drop the `readyAt` line; `toEqual` fails.
- parseBridgeReceiveState "reads a missing row as not found": throw when `phase` is undefined; the call throws.
- parseBridgeReceiveState "refuses a phase the wallet does not have": delete the `isBridgeReceivePhase` check; `toThrow` fails.
- parseBridgeReceiveState "refuses an answer that is not a state object": delete the first guard; `Reflect.get(null)` throws a TypeError whose text lacks `not a state object`.

- [ ] **Step 2: Run them and see them fail.**

```bash
yarn jest playwright/e2e/helpers/history.test.ts playwright/e2e/helpers/bridge.test.ts playwright/e2e/helpers/drain-progress.test.ts --maxWorkers=2
```

Expected: 5 history tests fail with `TypeError: (0 , _history.readTransactionRowsInPage) is not a function`; every bridge.test.ts test fails with `TypeError: (0 , _bridge.enText) is not a function`, `(0 , _bridge.bridgedSendRowOf) is not a function` or `(0 , _bridge.parseBridgeReceiveState) is not a function`; drain-progress "streams the rows, so readTransactionRows reads them projected and in key order without getAll" fails on the missing `stageTimestamps`.

- [ ] **Step 3: Implement history.ts.** Edit 1, `playwright/e2e/helpers/history.ts:74-76`, before:

```ts
/** The Dexie database + store the wallet keeps its transaction rows in (src/lib/miden/repo.ts). */
const TX_DB = 'TridentMain';
const TX_STORE = 'transactions';
```

after:

```ts
/** The Dexie database + store the wallet keeps its transaction rows in (src/lib/miden/repo.ts). */
const TX_DB = 'TridentMain';
const TX_STORE = 'transactions';

/** What a row's free-form fields become once they cross the evaluate boundary. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
```

Edit 2, `history.ts:124-126` (the end of `TransactionRowSnapshot`), before:

```ts
  /** Set on the everyday-key rotation gate's own funding claim (#805). */
  rotationFunding?: boolean;
}
```

after:

```ts
  /** Set on the everyday-key rotation gate's own funding claim (#805). */
  rotationFunding?: boolean;
  /** bigints as decimal strings, Uint8Array as base64, recursively. */
  extraInputs?: { [key: string]: JsonValue };
  /** Wall-clock ms of each stage's first entry in the current attempt; a requeue clears it. */
  stageTimestamps?: Record<string, number>;
  /** One entry per attempt that may have crossed its submit (#1081), JSON-safe like `extraInputs`. */
  submitEvidence?: JsonValue[];
  /** Unix seconds at which the reaper released `resultBytes`; a Completed row without either took a landed path. */
  resultReleasedAt?: number;
  /** Only from {@link readTransactionRowsWithBytes}: the row's output note ids. */
  outputNoteIds?: string[];
  /** Only from {@link readTransactionRowsWithBytes}: the queued request, as plain numbers. */
  requestBytes?: number[];
  /** Only from {@link readTransactionRowsWithBytes}: the serialized `TransactionResult`, base64. */
  resultBytes?: string;
}

/** Which rows {@link readTransactionRowsInPage} reads, and whether it carries their byte fields. */
export interface TransactionRowsQuery {
  dbName: string;
  storeName: string;
  type?: string;
  withBytes?: boolean;
}
```

Edit 3, `history.ts:160-239` (origin/main numbering; Edits 1 and 2 move it down), from the `/**` that opens `streamTransactionRows` through its closing `}`, current text:

```ts
/**
 * The in-page read behind {@link readTransactionRows} and {@link readTransactionRowsOrNull}: every row, projected, in
 * key order, or `null` when the database has no transactions store (`open` creates an empty database when none
 * exists, so a missing store is told apart from an empty one). A cursor, not `getAll`, for the reason
 * `unlandedSendTotals` gives: rows carry request and result bytes, and a claim drain reads them every lap, on both
 * wallets at once in the stress drain. Rejects on a failed read.
 */
function streamTransactionRows(page: Page): Promise<TransactionRowSnapshot[] | null> {
  return page.evaluate(
    async ({ dbName, storeName }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        // A blocked open can still succeed later; close that late connection rather than leak it.
        let settled = false;
        request.onsuccess = () => {
          if (settled) {
            request.result.close();
            return;
          }
          settled = true;
          resolve(request.result);
        };
        request.onerror = () => {
          settled = true;
          reject(request.error ?? new Error('readTransactionRows: open failed'));
        };
        request.onblocked = () => {
          settled = true;
          reject(new Error('readTransactionRows: open blocked'));
        };
      });
      try {
        if (!db.objectStoreNames.contains(storeName)) return null;
        return await new Promise<TransactionRowSnapshot[]>((resolve, reject) => {
          const rows: TransactionRowSnapshot[] = [];
          const tx = db.transaction(storeName, 'readonly');
          tx.onabort = () => reject(tx.error ?? new Error('readTransactionRows: transaction aborted'));
          tx.onerror = () => reject(tx.error ?? new Error('readTransactionRows: transaction failed'));
          const cursorRequest = tx.objectStore(storeName).openCursor();
          cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('readTransactionRows: cursor failed'));
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) {
              resolve(rows);
              return;
            }
            const row: Record<string, unknown> = cursor.value;
            rows.push({
              id: String(row.id ?? ''),
              type: row.type === undefined ? undefined : String(row.type),
              accountId: row.accountId === undefined ? undefined : String(row.accountId),
              noteId: row.noteId === undefined ? undefined : String(row.noteId),
              noteIds: Array.isArray(row.noteIds) ? row.noteIds.map(String) : undefined,
              status: row.status === undefined ? undefined : Number(row.status),
              amount: row.amount === undefined || row.amount === null ? undefined : String(row.amount),
              faucetId: row.faucetId === undefined ? undefined : String(row.faucetId),
              secondaryAccountId: row.secondaryAccountId === undefined ? undefined : String(row.secondaryAccountId),
              transactionId: row.transactionId === undefined ? undefined : String(row.transactionId),
              processingStartedAt: row.processingStartedAt === undefined ? undefined : Number(row.processingStartedAt),
              stage: row.stage === undefined ? undefined : String(row.stage),
              nextEligibleAt: row.nextEligibleAt === undefined ? undefined : Number(row.nextEligibleAt),
              error: row.error === undefined ? undefined : String(row.error),
              rawError: row.rawError === undefined ? undefined : String(row.rawError),
              // Stringified like `amount`: a bigint cannot cross the evaluate boundary.
              feeAmount: row.feeAmount === undefined || row.feeAmount === null ? undefined : String(row.feeAmount),
              feeFaucetId: row.feeFaucetId === undefined ? undefined : String(row.feeFaucetId),
              displayMessage: row.displayMessage === undefined ? undefined : String(row.displayMessage),
              completedAt: row.completedAt === undefined ? undefined : Number(row.completedAt),
              rotationFunding: row.rotationFunding === true ? true : undefined
            });
            cursor.continue();
          };
        });
      } finally {
        db.close();
      }
    },
    { dbName: TX_DB, storeName: TX_STORE }
  );
}
```

becomes:

```ts
/**
 * The in-page read behind {@link readTransactionRows} and {@link readTransactionRowsOrNull}: every row, projected, in
 * key order, or `null` when the database has no transactions store (`open` creates an empty database when none
 * exists, so a missing store is told apart from an empty one). A cursor, not `getAll`, for the reason
 * `unlandedSendTotals` gives: rows carry request and result bytes, and a claim drain reads them every lap, on both
 * wallets at once in the stress drain. Rejects on a failed read.
 */
function streamTransactionRows(page: Page): Promise<TransactionRowSnapshot[] | null> {
  return page.evaluate(readTransactionRowsInPage, { dbName: TX_DB, storeName: TX_STORE });
}

/**
 * Rows of one `type` with their byte fields (`outputNoteIds`, `requestBytes`, `resultBytes`), for a reader that needs
 * the queued request or the result, such as `readBridgedSendRows`. `[]` when there is no transactions store.
 */
export async function readTransactionRowsWithBytes(page: Page, type: string): Promise<TransactionRowSnapshot[]> {
  return (
    (await page.evaluate(readTransactionRowsInPage, { dbName: TX_DB, storeName: TX_STORE, type, withBytes: true })) ??
    []
  );
}

/**
 * The projection itself, run inside the page by `page.evaluate`, so it closes over nothing: every helper it needs is
 * declared in its body. Exported for the unit test, which runs it against fake-indexeddb.
 */
export async function readTransactionRowsInPage(query: TransactionRowsQuery): Promise<TransactionRowSnapshot[] | null> {
  // By tag, not instanceof: the unit test's IndexedDB clones through another realm's Uint8Array.
  const isBytes = (value: unknown): value is Uint8Array =>
    Object.prototype.toString.call(value) === '[object Uint8Array]';
  const base64 = (bytes: Uint8Array): string => {
    let binary = '';
    // Chunked: one spread of a 300 KB result would overflow the argument limit.
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  };
  const toJson = (value: unknown): JsonValue | undefined => {
    if (value === null) return null;
    switch (typeof value) {
      case 'string':
      case 'boolean':
        return value;
      case 'number':
        return Number.isFinite(value) ? value : String(value);
      case 'bigint':
        return value.toString();
      case 'object':
        break;
      default:
        return undefined;
    }
    if (isBytes(value)) return base64(value);
    if (Array.isArray(value)) return value.map(item => toJson(item) ?? null);
    const out: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) {
      const json = toJson(item);
      if (json !== undefined) out[key] = json;
    }
    return out;
  };
  const jsonObject = (value: unknown): { [key: string]: JsonValue } | undefined => {
    const json = toJson(value);
    return json !== null && typeof json === 'object' && !Array.isArray(json) ? json : undefined;
  };
  const numbers = (value: unknown): Record<string, number> | undefined => {
    if (value === null || typeof value !== 'object') return undefined;
    const out: Record<string, number> = {};
    for (const [key, item] of Object.entries(value)) if (typeof item === 'number') out[key] = item;
    return out;
  };

  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(query.dbName);
    // A blocked open can still succeed later; close that late connection rather than leak it.
    let settled = false;
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      resolve(request.result);
    };
    request.onerror = () => {
      settled = true;
      reject(request.error ?? new Error('readTransactionRows: open failed'));
    };
    request.onblocked = () => {
      settled = true;
      reject(new Error('readTransactionRows: open blocked'));
    };
  });
  try {
    if (!db.objectStoreNames.contains(query.storeName)) return null;
    return await new Promise<TransactionRowSnapshot[]>((resolve, reject) => {
      const rows: TransactionRowSnapshot[] = [];
      const tx = db.transaction(query.storeName, 'readonly');
      tx.onabort = () => reject(tx.error ?? new Error('readTransactionRows: transaction aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('readTransactionRows: transaction failed'));
      const cursorRequest = tx.objectStore(query.storeName).openCursor();
      cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('readTransactionRows: cursor failed'));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          resolve(rows);
          return;
        }
        const row: Record<string, unknown> = cursor.value;
        if (query.type !== undefined && row.type !== query.type) {
          cursor.continue();
          return;
        }
        const snapshot: TransactionRowSnapshot = {
          id: String(row.id ?? ''),
          type: row.type === undefined ? undefined : String(row.type),
          accountId: row.accountId === undefined ? undefined : String(row.accountId),
          noteId: row.noteId === undefined ? undefined : String(row.noteId),
          noteIds: Array.isArray(row.noteIds) ? row.noteIds.map(String) : undefined,
          status: row.status === undefined ? undefined : Number(row.status),
          amount: row.amount === undefined || row.amount === null ? undefined : String(row.amount),
          faucetId: row.faucetId === undefined ? undefined : String(row.faucetId),
          secondaryAccountId: row.secondaryAccountId === undefined ? undefined : String(row.secondaryAccountId),
          transactionId: row.transactionId === undefined ? undefined : String(row.transactionId),
          processingStartedAt: row.processingStartedAt === undefined ? undefined : Number(row.processingStartedAt),
          stage: row.stage === undefined ? undefined : String(row.stage),
          nextEligibleAt: row.nextEligibleAt === undefined ? undefined : Number(row.nextEligibleAt),
          error: row.error === undefined ? undefined : String(row.error),
          rawError: row.rawError === undefined ? undefined : String(row.rawError),
          // Stringified like `amount`: a bigint cannot cross the evaluate boundary.
          feeAmount: row.feeAmount === undefined || row.feeAmount === null ? undefined : String(row.feeAmount),
          feeFaucetId: row.feeFaucetId === undefined ? undefined : String(row.feeFaucetId),
          displayMessage: row.displayMessage === undefined ? undefined : String(row.displayMessage),
          completedAt: row.completedAt === undefined ? undefined : Number(row.completedAt),
          rotationFunding: row.rotationFunding === true ? true : undefined,
          extraInputs: jsonObject(row.extraInputs),
          stageTimestamps: numbers(row.stageTimestamps),
          submitEvidence: Array.isArray(row.submitEvidence)
            ? row.submitEvidence.map(entry => toJson(entry) ?? null)
            : undefined,
          resultReleasedAt: typeof row.resultReleasedAt === 'number' ? row.resultReleasedAt : undefined
        };
        if (query.withBytes) {
          snapshot.outputNoteIds = Array.isArray(row.outputNoteIds) ? row.outputNoteIds.map(String) : undefined;
          snapshot.requestBytes = isBytes(row.requestBytes) ? Array.from(row.requestBytes) : undefined;
          snapshot.resultBytes = isBytes(row.resultBytes) ? base64(row.resultBytes) : undefined;
        }
        rows.push(snapshot);
        cursor.continue();
      };
    });
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: Implement bridge.ts.** Edit 1, `playwright/e2e/helpers/bridge.ts:1-7`, before:

```ts
import { expect, type Page } from '@playwright/test';

import { captureEpochTraffic, fastFeeExpectation, waitForFastQuote } from './epoch-quote';
import type { MidenCli } from './miden-cli';
import { swOf } from './swap';
import type { ChromeWalletPageApi } from './wallet-page';
import type { TimelineRecorder } from '../harness/timeline-recorder';
```

after:

```ts
import { expect, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import type { Hash } from 'viem';

import { captureEpochTraffic, fastFeeExpectation, waitForFastQuote } from './epoch-quote';
import { readTransactionRowsWithBytes, type JsonValue, type TransactionRowSnapshot } from './history';
import type { MidenCli } from './miden-cli';
import { swOf } from './swap';
import type { ChromeWalletPageApi } from './wallet-page';
import type { TimelineRecorder } from '../harness/timeline-recorder';
```

Edit 2, replace `bridge.ts:281-305` (`export interface BridgedSendRow { ... }`) with:

```ts
/** A destination USDC balance a USDCx burn row saved, six-decimal base units and the block it was read at. */
export interface UsdcxBalanceSnapshotRow {
  balance: string;
  blockNumber: string;
}

export interface UsdcxBurnRow {
  noteId: string;
  destinationDomain: number;
  /** 'pending' | 'consuming' | 'confirmed' | 'discarded'. */
  phase: string;
  lastError?: string;
  /** Read before the burn was queued (usdcx/burn.ts). */
  destinationBalanceBefore?: UsdcxBalanceSnapshotRow;
  /** The balance that met the expected payout: the wallet's own destination confirmation. */
  destinationBalanceConfirmed?: UsdcxBalanceSnapshotRow;
  attemptCount?: number;
  lastAttemptBlockNum?: number;
}

export interface BridgedSendExtraInputsRow {
  usdcxBurn?: UsdcxBurnRow;
  /** The 0x recipient. */
  destinationAddress?: string;
  /** The destination's EVM chain id (or the L1 bridge's network id for agglayer). */
  destinationNetwork?: number;
  intentNonce?: string;
  outputAmount?: string;
  evmTxHash?: string;
  /** 'agglayer' (Slow) | 'epoch' (Fast) | 'usdcx'. */
  provider?: string;
  /** AggLayer L1 claim lifecycle: 'pending' | 'ready' | 'claimed'. */
  claimStatus?: string;
  /** AggLayer: the indexer tx_hash of the row's exit, stored when the B2AGG note is built. */
  agglayerExitTxHash?: string;
}

export interface BridgedSendRow {
  /** The Dexie row id, the `:txId` of the generating and history-details routes. */
  id: string;
  /** ITransactionStatus: Queued=0, GeneratingTransaction=1, Completed=2, Failed=3, Unconfirmed=4. */
  status: number;
  stage?: string;
  /** Wall-clock ms of each stage's first entry in the current attempt. */
  stageTimestamps?: Record<string, number>;
  /** User-facing failure reason on a Failed row. */
  error?: string;
  /** The underlying failure, before any friendly rewrite -- the one worth reading. */
  rawError?: string;
  displayMessage?: string;
  transactionId?: string;
  outputNoteIds?: string[];
  /** The request the row was queued with, as plain numbers: `page.evaluate` hands back JSON-safe values only. */
  requestBytes?: number[];
  /** Fee paid, base units as a decimal string; absent on a landed path, which records no fee. */
  feeAmount?: string;
  feeFaucetId?: string;
  completedAt?: number;
  /** The serialized `TransactionResult`, base64. The reaper releases it 10 min after `completedAt`. */
  resultBytes?: string;
  resultReleasedAt?: number;
  submitEvidence?: JsonValue[];
  extraInputs?: BridgedSendExtraInputsRow;
}
```

Edit 3, replace `bridge.ts:370-427` (the `readBridgedSendRows` docblock and function, to the end of the file) with:

```ts
/**
 * All `bridged-send` rows in the wallet's Dexie `transactions` store, syncing
 * nothing (a pure read of already-persisted rows). A fresh wallet that has done
 * one bridge has exactly one. The read is history.ts's projection, so the
 * row's bigints and bytes arrive JSON-safe.
 */
export async function readBridgedSendRows(page: Page): Promise<BridgedSendRow[]> {
  return (await readTransactionRowsWithBytes(page, 'bridged-send')).map(bridgedSendRowOf);
}

type JsonObject = { [key: string]: JsonValue };

function objectField(source: JsonObject | undefined, key: string): JsonObject | undefined {
  const value = source?.[key];
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function stringField(source: JsonObject | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(source: JsonObject | undefined, key: string): number | undefined {
  const value = source?.[key];
  return typeof value === 'number' ? value : undefined;
}

function balanceSnapshotOf(source: JsonObject | undefined): UsdcxBalanceSnapshotRow | undefined {
  const balance = stringField(source, 'balance');
  const blockNumber = stringField(source, 'blockNumber');
  return balance !== undefined && blockNumber !== undefined ? { balance, blockNumber } : undefined;
}

function usdcxBurnOf(source: JsonObject | undefined): UsdcxBurnRow | undefined {
  const noteId = stringField(source, 'noteId');
  const destinationDomain = numberField(source, 'destinationDomain');
  const phase = stringField(source, 'phase');
  if (noteId === undefined || destinationDomain === undefined || phase === undefined) return undefined;
  return {
    noteId,
    destinationDomain,
    phase,
    lastError: stringField(source, 'lastError'),
    destinationBalanceBefore: balanceSnapshotOf(objectField(source, 'destinationBalanceBefore')),
    destinationBalanceConfirmed: balanceSnapshotOf(objectField(source, 'destinationBalanceConfirmed')),
    attemptCount: numberField(source, 'attemptCount'),
    lastAttemptBlockNum: numberField(source, 'lastAttemptBlockNum')
  };
}

/** One projected transaction row as a `BridgedSendRow`, keeping only the `extraInputs` fields the type names. */
export function bridgedSendRowOf(row: TransactionRowSnapshot): BridgedSendRow {
  const extra = row.extraInputs;
  return {
    id: row.id,
    status: row.status ?? -1,
    stage: row.stage,
    stageTimestamps: row.stageTimestamps,
    error: row.error,
    rawError: row.rawError,
    displayMessage: row.displayMessage,
    transactionId: row.transactionId,
    outputNoteIds: row.outputNoteIds,
    requestBytes: row.requestBytes,
    feeAmount: row.feeAmount,
    feeFaucetId: row.feeFaucetId,
    completedAt: row.completedAt,
    resultBytes: row.resultBytes,
    resultReleasedAt: row.resultReleasedAt,
    submitEvidence: row.submitEvidence,
    extraInputs:
      extra === undefined
        ? undefined
        : {
            usdcxBurn: usdcxBurnOf(objectField(extra, 'usdcxBurn')),
            destinationAddress: stringField(extra, 'destinationAddress'),
            destinationNetwork: numberField(extra, 'destinationNetwork'),
            intentNonce: stringField(extra, 'intentNonce'),
            outputAmount: stringField(extra, 'outputAmount'),
            evmTxHash: stringField(extra, 'evmTxHash'),
            provider: stringField(extra, 'provider'),
            claimStatus: stringField(extra, 'claimStatus'),
            agglayerExitTxHash: stringField(extra, 'agglayerExitTxHash')
          }
  };
}

const EN_LOCALE_PATH = path.resolve(__dirname, '../../../public/_locales/en/en.json');
let enMessages: Record<string, unknown> | undefined;

function readEnMessages(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fs.readFileSync(EN_LOCALE_PATH, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`enText: ${EN_LOCALE_PATH} is not a flat JSON object`);
  }
  return Object.fromEntries(Object.entries(parsed));
}

/**
 * The English copy of `key` (public/_locales/en/en.json) with each `$name$` replaced by `values[name]`. Throws on a
 * missing key, on a value whose placeholder the copy does not have (an assertion built on it would pass against
 * stale copy), and on a placeholder left unreplaced.
 */
export function enText(key: string, values: Record<string, string> = {}): string {
  enMessages ??= readEnMessages();
  const template = enMessages[key];
  if (typeof template !== 'string') throw new Error(`enText: public/_locales/en/en.json has no "${key}"`);
  let text = template;
  for (const [name, value] of Object.entries(values)) {
    const placeholder = `$${name}$`;
    if (!template.includes(placeholder)) {
      throw new Error(`enText: "${key}" has no ${placeholder}; its English copy is ${JSON.stringify(template)}`);
    }
    text = text.split(placeholder).join(value);
  }
  const unreplaced = /\$[A-Za-z0-9_.]+\$/.exec(text);
  if (unreplaced) throw new Error(`enText: "${key}" still holds ${unreplaced[0]}; pass a value for it`);
  return text;
}

export interface CreateUsdcxBridgeReceiveArgs {
  accountId: string;
  /** Base units, as a decimal string. */
  amount: string;
  faucetId: string;
  sourceChainId: number;
  sourceAddress: string;
  sourceAmount: string;
  sourceSymbol: string;
  evmTxHash: Hash;
}

/**
 * A `usdcx` bridged-receive tracking row through the service worker's `__TEST_CREATE_BRIDGE_RECEIVE__`, which moves it
 * to `delivering` with `evmTxHash` as the deposit screen does. Returns the row id.
 */
export async function createUsdcxBridgeReceive(wallet: Wallet, args: CreateUsdcxBridgeReceiveArgs): Promise<string> {
  const id: unknown = await swOf(wallet).evaluate(async hookArgs => {
    const hook: unknown = Reflect.get(globalThis, '__TEST_CREATE_BRIDGE_RECEIVE__');
    if (typeof hook !== 'function') {
      throw new Error('__TEST_CREATE_BRIDGE_RECEIVE__ is missing: the wallet was not built with MIDEN_E2E_TEST=true');
    }
    return hook({ ...hookArgs, provider: 'usdcx' });
  }, args);
  if (typeof id !== 'string' || id === '') {
    throw new Error(`__TEST_CREATE_BRIDGE_RECEIVE__ returned ${JSON.stringify(id)}, not a row id`);
  }
  return id;
}

export type BridgeReceivePhase = 'submitting' | 'delivering' | 'ready' | 'received' | 'failed';

export type BridgeReceiveStateSnapshot = {
  found: boolean;
  phase?: BridgeReceivePhase;
  displayMessage?: string;
  status?: number;
  amount?: string;
  faucetId?: string;
  evmTxHash?: string;
  error?: string;
  midenNoteId?: string;
  sourceChainId?: number;
  usdcxRemoteRecipient?: string;
  /** Unix seconds the row first reached `ready`. */
  readyAt?: number;
};

function isBridgeReceivePhase(value: unknown): value is BridgeReceivePhase {
  return (
    value === 'submitting' || value === 'delivering' || value === 'ready' || value === 'received' || value === 'failed'
  );
}

/** `__TEST_BRIDGE_RECEIVE_STATE__`'s answer, checked field by field, so a renamed hook field fails here by name. */
export function parseBridgeReceiveState(value: unknown): BridgeReceiveStateSnapshot {
  if (value === null || typeof value !== 'object') {
    throw new Error(`__TEST_BRIDGE_RECEIVE_STATE__ returned ${JSON.stringify(value)}, not a state object`);
  }
  const field = (key: string): unknown => Reflect.get(value, key);
  const text = (key: string): string | undefined => {
    const item = field(key);
    return typeof item === 'string' ? item : undefined;
  };
  const count = (key: string): number | undefined => {
    const item = field(key);
    return typeof item === 'number' ? item : undefined;
  };
  const found = field('found');
  if (typeof found !== 'boolean') throw new Error('__TEST_BRIDGE_RECEIVE_STATE__ has no boolean found');
  const phase = field('phase');
  if (phase !== undefined && !isBridgeReceivePhase(phase)) {
    throw new Error(`__TEST_BRIDGE_RECEIVE_STATE__ returned an unknown phase ${JSON.stringify(phase)}`);
  }
  return {
    found,
    phase,
    displayMessage: text('displayMessage'),
    status: count('status'),
    amount: text('amount'),
    faucetId: text('faucetId'),
    evmTxHash: text('evmTxHash'),
    error: text('error'),
    midenNoteId: text('midenNoteId'),
    sourceChainId: count('sourceChainId'),
    usdcxRemoteRecipient: text('usdcxRemoteRecipient'),
    readyAt: count('readyAt')
  };
}

/** One bridged-receive row through the service worker's `__TEST_BRIDGE_RECEIVE_STATE__`. */
export async function bridgeReceiveState(wallet: Wallet, txId: string): Promise<BridgeReceiveStateSnapshot> {
  const state: unknown = await swOf(wallet).evaluate(async id => {
    const hook: unknown = Reflect.get(globalThis, '__TEST_BRIDGE_RECEIVE_STATE__');
    if (typeof hook !== 'function') {
      throw new Error('__TEST_BRIDGE_RECEIVE_STATE__ is missing: the wallet was not built with MIDEN_E2E_TEST=true');
    }
    return hook(id);
  }, txId);
  return parseBridgeReceiveState(state);
}
```

- [ ] **Step 5: Run them and see them pass.** Same command as Step 2. Expected: `Tests: 59 passed, 59 total` (history 6, bridge 12, drain-progress 41). Then the whole directory, since balance-truth.ts, swap.ts, wallet-page.ts, drain-progress.ts and dapp-assertions.ts import history.ts:

```bash
yarn jest playwright/e2e/helpers --maxWorkers=2
```

Expected: every suite passes.

- [ ] **Step 6: Format and lint.**

```bash
npx prettier --write playwright/e2e/helpers/history.ts playwright/e2e/helpers/history.test.ts playwright/e2e/helpers/bridge.ts playwright/e2e/helpers/bridge.test.ts playwright/e2e/helpers/drain-progress.test.ts
npx eslint --max-warnings 0 playwright/e2e/helpers/history.ts playwright/e2e/helpers/history.test.ts playwright/e2e/helpers/bridge.ts playwright/e2e/helpers/bridge.test.ts playwright/e2e/helpers/drain-progress.test.ts
```

Expected: eslint exit 0.

- [ ] **Step 7: Commit deferred to Task 24 (p3-arc).**

---

### Task 21: bridgeOutUsdcx and readNativeDisplaySymbol, the Send UI burn driver (p3-bridge-out-usdcx)

Spec 5 step 6 as one helper. Its pure parts (chip set, review URL, Arc-snapshot classification) and the store read are unit-tested; the UI path itself runs in the live `usdcx` and `usdcx-burn` suites (p5).

It depends on Task 13 (commit 5: `usdcxMidenFees` and `usdcxSponsorshipFee` carry `$symbol$`) and Task 18 (commit 8: the `usdcx-burn-notice` test ids): before those land, `enText` throws on the old copy and the notice locator times out, by design. `readNativeDisplaySymbol` reads the symbol the store gives the current account's native balance row (`getNativeDisplayMetadataSync`); the labels of Task 13 resolve the same native metadata through `resolveDisplayMetadata(nativeFaucetId ?? undefined, assetsMetadata, nativeFaucetId)`, so the comparison is made against one source once discovery has landed, which `resolveUsdcxIds` (Task 26) waits for before any burn.

**Files:**
- Modify: `playwright/e2e/helpers/bridge.ts` (append at the end)
- Modify: `playwright/e2e/helpers/bridge.test.ts` (imports :1-7, append at the end)

**Interfaces:**
- Consumes: from the previous task `readBridgedSendRows`, `enText`; `STEP_TIMEOUT_MS` (bridge.ts:164 on origin/main, 30_000); the store `window.__TEST_STORE__` (`currentAccount.publicKey`, `balances[publicKey][].{tokenId, metadata.symbol}`, read the same way as `currentAccountRows`, balance-truth.ts:360-383); the DOM ids of contract 2.3 (`send-flow`, `send-recipient-input`, `send-network-<id>` with `aria-pressed`, `send-network-options`, `send-recipient-confirm`, `send-amount-input`, `send-amount-confirm`, `bridge-route-usdcx`, `bridge-route-confirm`, `usdcx-burn-notice` (new, p2 commit 8), `send-review-submit`, `review-error`); the review's `DetailRow` markup (src/components/ui/DetailCard.tsx:29-65: a label `span` beside a value `div`), labels `enText('network')` = "Network" (@main en.json:1004) and `enText('networkFee')` = "Network Fee" (@main en.json:736); copy `usdcxMidenFees` (en.json:4), `usdcxSponsorshipFee` (:17), `usdcxWithdrawalNotice` (:6), each with `$symbol$` after p2 commit 5 where the contract says so.
- Produces: `readNativeDisplaySymbol(page: Page, nativeTokenId: string): Promise<string>`; `USDCX_DESTINATION_CHIPS: readonly string[]`; `interface NetworkChipState { testId: string; pressed: string | null }`; `usdcxChipsProblem(chips: readonly NetworkChipState[], selected: string): string | undefined`; `reviewQueryParam(url: string, name: string): string | null`; `isArcSnapshotFailure(reviewError: string, newUsdcxRows: number): boolean`; `interface BridgeOutUsdcxOptions` and `interface BridgeOutUsdcxResult` (contract 3.6); `bridgeOutUsdcx(wallet: ChromeWalletPageApi, opts: BridgeOutUsdcxOptions): Promise<BridgeOutUsdcxResult>`.
- Spike v2 on main confirms the flow this drives: before and after the Arc click the page held exactly `send-network-arc-testnet` (pressed `true`), `-sepolia`, `-arbitrum-sepolia`, `-base-sepolia` (all `false`); the review URL was `#/send/review?amount=10&to=<key>&tokenId=<composite native>&network=arc-testnet&route=usdcx`; the review rows read "Network / Arc Testnet" and "Network Fee / Paid in MIDEN, including sponsorship of the execution by the faucet" (the copy p2 commit 5 changes); submit landed on `#/generating-transaction-full/<id>`; the native symbol was `USDCX`.

- [ ] **Step 1: Write the failing tests.** In `playwright/e2e/helpers/bridge.test.ts`, replace lines 1-7, before:

```ts
/**
 * @jest-environment node
 */
import fs from 'fs';
import path from 'path';

import { bridgedSendRowOf, enText, parseBridgeReceiveState } from './bridge';
```

after:

```ts
/**
 * @jest-environment node
 */
import type { Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

import {
  bridgedSendRowOf,
  enText,
  isArcSnapshotFailure,
  parseBridgeReceiveState,
  readNativeDisplaySymbol,
  reviewQueryParam,
  usdcxChipsProblem
} from './bridge';
```

and append at the end of the file, after one blank line:

```ts
describe('usdcxChipsProblem', () => {
  const chips = (pressed: string) =>
    [
      'send-network-arc-testnet',
      'send-network-sepolia',
      'send-network-base-sepolia',
      'send-network-arbitrum-sepolia'
    ].map(testId => ({ testId, pressed: testId === pressed ? 'true' : 'false' }));

  it('accepts exactly the four USDCx destinations with only the selected one pressed', () => {
    expect(usdcxChipsProblem(chips('send-network-arc-testnet'), 'send-network-arc-testnet')).toBeUndefined();
  });

  it('names a fifth chip, a missing chip, and a wrongly pressed chip', () => {
    expect(
      usdcxChipsProblem(
        [...chips('send-network-arc-testnet'), { testId: 'send-network-miden', pressed: null }],
        'send-network-arc-testnet'
      )
    ).toContain('send-network-miden');
    expect(usdcxChipsProblem(chips('send-network-arc-testnet').slice(1), 'send-network-arc-testnet')).toContain(
      'expected exactly'
    );
    expect(usdcxChipsProblem(chips('send-network-sepolia'), 'send-network-arc-testnet')).toBe(
      'aria-pressed send-network-arc-testnet=false, send-network-sepolia=true; only send-network-arc-testnet may be pressed'
    );
  });
});

describe('reviewQueryParam', () => {
  it("reads a parameter of the review's hash route", () => {
    const url =
      'chrome-extension://abc/fullpage.html#/send/review?amount=10&to=0x405b&tokenId=mtst1apx_qr7&network=arc-testnet&route=usdcx';
    expect(reviewQueryParam(url, 'network')).toBe('arc-testnet');
    expect(reviewQueryParam(url, 'tokenId')).toBe('mtst1apx_qr7');
    expect(reviewQueryParam('chrome-extension://abc/fullpage.html#/send/review', 'network')).toBeNull();
  });
});

describe('isArcSnapshotFailure', () => {
  it('blames the Arc snapshot only for an RPC-shaped error with no burn row queued', () => {
    expect(isArcSnapshotFailure('HTTP request failed. Status: 429', 0)).toBe(true);
    expect(isArcSnapshotFailure('The request took too long to respond. timed out', 0)).toBe(true);
    expect(isArcSnapshotFailure('HTTP request failed. Status: 429', 1)).toBe(false);
    expect(isArcSnapshotFailure('The amount is below the minimum burn.', 0)).toBe(false);
  });
});

describe('readNativeDisplaySymbol', () => {
  const pageRunningHere = () =>
    ({ evaluate: async <T>(callback: (arg: T) => unknown, arg: T) => callback(arg) }) as unknown as Page;
  const native = 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0_qr7qqq9wr6w';

  afterEach(() => {
    Reflect.deleteProperty(globalThis, '__TEST_STORE__');
  });

  it("reads the native row's symbol from the current account only", async () => {
    Reflect.set(globalThis, '__TEST_STORE__', {
      getState: () => ({
        currentAccount: { publicKey: 'acct-a' },
        balances: {
          'acct-b': [{ tokenId: native, metadata: { symbol: 'MIDEN' } }],
          'acct-a': [{ tokenId: native, metadata: { symbol: 'USDCX' } }]
        }
      })
    });
    await expect(readNativeDisplaySymbol(pageRunningHere(), native)).resolves.toBe('USDCX');
  });

  it('throws naming the rows it saw when the native row is missing', async () => {
    Reflect.set(globalThis, '__TEST_STORE__', {
      getState: () => ({ currentAccount: { publicKey: 'acct-a' }, balances: { 'acct-a': [{ tokenId: 'other' }] } })
    });
    await expect(readNativeDisplaySymbol(pageRunningHere(), native)).rejects.toThrow('balance rows: other');
  });
});
```

Mutation notes:
- usdcxChipsProblem "accepts exactly the four ...": compare every chip's `pressed` to `'true'`; the result is a message, not `undefined`.
- usdcxChipsProblem "names a fifth chip, a missing chip, and a wrongly pressed chip": delete the set-equality check; the missing-chip case returns the aria-pressed text and `toContain('expected exactly')` fails.
- reviewQueryParam: read `new URL(url).searchParams`; the hash query is not in `search`, so `toBe('arc-testnet')` fails.
- isArcSnapshotFailure: drop `newUsdcxRows === 0 &&`; the third expectation reads `true`.
- readNativeDisplaySymbol "reads the native row's symbol from the current account only": read `Object.values(state.balances)[0]`; it returns `MIDEN` from acct-b.
- readNativeDisplaySymbol "throws naming the rows it saw ...": delete the `if (!read.symbol)` throw; the promise resolves `null`.

- [ ] **Step 2: Run them and see them fail.**

```bash
yarn jest playwright/e2e/helpers/bridge.test.ts --maxWorkers=2
```

Expected: the six new tests fail with `TypeError: (0 , _bridge.usdcxChipsProblem) is not a function`, `(0 , _bridge.reviewQueryParam) is not a function`, `(0 , _bridge.isArcSnapshotFailure) is not a function` and `(0 , _bridge.readNativeDisplaySymbol) is not a function`; the 12 earlier tests pass.

- [ ] **Step 3: Implement.** Append to the end of `playwright/e2e/helpers/bridge.ts` (the block starts with a blank line):

```ts

/**
 * The symbol the UI shows for the native token: the current account's balance row, whose metadata the store resolves
 * the way the send flow does (`getNativeDisplayMetadataSync`). Throws when the row or its symbol is missing.
 */
export async function readNativeDisplaySymbol(page: Page, nativeTokenId: string): Promise<string> {
  const read = await page.evaluate(tokenId => {
    const store:
      | {
          getState?: () => {
            currentAccount?: { publicKey?: string } | null;
            balances?: Record<string, Array<{ tokenId?: string; metadata?: { symbol?: string } }>>;
          };
        }
      | undefined = Reflect.get(globalThis, '__TEST_STORE__');
    const state = store?.getState?.();
    const account = state?.currentAccount?.publicKey;
    const rows = account === undefined ? [] : (state?.balances?.[account] ?? []);
    return {
      account: account ?? null,
      symbol: rows.find(row => row.tokenId === tokenId)?.metadata?.symbol ?? null,
      tokenIds: rows.map(row => String(row.tokenId ?? ''))
    };
  }, nativeTokenId);
  if (!read.symbol) {
    throw new Error(
      `readNativeDisplaySymbol: no symbol for ${nativeTokenId} on account ${read.account ?? '(none)'}; ` +
        `balance rows: ${read.tokenIds.join(', ') || '(none)'}`
    );
  }
  return read.symbol;
}

/** The destination chips a USDCx burn offers on testnet, in no particular order (bridge-networks.ts). */
export const USDCX_DESTINATION_CHIPS: readonly string[] = [
  'send-network-arc-testnet',
  'send-network-sepolia',
  'send-network-base-sepolia',
  'send-network-arbitrum-sepolia'
];
const ARC_CHIP = 'send-network-arc-testnet';
// The burn's destination snapshot read alone may take its whole 15 s budget before the row is queued.
const SUBMIT_TIMEOUT_MS = 60_000;
const REVIEW_READY_TIMEOUT_MS = 60_000;
const RPC_FAILURE = /\b(HTTP|RPC|JSON-RPC|429|5\d\d|fetch|timed? ?out|timeout|rate.?limit\w*)\b/i;

export interface NetworkChipState {
  testId: string;
  /** The chip's `aria-pressed`, or null when it has none. */
  pressed: string | null;
}

/** Why the chips are not exactly the four USDCx destinations with only `selected` pressed, or undefined when they are. */
export function usdcxChipsProblem(chips: readonly NetworkChipState[], selected: string): string | undefined {
  const ids = chips.map(chip => chip.testId).sort();
  const expected = [...USDCX_DESTINATION_CHIPS].sort();
  if (ids.join(',') !== expected.join(',')) {
    return `network chips ${JSON.stringify(ids)}, expected exactly ${JSON.stringify(expected)}`;
  }
  const wrong = chips.filter(chip => chip.pressed !== (chip.testId === selected ? 'true' : 'false'));
  return wrong.length === 0
    ? undefined
    : `aria-pressed ${wrong.map(chip => `${chip.testId}=${chip.pressed}`).join(', ')}; only ${selected} may be pressed`;
}

/** A query parameter of a hash route such as `fullpage.html#/send/review?network=arc-testnet`. */
export function reviewQueryParam(url: string, name: string): string | null {
  const { hash } = new URL(url);
  const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
  return new URLSearchParams(query).get(name);
}

/** A review-error that names an RPC failure, with no burn row queued: the wallet's Arc snapshot read failed (Q14). */
export function isArcSnapshotFailure(reviewError: string, newUsdcxRows: number): boolean {
  return newUsdcxRows === 0 && RPC_FAILURE.test(reviewError);
}

/** The value cell of the review's detail row labelled `label` (`DetailRow`: a label span beside a value div). */
function detailRowValue(page: Page, label: string) {
  if (label.includes('"')) throw new Error(`detailRowValue: label ${label} cannot be quoted in XPath`);
  return page.locator(`xpath=//div[span[normalize-space(.)="${label}"]]/div`);
}

export interface BridgeOutUsdcxOptions {
  destAddress: `0x${string}`;
  /** Human amount, as typed, e.g. '10'. */
  amount: string;
  /** The composite native id (`<bech32>_<suffix>`) the wallet discovered (balance-truth.ts). */
  nativeTokenId: string;
  /** From `readNativeDisplaySymbol`. */
  nativeSymbol: string;
  /** Per-step timeout (default 30s). */
  stepTimeoutMs?: number;
  /** Where usdcx-route.png, usdcx-review-light.png and usdcx-review-dark.png go. */
  screenshotDir: string;
}

export interface BridgeOutUsdcxResult {
  reviewUrl: string;
  generatingUrl: string;
}

/**
 * Burn the native USDCx to an Arc Testnet address through the real Send UI (spec section 5 step 6), ending on the
 * generating-transaction screen. Checks on the way: exactly the four USDCx destination chips with Arc pressed, the
 * route subtitle and fee row naming the native symbol, the burn notice on route and review, and the review's network.
 */
export async function bridgeOutUsdcx(wallet: Wallet, opts: BridgeOutUsdcxOptions): Promise<BridgeOutUsdcxResult> {
  const { page, extensionId } = wallet;
  const step = opts.stepTimeoutMs ?? STEP_TIMEOUT_MS;
  if (opts.nativeSymbol.trim() === '' || opts.nativeSymbol.trim().toUpperCase() === 'MIDEN') {
    throw new Error(`bridgeOutUsdcx: "${opts.nativeSymbol}" cannot name USDCx, the asset a USDCx burn spends`);
  }
  const routeFees = enText('usdcxMidenFees', { symbol: opts.nativeSymbol });
  const sponsorshipFee = enText('usdcxSponsorshipFee', { symbol: opts.nativeSymbol });
  const notice = enText('usdcxWithdrawalNotice');
  const rowsBefore = new Set((await readBridgedSendRows(page)).map(row => row.id));
  fs.mkdirSync(opts.screenshotDir, { recursive: true });
  const chips = () =>
    page.locator('[data-testid^="send-network-"]:not([data-testid="send-network-options"])').evaluateAll(elements =>
      elements.map(element => ({
        testId: element.getAttribute('data-testid') ?? '',
        pressed: element.getAttribute('aria-pressed')
      }))
    );

  await page.goto(
    `chrome-extension://${extensionId}/fullpage.html#/send?tokenId=${encodeURIComponent(opts.nativeTokenId)}`
  );
  const flow = page.getByTestId('send-flow');
  await expect(flow).toBeVisible({ timeout: step });
  await flow.getByTestId('send-recipient-input').fill(opts.destAddress);
  await expect
    .poll(async () => usdcxChipsProblem(await chips(), ARC_CHIP) ?? 'ok', {
      timeout: step,
      message: 'Arc Testnet is preselected among exactly the four USDCx destinations'
    })
    .toBe('ok');
  await page.getByTestId(ARC_CHIP).click({ timeout: step });
  await expect.poll(async () => usdcxChipsProblem(await chips(), ARC_CHIP) ?? 'ok', { timeout: step }).toBe('ok');
  await flow.getByTestId('send-recipient-confirm').click({ timeout: step });
  await flow.getByTestId('send-amount-input').fill(opts.amount);
  await flow.getByTestId('send-amount-confirm').click({ timeout: step });

  const route = flow.getByTestId('bridge-route-usdcx');
  await expect(route).toBeVisible({ timeout: step });
  // The route is forced for the native token; the click only guards against that changing.
  await route.click({ timeout: step });
  await expect(route.getByText(routeFees, { exact: true }), 'the route names the native fee asset').toBeVisible({
    timeout: step
  });
  await expect(flow.getByTestId('usdcx-burn-notice')).toHaveText(notice, { timeout: step });
  await page.screenshot({ path: path.join(opts.screenshotDir, 'usdcx-route.png') });
  await flow.getByTestId('bridge-route-confirm').click({ timeout: step });

  await page.waitForURL(/#\/send\/review\?/, { timeout: step });
  const reviewUrl = page.url();
  expect(reviewQueryParam(reviewUrl, 'network'), 'the review is for Arc Testnet').toBe('arc-testnet');
  await expect(detailRowValue(page, enText('network'))).toHaveText('Arc Testnet', { timeout: step });
  await expect(detailRowValue(page, enText('networkFee')), 'the fee row names the native fee asset').toHaveText(
    sponsorshipFee
  );
  await expect(page.getByTestId('usdcx-burn-notice')).toHaveText(notice);
  await expect(page.getByTestId('send-review-submit')).toBeEnabled({ timeout: REVIEW_READY_TIMEOUT_MS });
  await page.screenshot({ path: path.join(opts.screenshotDir, 'usdcx-review-light.png') });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: path.join(opts.screenshotDir, 'usdcx-review-dark.png') });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));

  await page.getByTestId('send-review-submit').click({ timeout: step });
  const generating = /\/generating-transaction(-full)?\//;
  let reviewError = '';
  await expect
    .poll(
      async () => {
        if (generating.test(page.url())) return 'generating';
        const error = page.getByTestId('review-error');
        if (!(await error.isVisible())) return 'waiting';
        reviewError = (await error.textContent()) ?? '';
        return 'review-error';
      },
      { timeout: SUBMIT_TIMEOUT_MS, intervals: [500] }
    )
    .not.toBe('waiting');
  if (!generating.test(page.url())) {
    const fresh = (await readBridgedSendRows(page)).filter(
      row => row.extraInputs?.provider === 'usdcx' && !rowsBefore.has(row.id)
    );
    throw new Error(
      isArcSnapshotFailure(reviewError, fresh.length)
        ? `Arc RPC unavailable for the wallet's balance snapshot (burn.ts:103), infra: review-error "${reviewError}"`
        : `the review refused the burn: review-error "${reviewError}", ${fresh.length} new usdcx rows`
    );
  }
  return { reviewUrl, generatingUrl: page.url() };
}
```

- [ ] **Step 4: Run them and see them pass.** Same command. Expected: `Tests: 18 passed, 18 total`.

- [ ] **Step 5: Format, lint and the harness ratchet.**

```bash
npx prettier --write playwright/e2e/helpers/bridge.ts playwright/e2e/helpers/bridge.test.ts
npx eslint --max-warnings 0 playwright/e2e/helpers/bridge.ts playwright/e2e/helpers/bridge.test.ts
yarn lint:e2e
```

Expected: eslint exit 0; `yarn lint:e2e` reports no new violations (the helper has no `toBeGreaterThan(0)`, no `waitForTimeout`, and no `expect` inside an if/else).

- [ ] **Step 6: Commit deferred to Task 24 (p3-arc).**

---

### Task 22: Guardian identity, failure context and burn-row checks in usdcx-guardian.ts (p3-guardian)

**Files:**
- Create: `playwright/e2e/helpers/usdcx-guardian.ts`
- Create: `playwright/e2e/helpers/usdcx-guardian.test.ts`

**Interfaces:**
- Consumes: `BridgedSendRow` (bridge.ts, previous task), `describeTransactionRow(row): string` (history.ts:248), `TxStatus` (history.ts:28-35), `TransactionRowSnapshot`, `GUARDIAN_ECDSA_SCHEME` (usdcx-constants.ts). The hosted Guardian's live shapes (read 2026-10-10): `GET /status` -> `{"status":"ok","version":"0.18.0","git_commit":"fab5f5cb2c3f","environment":"testnet","started_at":"...","uptime_seconds":...}`; `GET /pubkey?scheme=ecdsa` -> `{"commitment":"0x6b3e...990f","pubkey":"0x02d2...c11e"}`.
- Produces (contract 3.3): `interface GuardianIdentity { url: string; version: string; gitCommit: string; environment: string; commitment: Hex; pubkey: Hex }`; `guardianIdentity(url: string, fetchImpl?: typeof fetch): Promise<GuardianIdentity>`; `guardianFailureContext(identity: GuardianIdentity, fetchImpl?: typeof fetch): Promise<string>` (never throws, 5 s re-read); `assertNoGuardianOpInFlight(rows: readonly TransactionRowSnapshot[], accountId: string): void` (compares bech32 parts, so a bare and a composite id of one account match); `burnFailureMessage(row: BridgedSendRow): string`.

- [ ] **Step 1: Write the failing test.** Create `playwright/e2e/helpers/usdcx-guardian.test.ts`:

```ts
/**
 * @jest-environment node
 */
import type { BridgedSendRow } from './bridge';
import {
  assertNoGuardianOpInFlight,
  burnFailureMessage,
  guardianFailureContext,
  guardianIdentity,
  type GuardianIdentity
} from './usdcx-guardian';

const HOSTED_GUARDIAN = 'https://guardian.openzeppelin.com';
// The hosted Guardian's answers on 2026-10-10.
const STATUS = {
  status: 'ok',
  version: '0.18.0',
  git_commit: 'fab5f5cb2c3f',
  environment: 'testnet',
  started_at: '2026-10-06T18:47:55.136361639+00:00',
  uptime_seconds: 351836
};
const PUBKEY = {
  commitment: '0x6b3e7eda3e144c8f58980385492da4cc1e474a691771704b8f99da441609990f',
  pubkey: '0x02d2190fce12065f8e0d4933cd84687e68a644a5e5d39e497a65b7b1a769f5c11e'
};

function stubFetch(routes: Record<string, unknown>, calls: string[] = []): typeof fetch {
  return async input => {
    const url = String(input);
    calls.push(url);
    if (!(url in routes)) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(routes[url]), { status: 200 });
  };
}

const IDENTITY: GuardianIdentity = {
  url: HOSTED_GUARDIAN,
  version: '0.18.0',
  gitCommit: 'fab5f5cb2c3f',
  environment: 'testnet',
  commitment: '0x6b3e7eda3e144c8f58980385492da4cc1e474a691771704b8f99da441609990f',
  pubkey: '0x02d2190fce12065f8e0d4933cd84687e68a644a5e5d39e497a65b7b1a769f5c11e'
};

describe('guardianIdentity', () => {
  it('records /status and the ECDSA key from /pubkey', async () => {
    const calls: string[] = [];
    const identity = await guardianIdentity(
      HOSTED_GUARDIAN,
      stubFetch({ [`${HOSTED_GUARDIAN}/status`]: STATUS, [`${HOSTED_GUARDIAN}/pubkey?scheme=ecdsa`]: PUBKEY }, calls)
    );
    expect(identity).toEqual(IDENTITY);
    expect(calls).toEqual([`${HOSTED_GUARDIAN}/status`, `${HOSTED_GUARDIAN}/pubkey?scheme=ecdsa`]);
  });

  it('refuses a Guardian whose status is not ok', async () => {
    await expect(
      guardianIdentity(HOSTED_GUARDIAN, stubFetch({ [`${HOSTED_GUARDIAN}/status`]: { ...STATUS, status: 'degraded' } }))
    ).rejects.toThrow('status "degraded", not "ok"');
  });

  it('refuses a commitment that is not 32 bytes', async () => {
    await expect(
      guardianIdentity(
        HOSTED_GUARDIAN,
        stubFetch({
          [`${HOSTED_GUARDIAN}/status`]: STATUS,
          [`${HOSTED_GUARDIAN}/pubkey?scheme=ecdsa`]: { ...PUBKEY, commitment: '0x6b3e' }
        })
      )
    ).rejects.toThrow('commitment 0x6b3e is not 64 hex');
  });

  it('names the URL of a failed request', async () => {
    await expect(guardianIdentity(HOSTED_GUARDIAN, stubFetch({}))).rejects.toThrow(
      `GET ${HOSTED_GUARDIAN}/status: HTTP 404`
    );
  });
});

describe('guardianFailureContext', () => {
  it('says unchanged when the re-read matches the identity recorded at the start', async () => {
    const context = await guardianFailureContext(IDENTITY, stubFetch({ [`${HOSTED_GUARDIAN}/status`]: STATUS }));
    expect(context).toContain(
      `Guardian ${HOSTED_GUARDIAN} (at start: version 0.18.0, git_commit fab5f5cb2c3f, environment testnet`
    );
    expect(context).toContain('re-read: unchanged');
  });

  it('shows both identities when the Guardian was redeployed mid-run', async () => {
    const context = await guardianFailureContext(
      IDENTITY,
      stubFetch({ [`${HOSTED_GUARDIAN}/status`]: { ...STATUS, version: '0.18.1', git_commit: '0123456789ab' } })
    );
    expect(context).toContain('version 0.18.0, git_commit fab5f5cb2c3f');
    expect(context).toContain('re-read DIFFERS: status ok, version 0.18.1, git_commit 0123456789ab');
  });

  it('never throws when the re-read fails', async () => {
    const context = await guardianFailureContext(IDENTITY, async () => {
      throw new Error('connect ECONNREFUSED');
    });
    expect(context).toContain('re-read failed: connect ECONNREFUSED');
  });
});

describe('assertNoGuardianOpInFlight', () => {
  const account = 'mtst1are0gtx635qs7starjk4m3x49vcm0w2g_qr7qqq9wr6w';

  it("passes when none of the account's rows is Queued or Generating", () => {
    expect(() =>
      assertNoGuardianOpInFlight(
        [
          { id: 'c1', accountId: account, status: 2 },
          { id: 'u1', accountId: account, status: 4 },
          { id: 'o1', accountId: 'mtst1other_qr7qqq9wr6w', status: 0 }
        ],
        account
      )
    ).not.toThrow();
  });

  it("lists the account's Queued and Generating rows, matching a bare id to a composite one", () => {
    expect(() =>
      assertNoGuardianOpInFlight(
        [
          { id: 'q1', accountId: account, status: 0, type: 'consume' },
          { id: 'g1', accountId: account, status: 1, type: 'bridged-send' },
          { id: 'c1', accountId: account, status: 2 }
        ],
        'mtst1are0gtx635qs7starjk4m3x49vcm0w2g'
      )
    ).toThrow(/2 transaction\(s\)[\s\S]*q1 type=consume Queued[\s\S]*g1 type=bridged-send GeneratingTransaction/);
  });
});

describe('burnFailureMessage', () => {
  const row: BridgedSendRow = {
    id: 'b1',
    status: 3,
    stage: 'signing-proposal',
    stageTimestamps: { 'creating-proposal': 1, 'signing-proposal': 2 },
    error: 'Transaction failed',
    rawError: 'guardian: 409 Conflict: pending canonicalization',
    submitEvidence: [{ attemptId: 'a1', source: 'pin' }]
  };

  it('names the stage, both errors, the stage stamps and the submit evidence', () => {
    expect(burnFailureMessage(row)).toBe(
      [
        'USDCx burn row b1: status 3, stage signing-proposal',
        '  error: Transaction failed',
        '  rawError: guardian: 409 Conflict: pending canonicalization',
        '  stageTimestamps: {"creating-proposal":1,"signing-proposal":2}',
        '  submitEvidence: [{"attemptId":"a1","source":"pin"}]',
        '  the prior Guardian candidate had not settled'
      ].join('\n')
    );
  });

  it('adds the settle hint only for a 409 or a pending canonicalization', () => {
    expect(burnFailureMessage({ ...row, rawError: 'remote prover timed out' })).not.toContain('had not settled');
    expect(burnFailureMessage({ ...row, rawError: 'HTTP 409' })).toContain('had not settled');
  });
});
```

Mutation notes:
- "records /status and the ECDSA key from /pubkey": read `text(status, 'gitCommit', ...)`; it throws `no gitCommit`.
- "refuses a Guardian whose status is not ok": delete the `status.status !== 'ok'` check; the promise resolves.
- "refuses a commitment that is not 32 bytes": pass length 4 to `hexField` for `commitment`; the short value is accepted.
- "names the URL of a failed request": throw `HTTP ${response.status}` without the URL; `toThrow` fails.
- "says unchanged when the re-read matches ...": compare `status.git_commit === identity.version`; the result says DIFFERS.
- "shows both identities when the Guardian was redeployed mid-run": set `same = true`; `re-read DIFFERS` is missing.
- "never throws when the re-read fails": remove the try/catch; the promise rejects.
- "passes when none of the account's rows is Queued or Generating": add `TxStatus.Unconfirmed` to the in-flight filter; it throws.
- "lists the account's Queued and Generating rows, matching a bare id to a composite one": compare `row.accountId === accountId` without `bare`; nothing matches and it does not throw.
- "names the stage, both errors, the stage stamps and the submit evidence": drop the `submitEvidence` line; `toBe` fails.
- "adds the settle hint only for a 409 or a pending canonicalization": push the hint unconditionally; `not.toContain` fails.

- [ ] **Step 2: Run it and see it fail.**

```bash
yarn jest playwright/e2e/helpers/usdcx-guardian.test.ts --maxWorkers=2
```

Expected: `Cannot find module './usdcx-guardian' from 'playwright/e2e/helpers/usdcx-guardian.test.ts'`.

- [ ] **Step 3: Implement.** Create `playwright/e2e/helpers/usdcx-guardian.ts`:

```ts
/**
 * The hosted Guardian's side of the USDCx suites: who it was when the run started, what a failure should say about it,
 * and the two row checks that tell a Guardian fault from a wallet one.
 */
import type { Hex } from 'viem';

import type { BridgedSendRow } from './bridge';
import { describeTransactionRow, TxStatus, type TransactionRowSnapshot } from './history';
import { GUARDIAN_ECDSA_SCHEME } from './usdcx-constants';

export interface GuardianIdentity {
  url: string;
  version: string;
  gitCommit: string;
  environment: string;
  /** The ECDSA key commitment the account's `update_guardian` procedure must name. */
  commitment: Hex;
  pubkey: Hex;
}

const IDENTITY_TIMEOUT_MS = 15_000;
const CONTEXT_TIMEOUT_MS = 5_000;

async function getJson(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    throw new Error(`GET ${url}: not a JSON object`);
  return Object.fromEntries(Object.entries(body));
}

function text(body: Record<string, unknown>, key: string, url: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value === '') throw new Error(`GET ${url}: no ${key}`);
  return value;
}

function hexField(body: Record<string, unknown>, key: string, url: string, length: number): Hex {
  const value = text(body, key, url);
  if (!new RegExp(`^0x[0-9a-fA-F]{${length}}$`).test(value))
    throw new Error(`GET ${url}: ${key} ${value} is not ${length} hex`);
  return `0x${value.slice(2).toLowerCase()}`;
}

/** `/status` (which must say ok) and the ECDSA key from `/pubkey?scheme=ecdsa`, recorded once per run. */
export async function guardianIdentity(url: string, fetchImpl: typeof fetch = fetch): Promise<GuardianIdentity> {
  const statusUrl = `${url}/status`;
  const status = await getJson(statusUrl, fetchImpl, IDENTITY_TIMEOUT_MS);
  if (status.status !== 'ok') throw new Error(`GET ${statusUrl}: status ${JSON.stringify(status.status)}, not "ok"`);
  const pubkeyUrl = `${url}/pubkey?scheme=${GUARDIAN_ECDSA_SCHEME}`;
  const pubkey = await getJson(pubkeyUrl, fetchImpl, IDENTITY_TIMEOUT_MS);
  return {
    url,
    version: text(status, 'version', statusUrl),
    gitCommit: text(status, 'git_commit', statusUrl),
    environment: text(status, 'environment', statusUrl),
    commitment: hexField(pubkey, 'commitment', pubkeyUrl, 64),
    pubkey: hexField(pubkey, 'pubkey', pubkeyUrl, 66)
  };
}

/**
 * The Guardian lines of a failure message (spec section 11): the URL, the identity recorded at the start, and a
 * best-effort `/status` re-read, with both shown when they differ. Never throws: it decorates another failure.
 */
export async function guardianFailureContext(
  identity: GuardianIdentity,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const recorded = `version ${identity.version}, git_commit ${identity.gitCommit}, environment ${identity.environment}`;
  const head = `Guardian ${identity.url} (at start: ${recorded}; ECDSA commitment ${identity.commitment})`;
  try {
    const status = await getJson(`${identity.url}/status`, fetchImpl, CONTEXT_TIMEOUT_MS);
    const now = `status ${String(status.status)}, version ${String(status.version)}, git_commit ${String(status.git_commit)}, environment ${String(status.environment)}`;
    const same =
      status.status === 'ok' &&
      status.version === identity.version &&
      status.git_commit === identity.gitCommit &&
      status.environment === identity.environment;
    return same ? `${head}; re-read: unchanged` : `${head}; re-read DIFFERS: ${now}`;
  } catch (error) {
    return `${head}; re-read failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Throws listing `accountId`'s rows still Queued or GeneratingTransaction: a burn must not overlap another write. */
export function assertNoGuardianOpInFlight(rows: readonly TransactionRowSnapshot[], accountId: string): void {
  // Rows keep the composite id; compare bech32 parts so a bare and a composite form of one account match.
  const bare = (id: string): string => id.split('_')[0] ?? id;
  const account = bare(accountId);
  const inFlight = rows.filter(
    row =>
      row.accountId !== undefined &&
      bare(row.accountId) === account &&
      (row.status === TxStatus.Queued || row.status === TxStatus.GeneratingTransaction)
  );
  if (inFlight.length > 0) {
    throw new Error(
      `${inFlight.length} transaction(s) of ${accountId} still in flight; a Guardian write would overlap them:\n` +
        inFlight.map(row => `  ${describeTransactionRow(row)}`).join('\n')
    );
  }
}

/** A Failed or stuck USDCx burn row as the failure message spec section 11 asks for. */
export function burnFailureMessage(row: BridgedSendRow): string {
  const raw = row.rawError ?? '';
  const lines = [
    `USDCx burn row ${row.id}: status ${row.status}, stage ${row.stage ?? '-'}`,
    `  error: ${row.error ?? '-'}`,
    `  rawError: ${raw || '-'}`,
    `  stageTimestamps: ${JSON.stringify(row.stageTimestamps ?? {})}`,
    `  submitEvidence: ${JSON.stringify(row.submitEvidence ?? [])}`
  ];
  if (/\b409\b|pending canonicalization/i.test(raw)) lines.push('  the prior Guardian candidate had not settled');
  return lines.join('\n');
}
```

- [ ] **Step 4: Run it and see it pass.** Same command. Expected: `Tests: 11 passed, 11 total`.

- [ ] **Step 5: Format and lint.**

```bash
npx prettier --write playwright/e2e/helpers/usdcx-guardian.ts playwright/e2e/helpers/usdcx-guardian.test.ts
npx eslint --max-warnings 0 playwright/e2e/helpers/usdcx-guardian.ts playwright/e2e/helpers/usdcx-guardian.test.ts
```

- [ ] **Step 6: Commit deferred to Task 24 (p3-arc).**

---

### Task 23: Miden chain oracle: usdcx-chain-evidence.mjs subcommands and usdcx-miden.ts (p3-miden-oracle)

The oracle gains a subcommand dispatcher; the positional form (usdcx-chain-evidence.mjs:6) goes. Its only other caller, `tests/bridge/bridge-out-usdcx.spec.ts:16-32` (the execFile at :24), keeps the positional call until Task 28 (p5-burn-retarget) rewrites it in commit 12. Between commits 9 and 12 that spec runs nowhere (it skips without `USDCX_TESTNET_REPO`, which no CI job sets); anyone who does run it gets a loud usage failure, never an RPC URL read as a subcommand's argument, pinned by 'refuses the removed positional form, an RPC URL first, with its usage line'. Step 7 lists every caller so none is missed.

Validated on SDK 0.17.3 (the installed package) against testnet, read-only, 2026-10-10:
- `mint-note-id` reproduces two notes Circle's relayer actually minted: the `0x370bf19a` deposit (the NEGATIVE vector, recipient `0x8da911727d5b53916f2c221c00c091`, 2000 USDC, nonce `0x335d...8a41`) gives `0xbf203bed...4f93`, committed at block 81129 with sender = the USDCx faucet and the recipient's account-target tag; the spike v2 deposit back (`0x9bed24c5`, recipient `0xf2f42cda8d010f417d1cad5dc4d52b`, 1 USDC, nonce `0x6ff3...a3b4`) gives `0xbedb2cea...301e`, the note that wallet consumed. So the nonce is the DepositIntent word at offset 204 and the serial is miden-usdcx's `bytes32_to_storage_map_key` (Poseidon2 over eight u32 LE limbs); this is no longer capture-dependent.
- `burn-evidence` passes canonical on both spike burns (`0xa6101e78...`, recipient `0xfEC2...2D7E`; `0x9671...434b`, recipient `0x405b...8026`) with sponsorship 119 read live from `miden::standards::fees::policies::basic_constant_fee::fee_schedule[burn root]`, and fails `canonical asset, storage, schemes and attachment payloads` when given another recipient.
- `burn-outputs` was not run: no captured `resultBytes` exists yet. (spike-dependent: decode-by-role validated by spec 14 step 1; `executedTransaction().feeNote()` and `.userOutputNotes()` exist in 0.17.3's typings, and the second user output is checked against `NoteScript.feeSponsorship().root()`.)

**Files:**
- Modify: `playwright/e2e/helpers/usdcx-chain-evidence.mjs` (whole file)
- Create: `playwright/e2e/helpers/usdcx-miden.ts`
- Create: `playwright/e2e/helpers/usdcx-miden.test.ts`

**Interfaces:**
- Consumes: `FEE_RESERVE_MULTIPLE`, `ArcClock`, `realArcClock` (usdcx-constants.ts); the SDK browser build at `node_modules/@miden-sdk/miden-sdk/dist/st/` (`RpcClient.getNotesById/getNetworkNoteStatus/getNullifierCommitHeight/getBlockHeaderByNumber/getAccountDetails/syncNotes`, `Poseidon2.hashElements`, `Note.createP2IDNote`, `NoteScript.p2id/burn/feeSponsorship`, `TransactionResult.deserialize`, `ExecutedTransaction.feeNote/userOutputNotes`).
- Produces (contract 3.4): `type ChainEvidenceRunner = (args: readonly string[], opts: { timeoutMs: number; stdin?: string }) => Promise<string>`; `runChainEvidence: ChainEvidenceRunner`; `bareId(id: string): string`; `accountHex(bech32OrComposite: string, run?): Promise<string>`; `supply(rpcUrl: string, faucetBech32: string, run?): Promise<bigint>`; `interface BurnEvidence`; `burnEvidence(rpcUrl, args: { faucetBech32; noteId: Hex; senderBech32; domain: number; recipient: Address; amount: bigint }, run?): Promise<BurnEvidence>` (throws naming the verdict "never committed (expired after the 20-block cap)" or "committed but the faucet has not consumed it", so a returned evidence always has `nullifierCommitted: true`); `interface BurnOutputs`; `burnOutputs(args: { resultBytesBase64: string; burnNoteId: Hex; faucetBech32: string }, run?): Promise<BurnOutputs>`; `deriveUsdcxMintNoteId(args: { faucetHex: string; recipientHex: string; units: bigint; nonce: Hex }, run?): Promise<Hex>`; `interface MidenNoteRead`; `note(rpcUrl, noteId: Hex, run?): Promise<MidenNoteRead>` (`committed` equals `found`: the node serves a note by id only once a block includes it); `nullifier(rpcUrl, noteId: Hex, run?): Promise<{ committed: boolean; blockNum?: number }>`; `recentNotes(rpcUrl, args: { faucetBech32; accountBech32; sinceBlock: number }, run?): Promise<Hex[]>`; `waitForUsdcxMint(rpcUrl, args: { mintNoteId; depositHash; nonce; faucetBech32; accountBech32; sinceBlock; timeoutMs; pollMs? }, deps?: { run?: ChainEvidenceRunner; clock?: ArcClock }): Promise<MidenNoteRead>`; `boundLandedFee(args: { vaultDelta: bigint; knownTerms: bigint; baseFee: number }): { fee: bigint; ceiling: bigint }` (both terms are signed debits: a burn passes V1 - V2 and N + s; a consume of M passes V2 - V3 and -M).
- Oracle CLI: `node usdcx-chain-evidence.mjs <supply|burn-evidence|burn-outputs|mint-note-id|note|nullifier|account-hex|recent-notes> <args...>`, one JSON line on stdout, bigints as decimal strings, bare bech32 ids.

- [ ] **Step 1: Write the failing test.** Create `playwright/e2e/helpers/usdcx-miden.test.ts`:

```ts
/**
 * @jest-environment node
 */
import type { ArcClock } from './usdcx-constants';
import {
  accountHex,
  bareId,
  boundLandedFee,
  burnEvidence,
  burnOutputs,
  deriveUsdcxMintNoteId,
  note,
  nullifier,
  recentNotes,
  runChainEvidence,
  supply,
  waitForUsdcxMint,
  type ChainEvidenceRunner
} from './usdcx-miden';

const RPC = 'https://rpc.testnet.miden.io';
const FAUCET = 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0_qr7qqq9wr6w';
const FAUCET_HEX = '0x4cbdcaffe75f0a317482224dae6436';
const WALLET = 'mtst1are0gtx635qs7starjk4m3x49vcm0w2g_qr7qqq9wr6w';
const BURN_NOTE = '0xa6101e78b77fd80073e0e8b439d26349f3b664e09ef4675301815749acea3c7d';
const MINT_NOTE = '0xbf203bedf0b053a692a4340d9cc17f71cb84deb4c75b4bacbdda406e0fb14f93';

/** A runner that records its calls and answers each with the next canned stdout. */
function scripted(...answers: Array<Record<string, unknown> | Error>): {
  run: ChainEvidenceRunner;
  calls: Array<{ args: readonly string[]; stdin?: string }>;
} {
  const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
  const run: ChainEvidenceRunner = async (args, opts) => {
    calls.push({ args, stdin: opts.stdin });
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`unexpected oracle call ${args.join(' ')}`);
    if (answer instanceof Error) throw answer;
    return `${JSON.stringify(answer)}\n`;
  };
  return { run, calls };
}

function fakeClock(): ArcClock & { slept: number[] } {
  let now = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: async ms => {
      slept.push(ms);
      now += ms;
    }
  };
}

describe('bareId', () => {
  it('cuts a composite id to its bech32 and leaves a bare one alone', () => {
    expect(bareId(WALLET)).toBe('mtst1are0gtx635qs7starjk4m3x49vcm0w2g');
    expect(bareId('mtst1are0gtx635qs7starjk4m3x49vcm0w2g')).toBe('mtst1are0gtx635qs7starjk4m3x49vcm0w2g');
  });
});

describe('the oracle wrappers', () => {
  it('accountHex hands the oracle the bare id and checks the hex it gets back', async () => {
    const { run, calls } = scripted({ hex: '0xf2f42cda8d010f417d1cad5dc4d52b' }, { hex: '0x12' });
    await expect(accountHex(WALLET, run)).resolves.toBe('0xf2f42cda8d010f417d1cad5dc4d52b');
    expect(calls[0]?.args).toEqual(['account-hex', 'mtst1are0gtx635qs7starjk4m3x49vcm0w2g']);
    await expect(accountHex(WALLET, run)).rejects.toThrow('0x12 is not an account id');
  });

  it('supply reads the decimal supply as a bigint', async () => {
    const { run, calls } = scripted({ supply: '1000002912999999' });
    await expect(supply(RPC, FAUCET, run)).resolves.toBe(1000002912999999n);
    expect(calls[0]?.args).toEqual(['supply', RPC, 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0']);
  });

  it('burnEvidence passes the expected burn and types every field it gets back', async () => {
    // The 2026-10-10 spike burn, as the oracle printed it against testnet.
    const { run, calls } = scripted({
      noteId: BURN_NOTE,
      amount: '10000000',
      tag: 1112887886,
      scriptRoot: '0x3d951250cb118282a37b8ee9395f3e3b3c30fab4dbe8c6b0093acfeed3ba04af',
      senderHex: '0xee64b3343b2bf28138b0a8731f52d6',
      domain: 26,
      recipient: '0xfec2b02f01b3f46f25d604d0451d2a6876b12d7e',
      sponsorshipUnits: '119',
      status: 'NullifierCommitted',
      nullifierCommitted: true,
      consumeBlock: 113796,
      consumeTimestampSec: 1791638693,
      attemptCount: 0
    });
    const evidence = await burnEvidence(
      RPC,
      {
        faucetBech32: FAUCET,
        noteId: BURN_NOTE,
        senderBech32: 'mtst1arhxfve58v4l9qfckz58x86j6c59evpr_qr7qqq9wr6w',
        domain: 26,
        recipient: '0xfEC2B02f01B3F46F25d604d0451D2a6876b12D7E',
        amount: 10_000_000n
      },
      run
    );
    expect(calls[0]?.args).toEqual([
      'burn-evidence',
      RPC,
      'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0',
      BURN_NOTE,
      'mtst1arhxfve58v4l9qfckz58x86j6c59evpr',
      '26',
      '0xfEC2B02f01B3F46F25d604d0451D2a6876b12D7E',
      '10000000'
    ]);
    expect(evidence).toEqual({
      noteId: BURN_NOTE,
      amount: 10_000_000n,
      tag: 0x4255524e,
      scriptRoot: '0x3d951250cb118282a37b8ee9395f3e3b3c30fab4dbe8c6b0093acfeed3ba04af',
      senderHex: '0xee64b3343b2bf28138b0a8731f52d6',
      domain: 26,
      recipient: '0xfec2b02f01b3f46f25d604d0451d2a6876b12d7e',
      sponsorshipUnits: 119n,
      status: 'NullifierCommitted',
      nullifierCommitted: true,
      consumeBlock: 113796,
      consumeTimestampSec: 1791638693,
      attemptCount: 0
    });
  });

  it('burnEvidence refuses an answer that lost a field', async () => {
    const { run } = scripted({ noteId: BURN_NOTE });
    await expect(
      burnEvidence(
        RPC,
        {
          faucetBech32: FAUCET,
          noteId: BURN_NOTE,
          senderBech32: WALLET,
          domain: 26,
          recipient: '0x405b05F75F8D299FCd413a3d77F89EDDCBa78026',
          amount: 1n
        },
        run
      )
    ).rejects.toThrow('no recipient');
  });

  it('burnOutputs sends the result bytes on stdin and reads the three roles', async () => {
    const { run, calls } = scripted({
      burn: { noteId: BURN_NOTE, amount: '10000000' },
      sponsorship: { noteId: '0x4ba32cfe831e2a265838cddfcbb2258ff995cf2c269f095b59ec2fbda07d31cf', amount: '119' },
      fee: { noteId: '0x01', amount: '133' }
    });
    await expect(
      burnOutputs({ resultBytesBase64: 'AAEC', burnNoteId: BURN_NOTE, faucetBech32: FAUCET }, run)
    ).resolves.toEqual({
      burn: { noteId: BURN_NOTE, amount: 10_000_000n },
      sponsorship: { noteId: '0x4ba32cfe831e2a265838cddfcbb2258ff995cf2c269f095b59ec2fbda07d31cf', amount: 119n },
      fee: { noteId: '0x01', amount: 133n }
    });
    expect(calls[0]).toEqual({
      args: ['burn-outputs', 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0', BURN_NOTE],
      stdin: 'AAEC'
    });
  });

  it('note reads a minted note and a missing one', async () => {
    const { run } = scripted(
      {
        noteId: MINT_NOTE,
        found: true,
        committed: true,
        senderHex: FAUCET_HEX,
        tag: 2376597504,
        assets: [{ faucetHex: FAUCET_HEX, amount: '2000000000' }]
      },
      { noteId: MINT_NOTE, found: false, committed: false, assets: [] }
    );
    await expect(note(RPC, MINT_NOTE, run)).resolves.toEqual({
      noteId: MINT_NOTE,
      found: true,
      committed: true,
      senderHex: FAUCET_HEX,
      tag: 2376597504,
      assets: [{ faucetHex: FAUCET_HEX, amount: 2_000_000_000n }]
    });
    await expect(note(RPC, MINT_NOTE, run)).resolves.toEqual({
      noteId: MINT_NOTE,
      found: false,
      committed: false,
      senderHex: undefined,
      tag: undefined,
      assets: []
    });
  });

  it('nullifier reads the commit block when there is one', async () => {
    const { run } = scripted({ committed: true, blockNum: 81204 }, { committed: false });
    await expect(nullifier(RPC, MINT_NOTE, run)).resolves.toEqual({ committed: true, blockNum: 81204 });
    await expect(nullifier(RPC, MINT_NOTE, run)).resolves.toEqual({ committed: false, blockNum: undefined });
  });

  it('recentNotes is best-effort: [] when the oracle fails', async () => {
    const { run } = scripted(new Error('node unreachable'));
    await expect(
      recentNotes(RPC, { faucetBech32: FAUCET, accountBech32: WALLET, sinceBlock: 1 }, run)
    ).resolves.toEqual([]);
  });
});

describe('waitForUsdcxMint', () => {
  const args = {
    mintNoteId: MINT_NOTE,
    depositHash: '0x370bf19aefa34f6f07d7b731d5b5f323a364c6f4116a22768d4e44a16ffeca4d',
    nonce: '0x335d432e805b61478619eced3af4f3d074e217df74d49eb797542275318e8a41',
    faucetBech32: FAUCET,
    accountBech32: WALLET,
    sinceBlock: 81100,
    timeoutMs: 9_000,
    pollMs: 3_000
  } as const;
  const missing = { noteId: MINT_NOTE, found: false, committed: false, assets: [] };

  it('returns the note once the node has it', async () => {
    const clock = fakeClock();
    const found = { ...missing, found: true, committed: true, senderHex: FAUCET_HEX, tag: 1, assets: [] };
    const { run } = scripted(missing, found);
    await expect(waitForUsdcxMint(RPC, args, { run, clock })).resolves.toMatchObject({ found: true });
    expect(clock.slept).toEqual([3_000]);
  });

  it("times out naming Circle's relayer, the USDCx faucet, the deposit, the nonce, the id and the faucet's notes", async () => {
    const clock = fakeClock();
    const { run } = scripted(missing, missing, missing, missing, { noteIds: ['0xbe16', '0x0563'] });
    await expect(waitForUsdcxMint(RPC, args, { run, clock })).rejects.toThrow(
      [
        `Circle's relayer has not minted deposit ${args.depositHash} through the USDCx faucet mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0 within 9000 ms.`,
        `  nonce: ${args.nonce}`,
        `  derived mint note id: ${MINT_NOTE}`,
        "  the faucet's notes to mtst1are0gtx635qs7starjk4m3x49vcm0w2g since block 81100: 0xbe16, 0x0563"
      ].join('\n')
    );
  });
});

describe('boundLandedFee', () => {
  it('derives the fee from the vault delta and holds it under baseFee x FEE_RESERVE_MULTIPLE', () => {
    // A landed burn: V1 - V2 = N + f1 + s with N 10 USDCx, s 119, f1 133, base fee 7.
    expect(boundLandedFee({ vaultDelta: 10_000_252n, knownTerms: 10_000_119n, baseFee: 7 })).toEqual({
      fee: 133n,
      ceiling: 210n
    });
    // A landed consume of M = 1 USDCx: V2 - V3 = f2 - M.
    expect(boundLandedFee({ vaultDelta: 133n - 1_000_000n, knownTerms: -1_000_000n, baseFee: 7 }).fee).toBe(133n);
    expect(boundLandedFee({ vaultDelta: 210n, knownTerms: 0n, baseFee: 7 }).fee).toBe(210n);
  });

  it('refuses a fee of zero or one above the ceiling', () => {
    expect(() => boundLandedFee({ vaultDelta: 10_000_119n, knownTerms: 10_000_119n, baseFee: 7 })).toThrow(
      'landed-path fee 0'
    );
    expect(() => boundLandedFee({ vaultDelta: 211n, knownTerms: 0n, baseFee: 7 })).toThrow('outside (0, 210]');
  });
});

// The real oracle on the installed SDK. These subcommands read no network.
describe('usdcx-chain-evidence.mjs', () => {
  jest.setTimeout(60_000);

  it.each([
    {
      deposit: 'Circle-attested 0x370bf19a (NEGATIVE vector), minted at block 81129',
      recipientHex: '0x8da911727d5b53916f2c221c00c091',
      units: 2_000_000_000n,
      nonce: '0x335d432e805b61478619eced3af4f3d074e217df74d49eb797542275318e8a41',
      minted: '0xbf203bedf0b053a692a4340d9cc17f71cb84deb4c75b4bacbdda406e0fb14f93'
    },
    {
      deposit: 'the 2026-10-10 spike deposit back 0x9bed24c5, consumed by its wallet',
      recipientHex: '0xf2f42cda8d010f417d1cad5dc4d52b',
      units: 1_000_000n,
      nonce: '0x6ff37d71883632f16af4b01d811e26a8141517663bca88e5cfc23d7fcbe0a3b4',
      minted: '0xbedb2cea0b47a01b8ebc6c10e428d0ff3bb782406e2784b4380ab171757b301e'
    }
  ] as const)('derives the note miden-usdcx minted for $deposit', async ({ recipientHex, units, nonce, minted }) => {
    await expect(deriveUsdcxMintNoteId({ faucetHex: FAUCET_HEX, recipientHex, units, nonce })).resolves.toBe(minted);
  });

  it('reads the account id of a bech32 address', async () => {
    await expect(accountHex(FAUCET)).resolves.toBe(FAUCET_HEX);
    await expect(accountHex('mtst1azx6jytj04d48yt09s3pcqxqjyal7kas')).resolves.toBe('0x8da911727d5b53916f2c221c00c091');
  });

  it('fails an unknown subcommand with its usage line', async () => {
    await expect(runChainEvidence(['frobnicate'], { timeoutMs: 30_000 })).rejects.toThrow(
      'usdcx-chain-evidence frobnicate: AssertionError [ERR_ASSERTION]: usage: usdcx-chain-evidence.mjs <supply|'
    );
  });

  // bridge-out-usdcx.spec.ts calls the oracle positionally until the burn spec is retargeted: that form must fail
  // loudly, never read its URL as a subcommand's argument.
  it('refuses the removed positional form, an RPC URL first, with its usage line', async () => {
    await expect(
      runChainEvidence([RPC, 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0'], { timeoutMs: 30_000 })
    ).rejects.toThrow(
      `usdcx-chain-evidence ${RPC}: AssertionError [ERR_ASSERTION]: usage: usdcx-chain-evidence.mjs <supply|`
    );
  });
});
```

Mutation notes:
- "cuts a composite id to its bech32 ...": return `id`; the first `toBe` fails.
- accountHex: pass `bech32OrComposite` instead of `bareId(...)`; `calls[0].args` fails.
- supply: return `Number(...)`; `toBe(1000002912999999n)` fails.
- "burnEvidence passes the expected burn ...": swap the domain and recipient arguments; `calls[0].args` fails.
- "burnEvidence refuses an answer that lost a field": make `field` return `undefined` instead of throwing; the message becomes `recipient is not a string`.
- burnOutputs: drop `{ stdin: args.resultBytesBase64 }`; `calls[0]` fails on `stdin`.
- note: set `found: true` unconditionally; the second `toEqual` fails.
- nullifier: return `blockNum: undefined` always; the first `toEqual` fails.
- recentNotes: remove the try/catch; the promise rejects.
- "returns the note once the node has it": delete `await clock.sleep(...)`; `slept` is `[]`.
- "times out naming Circle's relayer ...": drop the `recentNotes` call; the faucet-notes line reads `none`.
- "derives the fee from the vault delta ...": compute `ceiling` with `FEE_RESERVE_MULTIPLE - 1`; `ceiling: 210n` fails.
- "refuses a fee of zero or one above the ceiling": test `fee < 0n` instead of `fee <= 0n`; the zero case does not throw.
- "derives the note miden-usdcx minted for ..." (both rows): read the nonce limbs with `readUInt32BE`; both ids differ (run in the scratch copy: `0xddacc0a1...` and `0x00a0ea92...`).
- "reads the account id of a bech32 address": return the faucet hex for every input; the second expectation fails.
- "fails an unknown subcommand with its usage line": delete the `Object.hasOwn` assertion; the error becomes `TypeError: subcommands[name] is not a function`.
- "refuses the removed positional form, an RPC URL first, with its usage line": dispatch an unknown first argument to `supply` (`(subcommands[name] ?? subcommands.supply)(...args)`); the oracle reads the URL as `supply`'s first argument and the usage text is missing.

- [ ] **Step 2: Run it and see it fail.**

```bash
yarn jest playwright/e2e/helpers/usdcx-miden.test.ts --maxWorkers=2
```

Expected: `Cannot find module './usdcx-miden' from 'playwright/e2e/helpers/usdcx-miden.test.ts'`.

- [ ] **Step 3: Implement the oracle.** Replace the whole of `playwright/e2e/helpers/usdcx-chain-evidence.mjs` with:

```js
// Read-only, independent Miden chain oracle for the USDCx suites. Uses the browser WASM artifact so this does not
// depend on a separately installed native CLI version. `node usdcx-chain-evidence.mjs <subcommand> <args...>` prints
// one JSON line, bigints as decimal strings; `burn-outputs` reads base64 result bytes on stdin. Bech32 ids are bare.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const sdkDir = new URL('../../../node_modules/@miden-sdk/miden-sdk/dist/st/', import.meta.url);
const cargo = (await readdir(sdkDir)).find(name => /^Cargo-.*\.js$/.test(name));
assert.ok(cargo, 'SDK WASM glue is installed');
const wasm = await import(new URL(cargo, sdkDir).href);
await wasm.__wbg_init({ module_or_path: await readFile(new URL(wasm.__wasm_url)) });
const sdk = await import(new URL('index.js', sdkDir).href);

const BURN_TAG = 0x4255524e;
const BURN_ATTACHMENT_SCHEME = 5;
const FEE_SCHEDULE_SLOT = 'miden::standards::fees::policies::basic_constant_fee::fee_schedule';

const accountOf = bech32 => sdk.Address.fromBech32(bech32).accountId();

async function withRpc(rpcUrl, read) {
  const rpc = new sdk.RpcClient(new sdk.Endpoint(rpcUrl));
  try {
    return await read(rpc);
  } finally {
    rpc.free();
  }
}

async function fetchNote(rpc, noteId) {
  const [fetched] = await rpc.getNotesById([sdk.NoteId.fromHex(noteId)]);
  return fetched;
}

// The withdrawal attachment: [domain, 0, 0, 0], then the recipient left-padded to bytes32 as eight u32 LE limbs.
function withdrawalAttachment(domain, recipient) {
  const bytes = Buffer.from(recipient.slice(2).toLowerCase().padStart(64, '0'), 'hex');
  const limbs = Array.from({ length: 8 }, (_, index) => BigInt(bytes.readUInt32LE(index * 4)));
  const payload = [BigInt(domain), 0n, 0n, 0n, ...limbs];
  return sdk.NoteAttachment.fromWords(
    new sdk.NoteAttachmentScheme(BURN_ATTACHMENT_SCHEME),
    [0, 4, 8].map(index => new sdk.Word(new BigUint64Array(payload.slice(index, index + 4))))
  );
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

const subcommands = {
  async supply(rpcUrl, faucetBech32) {
    return withRpc(rpcUrl, async rpc => {
      const storage = (await rpc.getAccountDetails(accountOf(faucetBech32))).account().storage();
      return { supply: sdk.BasicFungibleFaucetComponent.fromAccountStorage(storage).tokenSupply().asInt() };
    });
  },

  async 'burn-evidence'(rpcUrl, faucetBech32, noteId, senderBech32, domain, recipient, amount) {
    return withRpc(rpcUrl, async rpc => {
      const faucet = accountOf(faucetBech32);
      const fetched = await fetchNote(rpc, noteId);
      assert.ok(fetched?.note, `burn note ${noteId} is not on chain: never committed (expired after the 20-block cap)`);
      const note = fetched.note;
      assert.equal(note.id().toString(), noteId);
      assert.equal(note.isNetworkNote(), true, 'the burn is a network note');
      assert.equal(note.metadata().noteType(), sdk.NoteType.Public);
      assert.equal(note.metadata().sender().toString(), accountOf(senderBech32).toString(), 'sent by the wallet');
      assert.equal(note.metadata().tag().asU32(), BURN_TAG);
      assert.equal(note.script().root().toHex(), sdk.NoteScript.burn().root().toHex());
      const asset = new sdk.FungibleAsset(faucet, BigInt(amount));
      const expected = sdk.Note.withAttachments(
        new sdk.NoteAssets([asset]),
        note.metadata(),
        new sdk.NoteRecipient(
          note.recipient().serialNum(),
          sdk.NoteScript.burn(),
          new sdk.NoteStorage(new sdk.FeltArray([...asset.vaultKey().toFelts(), ...asset.intoWord().toFelts()]))
        ),
        [
          new sdk.NetworkAccountTarget(faucet, sdk.NoteExecutionHint.always()).toAttachment(),
          withdrawalAttachment(domain, recipient)
        ]
      );
      assert.deepEqual(
        note.serialize(),
        expected.serialize(),
        'canonical asset, storage, schemes and attachment payloads'
      );
      const status = await rpc.getNetworkNoteStatus(sdk.NoteId.fromHex(noteId));
      const consumeBlock = await rpc.getNullifierCommitHeight(
        note.nullifier(),
        fetched.inclusionProof.location().blockNum()
      );
      assert.ok(
        consumeBlock != null,
        `burn note ${noteId} is committed but the faucet has not consumed it ` +
          `(status ${status.status}, attempts ${status.attemptCount}, last error ${status.lastError ?? 'none'})`
      );
      const header = await rpc.getBlockHeaderByNumber(consumeBlock);
      const storage = (await rpc.getAccountDetails(faucet)).account().storage();
      const schedule = storage.getMapItem(FEE_SCHEDULE_SLOT, sdk.NoteScript.burn().root());
      assert.ok(schedule, 'the USDCx faucet has a fee_schedule entry for the burn script');
      return {
        noteId,
        amount: BigInt(amount),
        tag: BURN_TAG,
        scriptRoot: note.script().root().toHex(),
        senderHex: note.metadata().sender().toString(),
        domain: Number(domain),
        recipient: recipient.toLowerCase(),
        sponsorshipUnits: schedule.toFelts()[0].asInt(),
        status: status.status,
        nullifierCommitted: true,
        consumeBlock,
        consumeTimestampSec: header.timestamp(),
        attemptCount: status.attemptCount
      };
    });
  },

  // Decodes a burn's TransactionResult by role: the burn note (by id), the faucet's sponsorship note (the one other
  // user output, a fee-sponsorship script) and the kernel's fee note.
  async 'burn-outputs'(faucetBech32, burnNoteId) {
    const base64 = await readStdin();
    assert.ok(base64, 'burn-outputs reads the base64 result bytes on stdin');
    const faucet = accountOf(faucetBech32).toString();
    const executed = sdk.TransactionResult.deserialize(
      new Uint8Array(Buffer.from(base64, 'base64'))
    ).executedTransaction();
    const amountOf = (output, role) => {
      const assets = output.assets()?.fungibleAssets() ?? [];
      assert.equal(assets.length, 1, `the ${role} note holds one fungible asset`);
      assert.equal(assets[0].faucetId().toString(), faucet, `the ${role} note is in the USDCx faucet`);
      return assets[0].amount();
    };
    const fee = executed.feeNote();
    assert.ok(fee, 'the burn transaction emitted a fee note');
    const users = executed.userOutputNotes();
    const burn = users.find(output => output.id().toString() === burnNoteId);
    assert.ok(burn, `the burn note ${burnNoteId} is among the outputs`);
    const others = users.filter(output => output.id().toString() !== burnNoteId);
    assert.equal(others.length, 1, `one output besides the burn note, the faucet's sponsorship; got ${others.length}`);
    const sponsorship = others[0];
    const outputs = {
      burn: { noteId: burnNoteId, amount: amountOf(burn, 'burn') },
      sponsorship: { noteId: sponsorship.id().toString(), amount: amountOf(sponsorship, 'sponsorship') },
      fee: { noteId: fee.id().toString(), amount: amountOf(fee, 'fee') }
    };
    // intoFull consumes the handle, so it runs after every other read of the note.
    const full = sponsorship.intoFull();
    assert.ok(full, 'the sponsorship output is a full public note');
    assert.equal(
      full.script().root().toHex(),
      sdk.NoteScript.feeSponsorship().root().toHex(),
      'a fee-sponsorship note'
    );
    return outputs;
  },

  // The P2ID note miden-usdcx 0.17.1 mints for a deposit: serial = Poseidon2 of the DepositIntent nonce packed as eight
  // u32 LE felts (bytes32_to_storage_map_key), one asset of `units`, the recipient's account-target tag.
  async 'mint-note-id'(faucetHex, recipientHex, units, nonce) {
    assert.match(nonce, /^0x[0-9a-fA-F]{64}$/, 'the nonce is a bytes32');
    const faucet = sdk.AccountId.fromHex(faucetHex);
    const target = sdk.AccountId.fromHex(recipientHex);
    const bytes = Buffer.from(nonce.slice(2), 'hex');
    const serial = sdk.Poseidon2.hashElements(
      new sdk.FeltArray(Array.from({ length: 8 }, (_, index) => new sdk.Felt(BigInt(bytes.readUInt32LE(index * 4)))))
    );
    // A by-value argument destroys its handle in the WASM build, so each consumer gets its own NoteAssets.
    const assets = () => new sdk.NoteAssets([new sdk.FungibleAsset(faucet, BigInt(units))]);
    // The P2ID storage is taken from the SDK's own P2ID note, so its layout cannot drift from the standard.
    const p2id = sdk.Note.createP2IDNote(faucet, target, assets(), sdk.NoteType.Public, new sdk.NoteAttachment());
    const recipient = new sdk.NoteRecipient(serial, sdk.NoteScript.p2id(), p2id.recipient().storage());
    const metadata = new sdk.NoteMetadata(faucet, sdk.NoteType.Public, sdk.NoteTag.withAccountTarget(target));
    return { noteId: new sdk.Note(assets(), metadata, recipient).id().toString() };
  },

  async note(rpcUrl, noteId) {
    return withRpc(rpcUrl, async rpc => {
      const fetched = await fetchNote(rpc, noteId);
      if (!fetched) return { noteId, found: false, committed: false, assets: [] };
      return {
        noteId,
        found: true,
        // The node serves a note by id only once a block includes it.
        committed: true,
        senderHex: fetched.metadata.sender().toString(),
        tag: fetched.metadata.tag().asU32(),
        assets: (fetched.note?.assets().fungibleAssets() ?? []).map(asset => ({
          faucetHex: asset.faucetId().toString(),
          amount: asset.amount()
        }))
      };
    });
  },

  async nullifier(rpcUrl, noteId) {
    return withRpc(rpcUrl, async rpc => {
      const fetched = await fetchNote(rpc, noteId);
      if (!fetched) return { committed: false };
      assert.ok(fetched.note, `note ${noteId} is private: the node cannot give its nullifier`);
      const blockNum = await rpc.getNullifierCommitHeight(
        fetched.note.nullifier(),
        fetched.inclusionProof.location().blockNum()
      );
      return blockNum == null ? { committed: false } : { committed: true, blockNum };
    });
  },

  async 'account-hex'(bech32) {
    return { hex: accountOf(bech32).toString() };
  },

  async 'recent-notes'(rpcUrl, faucetBech32, accountBech32, sinceBlock) {
    return withRpc(rpcUrl, async rpc => {
      const faucet = accountOf(faucetBech32).toString();
      const head = (await rpc.getBlockHeaderByNumber()).blockNum();
      const info = await rpc.syncNotes(Number(sinceBlock), head, [
        sdk.NoteTag.withAccountTarget(accountOf(accountBech32))
      ]);
      const notes = [...info.notes(), ...info.blocks().flatMap(block => block.notes())];
      const noteIds = notes.filter(note => note.sender().toString() === faucet).map(note => note.noteId().toString());
      return { noteIds: [...new Set(noteIds)] };
    });
  }
};

const [name, ...args] = process.argv.slice(2);
assert.ok(
  name !== undefined && Object.hasOwn(subcommands, name),
  `usage: usdcx-chain-evidence.mjs <${Object.keys(subcommands).join('|')}> <args...>; got ${name ?? 'nothing'}`
);
const result = await subcommands[name](...args);
console.log(JSON.stringify(result, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)));
```

- [ ] **Step 4: Implement the wrapper.** Create `playwright/e2e/helpers/usdcx-miden.ts`:

```ts
/**
 * Typed wrapper of `usdcx-chain-evidence.mjs`, the Miden chain oracle the USDCx suites check the wallet against. The
 * oracle runs in a child process with its own copy of the SDK's WASM, independent of the wallet under test. Every id it
 * is handed is bare: a composite `<bech32>_<suffix>` id is cut to its bech32 first.
 */
import { execFile } from 'child_process';
import path from 'path';
import { isAddress, isHex, type Address, type Hash, type Hex } from 'viem';

import { FEE_RESERVE_MULTIPLE, realArcClock, type ArcClock } from './usdcx-constants';

export type ChainEvidenceRunner = (
  args: readonly string[],
  opts: { timeoutMs: number; stdin?: string }
) => Promise<string>;

const CHAIN_EVIDENCE_SCRIPT = path.join(__dirname, 'usdcx-chain-evidence.mjs');
const RUN_TIMEOUT_MS = 30_000;
// A burn's result bytes run to ~320 KB, ~430 KB as base64 on stdin; stdout is one JSON line.
const MAX_BUFFER = 16 * 1024 * 1024;

/** The failing assertion's line from the oracle's stderr, or its last lines when there is none. */
function failureLine(stderr: string): string {
  const lines = stderr.split('\n').map(line => line.trim());
  return lines.find(line => /^[A-Za-z]*Error\b/.test(line)) ?? lines.filter(Boolean).slice(-3).join(' | ');
}

export const runChainEvidence: ChainEvidenceRunner = (args, opts) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [CHAIN_EVIDENCE_SCRIPT, ...args],
      { timeout: opts.timeoutMs, maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(`usdcx-chain-evidence ${args[0] ?? ''}: ${failureLine(stderr) || error.message}`, {
              cause: error
            })
          );
          return;
        }
        resolve(stdout);
      }
    );
    child.stdin?.end(opts.stdin ?? '');
  });

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function evidence(
  run: ChainEvidenceRunner,
  args: readonly string[],
  opts: { timeoutMs?: number; stdin?: string } = {}
): Promise<JsonRecord> {
  const stdout = await run(args, { timeoutMs: opts.timeoutMs ?? RUN_TIMEOUT_MS, stdin: opts.stdin });
  const line = stdout.trim().split('\n').pop() ?? '';
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed)) throw new Error(`usdcx-chain-evidence ${args[0] ?? ''} printed ${line}, not a JSON object`);
  return parsed;
}

function field(record: JsonRecord, key: string, what: string): unknown {
  if (!(key in record)) throw new Error(`usdcx-chain-evidence ${what}: no ${key} in ${JSON.stringify(record)}`);
  return record[key];
}

function textField(record: JsonRecord, key: string, what: string): string {
  const value = field(record, key, what);
  if (typeof value !== 'string') throw new Error(`usdcx-chain-evidence ${what}: ${key} is not a string`);
  return value;
}

function hexField(record: JsonRecord, key: string, what: string): Hex {
  const value = textField(record, key, what);
  if (!isHex(value)) throw new Error(`usdcx-chain-evidence ${what}: ${key} ${value} is not hex`);
  return value;
}

function numberField(record: JsonRecord, key: string, what: string): number {
  const value = field(record, key, what);
  if (typeof value !== 'number') throw new Error(`usdcx-chain-evidence ${what}: ${key} is not a number`);
  return value;
}

function unitsField(record: JsonRecord, key: string, what: string): bigint {
  const value = textField(record, key, what);
  if (!/^\d+$/.test(value)) throw new Error(`usdcx-chain-evidence ${what}: ${key} ${value} is not a decimal amount`);
  return BigInt(value);
}

function recordField(record: JsonRecord, key: string, what: string): JsonRecord {
  const value = field(record, key, what);
  if (!isRecord(value)) throw new Error(`usdcx-chain-evidence ${what}: ${key} is not an object`);
  return value;
}

/** The bech32 part of a composite `<bech32>_<suffix>` id; a bare id comes back unchanged. */
export function bareId(id: string): string {
  return id.split('_')[0] ?? id;
}

/** The account id hex (`0x` + 30 hex) of a bech32 or composite address. */
export async function accountHex(
  bech32OrComposite: string,
  run: ChainEvidenceRunner = runChainEvidence
): Promise<string> {
  const hex = textField(await evidence(run, ['account-hex', bareId(bech32OrComposite)]), 'hex', 'account-hex');
  if (!/^0x[0-9a-f]{30}$/.test(hex)) throw new Error(`usdcx-chain-evidence account-hex: ${hex} is not an account id`);
  return hex;
}

/** The faucet's token supply, base units. */
export async function supply(
  rpcUrl: string,
  faucetBech32: string,
  run: ChainEvidenceRunner = runChainEvidence
): Promise<bigint> {
  return unitsField(await evidence(run, ['supply', rpcUrl, bareId(faucetBech32)]), 'supply', 'supply');
}

export interface BurnEvidence {
  noteId: Hex;
  amount: bigint;
  tag: number;
  scriptRoot: Hex;
  senderHex: string;
  domain: number;
  recipient: Address;
  /** The faucet's live `fee_schedule[burn root][0]`: what a burn pays it to execute the note. */
  sponsorshipUnits: bigint;
  status: string;
  nullifierCommitted: boolean;
  consumeBlock: number;
  consumeTimestampSec: number;
  attemptCount?: number;
}

/**
 * The burn note as the node holds it, checked canonical byte for byte against the burn the wallet should have built
 * (asset, storage, the network-account target and the withdrawal attachment to `domain` and `recipient`), plus the
 * block and time the faucet consumed it. Throws naming the verdict when it was never committed or not consumed.
 */
export async function burnEvidence(
  rpcUrl: string,
  args: { faucetBech32: string; noteId: Hex; senderBech32: string; domain: number; recipient: Address; amount: bigint },
  run: ChainEvidenceRunner = runChainEvidence
): Promise<BurnEvidence> {
  const what = 'burn-evidence';
  const out = await evidence(run, [
    'burn-evidence',
    rpcUrl,
    bareId(args.faucetBech32),
    args.noteId,
    bareId(args.senderBech32),
    String(args.domain),
    args.recipient,
    args.amount.toString()
  ]);
  const recipient = textField(out, 'recipient', what);
  if (!isAddress(recipient, { strict: false })) throw new Error(`usdcx-chain-evidence ${what}: recipient ${recipient}`);
  const attemptCount = out.attemptCount;
  return {
    noteId: hexField(out, 'noteId', what),
    amount: unitsField(out, 'amount', what),
    tag: numberField(out, 'tag', what),
    scriptRoot: hexField(out, 'scriptRoot', what),
    senderHex: textField(out, 'senderHex', what),
    domain: numberField(out, 'domain', what),
    recipient,
    sponsorshipUnits: unitsField(out, 'sponsorshipUnits', what),
    status: textField(out, 'status', what),
    nullifierCommitted: field(out, 'nullifierCommitted', what) === true,
    consumeBlock: numberField(out, 'consumeBlock', what),
    consumeTimestampSec: numberField(out, 'consumeTimestampSec', what),
    attemptCount: typeof attemptCount === 'number' ? attemptCount : undefined
  };
}

export interface BurnOutputs {
  burn: { noteId: Hex; amount: bigint };
  sponsorship: { noteId: Hex; amount: bigint };
  fee: { noteId: Hex; amount: bigint };
}

/** A burn row's `resultBytes` (base64) decoded by role. (spike-dependent: decode-by-role validated by spec 14 step 1) */
export async function burnOutputs(
  args: { resultBytesBase64: string; burnNoteId: Hex; faucetBech32: string },
  run: ChainEvidenceRunner = runChainEvidence
): Promise<BurnOutputs> {
  const what = 'burn-outputs';
  const out = await evidence(run, ['burn-outputs', bareId(args.faucetBech32), args.burnNoteId], {
    stdin: args.resultBytesBase64
  });
  const role = (key: string) => {
    const entry = recordField(out, key, what);
    return {
      noteId: hexField(entry, 'noteId', `${what} ${key}`),
      amount: unitsField(entry, 'amount', `${what} ${key}`)
    };
  };
  return { burn: role('burn'), sponsorship: role('sponsorship'), fee: role('fee') };
}

/**
 * The id of the note miden-usdcx 0.17.1 mints for a deposit: a P2ID to `recipientHex` of `units`, its serial the
 * Poseidon2 hash of the DepositIntent nonce (offset 204). Pinned by two minted deposits in usdcx-miden.test.ts.
 */
export async function deriveUsdcxMintNoteId(
  args: { faucetHex: string; recipientHex: string; units: bigint; nonce: Hex },
  run: ChainEvidenceRunner = runChainEvidence
): Promise<Hex> {
  const out = await evidence(run, [
    'mint-note-id',
    args.faucetHex,
    args.recipientHex,
    args.units.toString(),
    args.nonce
  ]);
  return hexField(out, 'noteId', 'mint-note-id');
}

export interface MidenNoteRead {
  noteId: Hex;
  found: boolean;
  committed: boolean;
  senderHex?: string;
  tag?: number;
  assets: Array<{ faucetHex: string; amount: bigint }>;
}

/** A note as the node serves it by id; `found: false` until a block includes it. */
export async function note(
  rpcUrl: string,
  noteId: Hex,
  run: ChainEvidenceRunner = runChainEvidence
): Promise<MidenNoteRead> {
  const what = 'note';
  const out = await evidence(run, ['note', rpcUrl, noteId]);
  const assets = field(out, 'assets', what);
  if (!Array.isArray(assets)) throw new Error(`usdcx-chain-evidence ${what}: assets is not a list`);
  const senderHex = out.senderHex;
  const tag = out.tag;
  return {
    noteId: hexField(out, 'noteId', what),
    found: field(out, 'found', what) === true,
    committed: field(out, 'committed', what) === true,
    senderHex: typeof senderHex === 'string' ? senderHex : undefined,
    tag: typeof tag === 'number' ? tag : undefined,
    assets: assets.map(asset => {
      if (!isRecord(asset)) throw new Error(`usdcx-chain-evidence ${what}: an asset is not an object`);
      return { faucetHex: textField(asset, 'faucetHex', what), amount: unitsField(asset, 'amount', what) };
    })
  };
}

/** Whether a public note's nullifier is committed, and in which block. */
export async function nullifier(
  rpcUrl: string,
  noteId: Hex,
  run: ChainEvidenceRunner = runChainEvidence
): Promise<{ committed: boolean; blockNum?: number }> {
  const out = await evidence(run, ['nullifier', rpcUrl, noteId]);
  const blockNum = out.blockNum;
  return {
    committed: field(out, 'committed', 'nullifier') === true,
    blockNum: typeof blockNum === 'number' ? blockNum : undefined
  };
}

/** Best-effort: the public notes the faucet sent to the account's tag since `sinceBlock`; [] on any oracle error. */
export async function recentNotes(
  rpcUrl: string,
  args: { faucetBech32: string; accountBech32: string; sinceBlock: number },
  run: ChainEvidenceRunner = runChainEvidence
): Promise<Hex[]> {
  try {
    const out = await evidence(run, [
      'recent-notes',
      rpcUrl,
      bareId(args.faucetBech32),
      bareId(args.accountBech32),
      String(args.sinceBlock)
    ]);
    const ids = field(out, 'noteIds', 'recent-notes');
    return Array.isArray(ids) ? ids.filter((id): id is Hex => typeof id === 'string' && isHex(id)) : [];
  } catch {
    return [];
  }
}

/**
 * Polls `note(mintNoteId)` until the node has it. The timeout names Circle's relayer and the USDCx faucet (never the
 * public faucet), the deposit hash, the nonce, the derived id, and the faucet's recent notes to the account.
 */
export async function waitForUsdcxMint(
  rpcUrl: string,
  args: {
    mintNoteId: Hex;
    depositHash: Hash;
    nonce: Hex;
    faucetBech32: string;
    accountBech32: string;
    sinceBlock: number;
    timeoutMs: number;
    pollMs?: number;
  },
  deps: { run?: ChainEvidenceRunner; clock?: ArcClock } = {}
): Promise<MidenNoteRead> {
  const run = deps.run ?? runChainEvidence;
  const clock = deps.clock ?? realArcClock;
  const deadline = clock.now() + args.timeoutMs;
  let lastError = '';
  for (;;) {
    try {
      const read = await note(rpcUrl, args.mintNoteId, run);
      if (read.found) return read;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (clock.now() >= deadline) break;
    await clock.sleep(args.pollMs ?? 3_000);
  }
  const recent = await recentNotes(rpcUrl, args, run);
  throw new Error(
    `Circle's relayer has not minted deposit ${args.depositHash} through the USDCx faucet ${bareId(args.faucetBech32)} ` +
      `within ${args.timeoutMs} ms.\n` +
      `  nonce: ${args.nonce}\n` +
      `  derived mint note id: ${args.mintNoteId}\n` +
      `  the faucet's notes to ${bareId(args.accountBech32)} since block ${args.sinceBlock}: ` +
      `${recent.length === 0 ? 'none' : recent.join(', ')}` +
      (lastError ? `\n  last oracle error: ${lastError}` : '')
  );
}

/**
 * Q5(d): the fee of a landed path, which records none. Both terms are signed debits: `vaultDelta` is the vault before
 * minus after, `knownTerms` every other debit (a credit counts negative). A burn: V1 - V2 and N + s. A consume of M:
 * V2 - V3 and -M. Throws unless 0 < fee <= baseFee x FEE_RESERVE_MULTIPLE.
 */
export function boundLandedFee(args: { vaultDelta: bigint; knownTerms: bigint; baseFee: number }): {
  fee: bigint;
  ceiling: bigint;
} {
  const fee = args.vaultDelta - args.knownTerms;
  const ceiling = BigInt(args.baseFee) * BigInt(FEE_RESERVE_MULTIPLE);
  if (fee <= 0n || fee > ceiling) {
    throw new Error(
      `landed-path fee ${fee} (vault delta ${args.vaultDelta} minus known terms ${args.knownTerms}) is outside ` +
        `(0, ${ceiling}], the bound baseFee ${args.baseFee} x ${FEE_RESERVE_MULTIPLE}`
    );
  }
  return { fee, ceiling };
}
```

- [ ] **Step 5: Run it and see it pass.** Same command. Expected: `Tests: 18 passed, 18 total` (the last five spawn the real oracle on the installed SDK and read no network; they take under 2 s).

- [ ] **Step 6: Validate against testnet (read-only, network).** From the repo root:

```bash
M=playwright/e2e/helpers/usdcx-chain-evidence.mjs; R=https://rpc.testnet.miden.io
node $M note $R 0xbf203bedf0b053a692a4340d9cc17f71cb84deb4c75b4bacbdda406e0fb14f93
node $M nullifier $R 0xbf203bedf0b053a692a4340d9cc17f71cb84deb4c75b4bacbdda406e0fb14f93
node $M burn-evidence $R mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0 0xa6101e78b77fd80073e0e8b439d26349f3b664e09ef4675301815749acea3c7d mtst1arhxfve58v4l9qfckz58x86j6c59evpr 26 0xfEC2B02f01B3F46F25d604d0451D2a6876b12D7E 10000000
node $M recent-notes $R mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0 mtst1azx6jytj04d48yt09s3pcqxqjyal7kas 81100
node $M supply $R mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0
```

Expected, line by line: `{"noteId":"0xbf20...4f93","found":true,"committed":true,"senderHex":"0x4cbdcaffe75f0a317482224dae6436","tag":2376597504,"assets":[{"faucetHex":"0x4cbdcaffe75f0a317482224dae6436","amount":"2000000000"}]}`; `{"committed":true,"blockNum":81204}`; `{"noteId":"0xa610...3c7d","amount":"10000000","tag":1112887886,"scriptRoot":"0x3d951250cb118282a37b8ee9395f3e3b3c30fab4dbe8c6b0093acfeed3ba04af","senderHex":"0xee64b3343b2bf28138b0a8731f52d6","domain":26,"recipient":"0xfec2b02f01b3f46f25d604d0451d2a6876b12d7e","sponsorshipUnits":"119","status":"NullifierCommitted","nullifierCommitted":true,"consumeBlock":113796,"consumeTimestampSec":1791638693,"attemptCount":0}`; a `noteIds` list whose first entry is `0xbf203bed...4f93`; a `supply` decimal string. A mismatch means the oracle or the node changed: stop and report, never loosen a check.

- [ ] **Step 7: List every caller of the oracle.**

```bash
git grep -l -e 'usdcx-chain-evidence' -- playwright scripts
```

Expected, exactly: `playwright/e2e/helpers/usdcx-chain-evidence.mjs`, `playwright/e2e/helpers/usdcx-miden.test.ts`, `playwright/e2e/helpers/usdcx-miden.ts` and `playwright/e2e/tests/bridge/bridge-out-usdcx.spec.ts`. The last one is the positional caller the intro names; any other file is a caller this task must move to a subcommand before going on.

- [ ] **Step 8: Format and lint.**

```bash
npx prettier --write playwright/e2e/helpers/usdcx-chain-evidence.mjs playwright/e2e/helpers/usdcx-miden.ts playwright/e2e/helpers/usdcx-miden.test.ts
npx eslint --max-warnings 0 playwright/e2e/helpers/usdcx-chain-evidence.mjs playwright/e2e/helpers/usdcx-miden.ts playwright/e2e/helpers/usdcx-miden.test.ts
```

- [ ] **Step 9: Commit deferred to Task 24 (p3-arc).**

---

### Task 24: Arc Testnet legs in arc-usdcx.ts: keys, payout gate, deposit, attestation (p3-arc)

Every Arc leg of spec 5 steps 2, 5, 8, 9, 11 and 12, with viem; the tests drive real viem clients over a stub EIP-1193 provider (`custom` transport), so viem's own encoding, formatting and revert decoding run in every test. The vectors are public chain data captured read-only from Arc Testnet: the six Miden-sourced Gateway payouts of 2026-10-08 to 2026-10-10 (the 1, 10, 80.000001, 2 and 1 USDCx burns and the spike's 10 USDCx), each with its `AttestationUsed` log and `gatewayMint` transaction, and the `0x370bf19a` deposit receipt. Every payout's TransferSpec salt (offset 304 of the TransferSpec inside the calldata) is the burn note id, each a public burn note on testnet whose amount minus the payout is 16_400. This task makes commit 9.

Facts this code relies on, all read on 2026-10-10:
- xReserve's implementation ABI (Blockscout, implementation `0xee16dC8F...DF34` behind `0x0088...4442`): `getRemoteDomainDepositor(uint32)` returns an `address` (not a bytes32); `readXReserveDomainState` pads it, so `depositor` stays the contract's lowercase bytes32 (`0x000...b21c91a0f4d4c03f4b6a0fc5214f06e431ff2b2d`); the event is `DepositedToRemote(address indexed localToken, uint256 value, address indexed localDepositor, bytes32 indexed remoteRecipient, uint32 remoteDomain, bytes32 remoteToken, uint256 maxFee, bytes hookData)` (topic `0x2eef4ec6...e563`); the pause errors are `EnforcedPause()`, `DomainDepositsPaused(uint32)`, `DomainWithdrawalsPaused(uint32)`.
- GatewayMinter (implementation `0x9EF4...84bF`): `AttestationUsed(address indexed token, address indexed recipient, bytes32 indexed transferSpecHash, uint32 sourceDomain, bytes32 sourceDepositor, bytes32 sourceSigner, uint256 value)`; `gatewayMint(bytes attestationPayload, bytes signature)`.
- drpc's range refusal is `{"code":35,"message":"ranges over 10000 blocks are not supported on free plan"}` for a 1000-block window; 100 blocks pass. QuickNode and arc.io answered a 6000-block window.
- All three endpoints answer `eth_sendRawTransaction("0x00")` with `-32602 failed to decode signed transaction` and an unknown method with `-32601`, which is how `submitDepositToMiden` picks its write endpoint. Spike v2 sent its approve and deposit through arc.io: approve 55_426 gas and deposit 132_445 gas at 25 gwei, 0.0047 USDC in all, under `GAS_RESERVE_UNITS`. (spike-dependent: which endpoint accepts raw transactions; the probe adapts.)
- Circle's attestation of `0x370bf19a`: 240 bytes, `keccak256(payload) == messageHash`, and `recoverAddress({ hash: messageHash, signature })` (no EIP-191 prefix) is `0xad1b523Cf15F086EB4CE54A1eF1DE2D13Fd38816`.

**Files:**
- Create: `playwright/e2e/helpers/arc-usdcx.ts`
- Create: `playwright/e2e/helpers/arc-usdcx.vectors.json`
- Modify: `playwright/e2e/helpers/arc-usdcx.test.ts` (imports :1-25, append)

**Interfaces:**
- Consumes: usdcx-constants.ts (all Arc constants, `realArcClock`, `ArcClock`); `fetchXReserveAttestations(txHash: Hash, opts?: { baseUrl?: string; timeoutMs?: number }): Promise<XReserveAttestation[]>` and `XReserveAttestation` (src/lib/usdcx/attestation.ts:10-19, :55-78); `midenAccountHexToXReserveRecipient(hexId: string): Hex` (src/lib/usdcx/recipient.ts:19); `ARC_TESTNET` (walletconnect/config.ts:12-19); `src/lib/usdcx/attestation.vectors.json` (p1 commit 1, the verbatim body `{ "attestations": [ { remoteDomain, payload, messageHash, attestation } ] }`).
- Produces (contract 3.2): `interface ArcKey`, `newArcKey(): ArcKey`, `interface ArcKeyLedgerEntry`, `recordArcKey(key, walletAddress, opts?: { dir?: string; now?: () => Date }): string`, `arcEndpoints(override?: string): string[]`, `ArcClock` and `realArcClock` (re-exported), `type ArcPublicClientFactory = (endpoint: string) => PublicClient`, `interface ArcReadDeps { endpoints: readonly string[]; publicClient?: ArcPublicClientFactory; clock?: ArcClock }`, `readArcUsdc(address: Address, deps: ArcReadDeps, blockNumber?: bigint): Promise<bigint>`, `interface XReserveDomainState`, `readXReserveDomainState(deps): Promise<XReserveDomainState>`, `interface ScannedRange`, `interface ArcLogScan`, `scanArcLogs(client: PublicClient, endpoint: string, query: { address: Address; topics: readonly (Hex | null)[]; fromBlock: bigint; toBlock: bigint; chunk: number }): Promise<ArcLogScan>`, `interface GatewayPayout`, `type PayoutGateFailure`, `class PayoutGateError extends Error { failure; details }`, `interface GatewayPayoutArgs` (the contract's inline `args`, exported), `waitForGatewayPayout(args: GatewayPayoutArgs, deps: ArcReadDeps): Promise<GatewayPayout>`, `type ArcWriteDeps = ArcReadDeps`, `interface DepositSubmission`, `submitDepositToMiden(args: { privateKey: Hex; units: bigint; recipientHex: string; approve: 'exact' | 'if-short' }, deps: ArcWriteDeps): Promise<DepositSubmission>`, `interface DepositedToRemoteEvent`, `confirmDepositToMiden(submission, deps: ArcReadDeps): Promise<{ approveBlock?: bigint; depositBlock: bigint; event: DepositedToRemoteEvent; gasCostWei: bigint }>`, `waitForXReserveAttestation(depositHash: Hash, opts: { baseUrl; timeoutMs; pollMs?; clock?; fetchList? }): Promise<XReserveAttestation>`, `interface DecodedDepositIntent`, `decodeDepositIntent(payload: Hex): DecodedDepositIntent`, `assertDepositIntent(attestation, expected): Promise<{ intent: DecodedDepositIntent; signer: Address }>` (async: viem's `recoverAddress` is async). Extra exports: `XRESERVE_HARNESS_ABI`, `LATE_PAYOUT_NOTE`, `errorText(error: unknown): string`.

- [ ] **Step 1: Capture the vectors.** Save this script OUTSIDE the repo (the session scratchpad), not committed:

```js
// Writes playwright/e2e/helpers/arc-usdcx.vectors.json from public Arc Testnet chain data (read-only).
import { writeFileSync } from 'node:fs';

const RPC = 'https://rpc.drpc.testnet.arc.io';
const GATEWAY_MINTER = '0x0022222abe238cc2c7bb1f21003f0a260052475b';
const ATTESTATION_USED = '0xbb312ce0cc311b2cb0746e09ccd2f91fdb9e2ac755d2f11c65300eb0d0fffd63';
const PAYOUTS = [
  { tx: '0xd453e7f23df547cce9200f3e9084feac3287158adbee5d8eb1f19a1c6d4e1482', burnNoteId: '0x106f7eff46d6571ed74259de4cc452502e9f5c91c561639f9b0ce83d8073bc9f', burnUnits: '1000000' },
  { tx: '0xbade16d7aa2ecc3f157c1782c33e30cf15c72a471930422129d403fa837de3b2', burnNoteId: '0x013cb30c483da6fdc7f5298933b58badbe892366b558125c85a594114b5f6585', burnUnits: '10000000' },
  { tx: '0x5543f9ee91c018835580e5c609a8672d77ef58341fd4197a326ded102484f55b', burnNoteId: '0x92dd81a71d64b7ef12eb82d9d968377f3e3282e1970f53842df27678bc5b0977', burnUnits: '80000001' },
  { tx: '0xea3f5f07284fd61648ce347e5b791e09f3de46ddcc214f71cab6a64162f9412c', burnNoteId: '0xb06c8be1db5521a6da9eeb51d90e45fb2b5ad5811c652d1d855210aa06ca73d2', burnUnits: '2000000' },
  { tx: '0x0c3b1891f31074c77d39fc0abac410fa6dee5e9d9ffcb67ac2c7ffe49552583c', burnNoteId: '0x8a4f299eb98f96bcbe6bdca48fb8185d68af98405b193dfdbe67dbdd8aa0dd32', burnUnits: '1000000' },
  { tx: '0x9a2e63ab0d73f03cc9e5b917ca815f875f68d8487ff229fe0f08899a9c7a202d', burnNoteId: '0xa6101e78b77fd80073e0e8b439d26349f3b664e09ef4675301815749acea3c7d', burnUnits: '10000000' }
];
const DEPOSIT_TX = '0x370bf19aefa34f6f07d7b731d5b5f323a364c6f4116a22768d4e44a16ffeca4d';
const TX_KEYS = ['blockHash', 'blockNumber', 'from', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'hash', 'input', 'nonce', 'to', 'transactionIndex', 'value', 'type', 'chainId', 'v', 'r', 's'];
const LOG_KEYS = ['address', 'topics', 'data', 'blockNumber', 'transactionHash', 'transactionIndex', 'blockHash', 'logIndex', 'removed'];
const RECEIPT_KEYS = ['blockHash', 'blockNumber', 'contractAddress', 'cumulativeGasUsed', 'effectiveGasPrice', 'from', 'gasUsed', 'logs', 'status', 'to', 'transactionHash', 'transactionIndex', 'type'];

async function rpc(method, params) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const body = await response.json();
    if (body.result !== undefined && body.result !== null) return body.result;
    if (attempt >= 5) throw new Error(`${method} ${JSON.stringify(params)}: ${JSON.stringify(body.error ?? body)}`);
    await new Promise(resolve => setTimeout(resolve, 2_000 * attempt));
  }
}
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, lower(key, value[key])]));
const lower = (key, value) => (['address', 'from', 'to'].includes(key) && typeof value === 'string' ? value.toLowerCase() : value);

const payouts = [];
for (const { tx, burnNoteId, burnUnits } of PAYOUTS) {
  const transaction = await rpc('eth_getTransactionByHash', [tx]);
  const receipt = await rpc('eth_getTransactionReceipt', [tx]);
  const logs = receipt.logs.filter(log => log.address.toLowerCase() === GATEWAY_MINTER && log.topics[0] === ATTESTATION_USED);
  if (logs.length !== 1) throw new Error(`${tx}: ${logs.length} AttestationUsed logs`);
  const block = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
  const value = BigInt(`0x${logs[0].data.slice(2 + 64 * 3, 2 + 64 * 4)}`);
  if (!transaction.input.toLowerCase().includes(burnNoteId.slice(2))) throw new Error(`${tx}: calldata lacks ${burnNoteId}`);
  payouts.push({
    burnNoteId,
    burnUnits,
    recipient: `0x${logs[0].topics[2].slice(26)}`,
    value: value.toString(),
    fee: (BigInt(burnUnits) - value).toString(),
    blockTimestamp: Number(BigInt(block.timestamp)),
    log: pick(logs[0], LOG_KEYS),
    transaction: pick(transaction, TX_KEYS)
  });
}
const depositReceipt = await rpc('eth_getTransactionReceipt', [DEPOSIT_TX]);
const vectors = {
  source: 'Arc Testnet (chain 5042002) via rpc.drpc.testnet.arc.io, captured 2026-10-10; public chain data only',
  gatewayMinter: GATEWAY_MINTER,
  remoteDomainDepositor: '0x000000000000000000000000b21c91a0f4d4c03f4b6a0fc5214f06e431ff2b2d',
  payouts,
  deposit: {
    transactionHash: DEPOSIT_TX,
    receipt: { ...pick(depositReceipt, RECEIPT_KEYS), logs: depositReceipt.logs.map(log => pick(log, LOG_KEYS)) }
  }
};
writeFileSync(process.argv[2], `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`${payouts.length} payouts, deposit block ${BigInt(depositReceipt.blockNumber)}`);
```

Run it from the repo root (read-only, network):

```bash
node <scratchpad>/capture-arc-vectors.mjs playwright/e2e/helpers/arc-usdcx.vectors.json
shasum -a 256 playwright/e2e/helpers/arc-usdcx.vectors.json
```

Expected: `6 payouts, deposit block 66290091`, then (informational) `44f1e894a39240bbba6208c66d4695beca28507ebd2fe9b9ae60bb5da94348cd`, the hash two captures gave on 2026-10-10. The gate is semantic, since an RPC may serve the same chain data with other field order or formatting:

```bash
node -e '
const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const topic = "0xbb312ce0cc311b2cb0746e09ccd2f91fdb9e2ac755d2f11c65300eb0d0fffd63";
const problems = [];
if (v.payouts.length !== 6) problems.push("payouts " + v.payouts.length);
for (const p of v.payouts) {
  if (BigInt(p.value) + BigInt(p.fee) !== BigInt(p.burnUnits)) problems.push(p.burnNoteId + " value+fee");
  if (p.log.topics[0] !== topic) problems.push(p.burnNoteId + " topic");
  if (!p.transaction.input.toLowerCase().includes(p.burnNoteId.slice(2).toLowerCase())) problems.push(p.burnNoteId + " calldata");
}
if (BigInt(v.deposit.receipt.blockNumber) !== 66290091n) problems.push("deposit block");
console.log(problems.length === 0 ? "vectors ok" : "vectors WRONG: " + problems.join(", "));
process.exit(problems.length === 0 ? 0 : 1);
' playwright/e2e/helpers/arc-usdcx.vectors.json
```

Expected: `vectors ok`. A different hash with `vectors ok` is fine; Step 5 then proves the data against every test. `vectors WRONG` means drpc served different chain data: stop and report, never edit the file by hand. (The drafting session kept a copy in its own scratchpad; it is not a plan input.) Never run prettier on this JSON: it is data.

- [ ] **Step 2: Write the failing test.** In `playwright/e2e/helpers/arc-usdcx.test.ts` (the first task wrote it), replace lines 1-25 (the docblock and the import of `./usdcx-constants`, up to `} from './usdcx-constants';`) with:

```ts
/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  hexToBigInt,
  isAddress,
  isHex,
  keccak256,
  parseAbi,
  parseTransaction,
  toBytes,
  toHex,
  type Address,
  type Hex,
  type PublicClient
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  arcEndpoints,
  assertDepositIntent,
  confirmDepositToMiden,
  decodeDepositIntent,
  LATE_PAYOUT_NOTE,
  newArcKey,
  PayoutGateError,
  readArcUsdc,
  readXReserveDomainState,
  recordArcKey,
  scanArcLogs,
  submitDepositToMiden,
  waitForGatewayPayout,
  waitForXReserveAttestation,
  XRESERVE_HARNESS_ABI,
  type ArcClock
} from './arc-usdcx';
import arcVectors from './arc-usdcx.vectors.json';
import {
  ARC_ATTESTATION_API,
  ARC_CHAIN_ID,
  ARC_CIRCLE_DOMAIN,
  ARC_DRPC_URL,
  ARC_KEY_LEDGER_DIR,
  ARC_PUBLIC_URL,
  ARC_QUICKNODE_URL,
  ARC_USDC,
  ARC_XRESERVE,
  ATTESTATION_USED_TOPIC,
  BURN_UNITS,
  DEFAULT_ARC_RPCS,
  DEPOSIT_UNITS,
  GAS_RESERVE_UNITS,
  GATEWAY_MINTER,
  GRANT_MARGIN_UNITS,
  minimumUsdcxPayout,
  PAYOUT_TIMEOUT_MS
} from './usdcx-constants';
import type { XReserveAttestation } from '../../../src/lib/usdcx/attestation';
import attestationVectors from '../../../src/lib/usdcx/attestation.vectors.json';
import { midenAccountHexToXReserveRecipient } from '../../../src/lib/usdcx/recipient';
import { ARC_TESTNET } from '../../../src/lib/walletconnect/config';

function addressOf(value: string): Address {
  if (!isAddress(value, { strict: false })) throw new Error(`${value} is not an address`);
  return value;
}

function hexOf(value: string): Hex {
  if (!isHex(value)) throw new Error(`${value} is not hex`);
  return value;
}
```

keep the `usdcx-constants` describe that follows unchanged, and append at the end of the file, after one blank line:

```ts
type Rpc = (method: string, params: readonly unknown[]) => unknown;

/** A real viem client over a stub EIP-1193 provider, so viem's own encoding and decoding run in every test. */
function stubClient(rpc: Rpc, calls: string[] = []): PublicClient {
  return createPublicClient({
    chain: ARC_TESTNET,
    cacheTime: 0,
    transport: custom(
      {
        async request({ method, params }: { method: string; params?: unknown }) {
          calls.push(method);
          return rpc(method, Array.isArray(params) ? params : []);
        }
      },
      { retryCount: 0 }
    )
  });
}

function rpcError(code: number, message: string, data?: Hex): Error {
  return Object.assign(new Error(message), { code, data });
}

const CALL_ABI = [
  ...XRESERVE_HARNESS_ABI,
  ...parseAbi([
    'function balanceOf(address account) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)'
  ])
];

function callOf(params: readonly unknown[]): { functionName: string; args: readonly unknown[]; block: unknown } {
  const [request, block] = params;
  const data: unknown = request !== null && typeof request === 'object' ? Reflect.get(request, 'data') : undefined;
  if (!isHex(data)) throw new Error('eth_call without data');
  const decoded = decodeFunctionData({ abi: CALL_ABI, data });
  return { functionName: decoded.functionName, args: decoded.args ?? [], block };
}

const encodeUint = (value: bigint) => encodeAbiParameters([{ type: 'uint256' }], [value]);
const encodeBool = (value: boolean) => encodeAbiParameters([{ type: 'bool' }], [value]);

function fakeClock(start = 0): ArcClock & { slept: number[] } {
  let now = start;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: async ms => {
      slept.push(ms);
      now += ms;
    }
  };
}

function payoutAt(index: number): (typeof arcVectors.payouts)[number] {
  const payout = arcVectors.payouts[index];
  if (!payout) throw new Error(`arc-usdcx.vectors.json has no payout ${index}`);
  return payout;
}

const SPIKE = payoutAt(5);
const DEPOSIT_RECEIPT = arcVectors.deposit.receipt;
const [CAPTURED] = attestationVectors.attestations;

function capturedAttestation(): XReserveAttestation {
  if (!CAPTURED || !isHex(CAPTURED.payload) || !isHex(CAPTURED.messageHash) || !isHex(CAPTURED.attestation)) {
    throw new Error('attestation.vectors.json lost its captured entry');
  }
  return {
    payload: CAPTURED.payload,
    messageHash: CAPTURED.messageHash,
    attestation: CAPTURED.attestation,
    remoteDomain: CAPTURED.remoteDomain
  };
}

describe('newArcKey and recordArcKey', () => {
  it('makes a fresh key whose address derives from it', () => {
    const first = newArcKey();
    const second = newArcKey();
    expect(first.address).toBe(privateKeyToAccount(first.privateKey).address);
    expect(second.privateKey).not.toBe(first.privateKey);
  });

  it('writes the ledger entry 0600 into a 0700 directory, and never over an existing entry', () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arc-ledger-')), 'arc-keys');
    const key = newArcKey();
    const now = () => new Date('2026-10-10T13:24:42.476Z');

    const file = recordArcKey(key, 'mtst1are0gtx635qs7starjk4m3x49vcm0w2g_qr7qqq9wr6w', { dir, now });

    expect(path.basename(file)).toBe(`2026-10-10T13-24-42-476Z-${key.address}.json`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      iso: '2026-10-10T13:24:42.476Z',
      address: key.address,
      privateKey: key.privateKey,
      walletAddress: 'mtst1are0gtx635qs7starjk4m3x49vcm0w2g_qr7qqq9wr6w'
    });
    expect(() => recordArcKey(key, 'other', { dir, now })).toThrow('EEXIST');
  });
});

describe('arcEndpoints', () => {
  it('puts the operator endpoint first and keeps the defaults after it, once each', () => {
    expect(arcEndpoints()).toEqual([ARC_DRPC_URL, ARC_QUICKNODE_URL, ARC_PUBLIC_URL]);
    expect(arcEndpoints(' https://arc.example ')).toEqual([
      'https://arc.example',
      ARC_DRPC_URL,
      ARC_QUICKNODE_URL,
      ARC_PUBLIC_URL
    ]);
    expect(arcEndpoints(ARC_PUBLIC_URL)).toEqual([ARC_PUBLIC_URL, ARC_DRPC_URL, ARC_QUICKNODE_URL]);
  });

  it('refuses an override that is set but empty', () => {
    expect(() => arcEndpoints('')).toThrow('E2E_ARC_RPC_URL is set but empty');
    expect(() => arcEndpoints('   ')).toThrow('E2E_ARC_RPC_URL is set but empty');
  });
});

describe('readArcUsdc', () => {
  it('moves to the next endpoint when one fails, and reads at the block it is given', async () => {
    const calls: string[] = [];
    const blocks: unknown[] = [];
    const clients: Record<string, PublicClient> = {
      'https://a': stubClient(() => {
        throw rpcError(-32005, 'rate limit exceeded');
      }, calls),
      'https://b': stubClient((_method, params) => {
        const call = callOf(params);
        blocks.push(call.block);
        return encodeUint(9_983_600n);
      }, calls)
    };
    const balance = await readArcUsdc(
      addressOf(SPIKE.recipient),
      {
        endpoints: ['https://a', 'https://b'],
        publicClient: endpoint => clients[endpoint] ?? stubClient(() => null)
      },
      66483812n
    );
    expect(balance).toBe(9_983_600n);
    expect(calls).toEqual(['eth_call', 'eth_call']);
    expect(blocks).toEqual(['0x3f67664']);
  });

  it('names every endpoint when none answers', async () => {
    const failing = stubClient(() => {
      throw rpcError(-32005, 'rate limit exceeded');
    });
    await expect(
      readArcUsdc(ARC_USDC, { endpoints: ['https://a', 'https://b'], publicClient: () => failing })
    ).rejects.toThrow(/no Arc endpoint answered\n {2}https:\/\/a: .*rate limit exceeded\n {2}https:\/\/b: /);
  });
});

describe('readXReserveDomainState', () => {
  it("reads Miden's domain on one endpoint, the token lowercased and the depositor as a bytes32", async () => {
    const answers: Record<string, Hex> = {
      isRemoteDomainRegistered: encodeBool(true),
      paused: encodeBool(false),
      domainDepositsPaused: encodeBool(false),
      domainWithdrawalsPaused: encodeBool(false),
      getRemoteToken: '0x000000000000000000000000000000004CBDCAFFE75F0A317482224DAE643600',
      getRemoteDomainDepositor: encodeAbiParameters(
        [{ type: 'address' }],
        ['0xb21c91a0f4d4c03f4b6a0fc5214f06e431ff2b2d']
      ),
      gatewayMinter: encodeAbiParameters([{ type: 'address' }], [GATEWAY_MINTER])
    };
    const asked: string[] = [];
    const client = stubClient((_method, params) => {
      const call = callOf(params);
      asked.push(`${call.functionName}(${call.args.map(String).join(',')})`);
      return answers[call.functionName];
    });

    const state = await readXReserveDomainState({ endpoints: [ARC_DRPC_URL], publicClient: () => client });

    expect(state).toEqual({
      endpoint: ARC_DRPC_URL,
      registered: true,
      paused: false,
      depositsPaused: false,
      withdrawalsPaused: false,
      remoteToken: '0x000000000000000000000000000000004cbdcaffe75f0a317482224dae643600',
      depositor: arcVectors.remoteDomainDepositor,
      gatewayMinter: GATEWAY_MINTER
    });
    expect(asked).toEqual([
      'isRemoteDomainRegistered(10007)',
      'paused()',
      'domainDepositsPaused(10007)',
      'domainWithdrawalsPaused(10007)',
      `getRemoteToken(10007,${ARC_USDC})`,
      'getRemoteDomainDepositor(10007)',
      'gatewayMinter()'
    ]);
  });
});

function filterOf(params: readonly unknown[]): { from: bigint; to: bigint; topics: unknown[] } {
  const [filter] = params;
  if (filter === null || typeof filter !== 'object') throw new Error('eth_getLogs without a filter');
  const from: unknown = Reflect.get(filter, 'fromBlock');
  const to: unknown = Reflect.get(filter, 'toBlock');
  const topics: unknown = Reflect.get(filter, 'topics');
  if (!isHex(from) || !isHex(to)) throw new Error('eth_getLogs without a block range');
  return { from: hexToBigInt(from), to: hexToBigInt(to), topics: Array.isArray(topics) ? topics : [] };
}

describe('scanArcLogs', () => {
  const query = { address: GATEWAY_MINTER, topics: [ATTESTATION_USED_TOPIC], fromBlock: 1000n, toBlock: 1249n };

  it('walks the range in chunk-block windows and reports each window it covered', async () => {
    const spans: string[] = [];
    const client = stubClient((_method, params) => {
      const { from, to } = filterOf(params);
      spans.push(`${from}-${to}`);
      return from <= 1100n && 1100n <= to ? [SPIKE.log] : [];
    });
    const scan = await scanArcLogs(client, ARC_DRPC_URL, { ...query, chunk: 100 });
    expect(spans).toEqual(['1000-1099', '1100-1199', '1200-1249']);
    expect(scan.logs.map(log => log.transactionHash)).toEqual([SPIKE.transaction.hash]);
    expect(scan.ranges).toEqual([
      { endpoint: ARC_DRPC_URL, fromBlock: 1000n, toBlock: 1099n },
      { endpoint: ARC_DRPC_URL, fromBlock: 1100n, toBlock: 1199n },
      { endpoint: ARC_DRPC_URL, fromBlock: 1200n, toBlock: 1249n }
    ]);
  });

  it("halves the window on drpc's range refusal until it fits, leaving no gap", async () => {
    const spans: bigint[] = [];
    const client = stubClient((_method, params) => {
      const { from, to } = filterOf(params);
      if (to - from + 1n > 25n) throw rpcError(35, 'ranges over 10000 blocks are not supported on free plan');
      spans.push(to - from + 1n);
      return [];
    });
    const scan = await scanArcLogs(client, ARC_DRPC_URL, { ...query, chunk: 100 });
    expect(spans).toEqual(Array(10).fill(25n));
    expect(scan.ranges.map(range => `${range.fromBlock}-${range.toBlock}`)).toEqual(
      Array.from({ length: 10 }, (_, index) => `${1000 + index * 25}-${1024 + index * 25}`)
    );
  });

  it('rethrows an error that is not about the range, at once', async () => {
    const calls: string[] = [];
    const client = stubClient(() => {
      throw rpcError(-32005, 'rate limit exceeded');
    }, calls);
    await expect(scanArcLogs(client, ARC_DRPC_URL, { ...query, chunk: 100 })).rejects.toThrow('rate limit exceeded');
    expect(calls).toEqual(['eth_getLogs']);
  });
});

type CapturedLog = (typeof arcVectors.payouts)[number]['log'];

/** The payout gate's Arc: a head that moves, a scripted balance, and the captured logs and gatewayMint transactions. */
function payoutChain(world: { balances: readonly bigint[]; logs: readonly CapturedLog[]; failLogs?: boolean }): Rpc {
  let head = 66483820n;
  let balanceReads = 0;
  const transactions = new Map<string, unknown>(
    arcVectors.payouts.map(payout => [payout.transaction.hash, payout.transaction])
  );
  return (method, params) => {
    switch (method) {
      case 'eth_blockNumber':
        head += 2n;
        return toHex(head);
      case 'eth_call': {
        const balance = world.balances[Math.min(balanceReads, world.balances.length - 1)] ?? 0n;
        balanceReads += 1;
        return encodeUint(balance);
      }
      case 'eth_getLogs': {
        if (world.failLogs) throw rpcError(-32603, 'internal error');
        const { from, to, topics } = filterOf(params);
        return world.logs.filter(log => {
          const block = BigInt(log.blockNumber);
          return (
            block >= from &&
            block <= to &&
            topics.every(
              (topic, index) => topic === null || String(topic).toLowerCase() === log.topics[index]?.toLowerCase()
            )
          );
        });
      }
      case 'eth_getTransactionByHash':
        return transactions.get(String(params[0])) ?? null;
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
}

/** A captured log moved to another block, so it falls inside a scan that the original does not. */
const movedTo = (log: CapturedLog, block: bigint): CapturedLog => ({ ...log, blockNumber: toHex(block) });

describe('waitForGatewayPayout', () => {
  const CONSUME_MS = 1_791_638_693_000;
  const args = {
    recipient: addressOf(SPIKE.recipient),
    burnNoteId: hexOf(SPIKE.burnNoteId),
    burnUnits: BigInt(SPIKE.burnUnits),
    fromBlock: 66483700n,
    consumeTsMs: CONSUME_MS,
    deadlineMs: CONSUME_MS + PAYOUT_TIMEOUT_MS,
    depositor: hexOf(arcVectors.remoteDomainDepositor),
    minimumValue: minimumUsdcxPayout(ARC_CHAIN_ID, BURN_UNITS)
  };
  // Another recipient's payout inside the scanned range: only the recipient topic keeps it out.
  const neighbour = movedTo(payoutAt(1).log, 66483790n);

  it('proves the spike payout: one AttestationUsed for the key, its value the balance, the note id in the calldata', async () => {
    const clock = fakeClock(CONSUME_MS + 12_000);
    const chain = payoutChain({ balances: [0n, 9_983_600n], logs: [SPIKE.log, neighbour] });

    const payout = await waitForGatewayPayout(args, {
      endpoints: [ARC_DRPC_URL],
      publicClient: () => stubClient(chain),
      clock
    });

    expect(payout).toMatchObject({
      endpoint: ARC_DRPC_URL,
      value: 9_983_600n,
      logBlock: 66483812n,
      transactionHash: SPIKE.transaction.hash,
      sourceDomain: 26,
      sourceDepositor: arcVectors.remoteDomainDepositor,
      fee: 16_400n,
      latencyMs: 17_000
    });
    expect(payout.balanceBlock >= 66483812n).toBe(true);
    expect(clock.slept).toEqual([5_000]);
    // drpc: 100-block windows from the snapshot block to B.
    expect(payout.ranges[0]).toEqual({ endpoint: ARC_DRPC_URL, fromBlock: 66483700n, toBlock: 66483799n });
  });

  it.each(arcVectors.payouts.map(payout => [payout.burnUnits, payout]))(
    'correlates the captured payout of a %s-unit burn, Circle keeping 16400',
    async (_units, payout) => {
      const block = BigInt(payout.log.blockNumber);
      const correlated = await waitForGatewayPayout(
        {
          ...args,
          recipient: addressOf(payout.recipient),
          burnNoteId: hexOf(payout.burnNoteId),
          burnUnits: BigInt(payout.burnUnits),
          fromBlock: block - 50n,
          minimumValue: minimumUsdcxPayout(ARC_CHAIN_ID, BigInt(payout.burnUnits))
        },
        {
          endpoints: [ARC_QUICKNODE_URL],
          publicClient: () =>
            stubClient(payoutChain({ balances: [BigInt(payout.value)], logs: [movedTo(payout.log, 66483812n)] })),
          clock: fakeClock(CONSUME_MS)
        }
      );
      expect(correlated.fee).toBe(16_400n);
      expect(correlated.value).toBe(BigInt(payout.value));
    }
  );

  it('fails uncorrelated, at once, when the gatewayMint calldata does not carry this burn', async () => {
    const otherBurn = hexOf(payoutAt(1).burnNoteId);
    const failure = waitForGatewayPayout(
      { ...args, burnNoteId: otherBurn },
      {
        endpoints: [ARC_DRPC_URL],
        publicClient: () => stubClient(payoutChain({ balances: [9_983_600n], logs: [SPIKE.log] })),
        clock: fakeClock(CONSUME_MS)
      }
    );
    await expect(failure).rejects.toThrow(PayoutGateError);
    await expect(failure).rejects.toMatchObject({ failure: 'uncorrelated' });
    await expect(failure).rejects.toThrow(`calldata lacks the burn note id ${otherBurn}`);
    await expect(failure).rejects.toThrow(LATE_PAYOUT_NOTE);
  });

  it('fails uncorrelated on two logs for the key, and on a value that is not the balance', async () => {
    const twice = movedTo(SPIKE.log, 66483810n);
    await expect(
      waitForGatewayPayout(args, {
        endpoints: [ARC_DRPC_URL],
        publicClient: () => stubClient(payoutChain({ balances: [9_983_600n], logs: [SPIKE.log, twice] })),
        clock: fakeClock(CONSUME_MS)
      })
    ).rejects.toThrow('found 2 AttestationUsed logs');
    await expect(
      waitForGatewayPayout(args, {
        endpoints: [ARC_DRPC_URL],
        publicClient: () => stubClient(payoutChain({ balances: [9_983_601n], logs: [SPIKE.log] })),
        clock: fakeClock(CONSUME_MS)
      })
    ).rejects.toThrow('log value 9983600 differs from the balance 9983601');
  });

  it('moves to the next endpoint with a fresh head when one fails', async () => {
    const failing = stubClient(() => {
      throw rpcError(-32005, 'rate limit exceeded');
    });
    const healthy = stubClient(payoutChain({ balances: [9_983_600n], logs: [SPIKE.log] }));
    const payout = await waitForGatewayPayout(args, {
      endpoints: [ARC_PUBLIC_URL, ARC_DRPC_URL],
      publicClient: endpoint => (endpoint === ARC_PUBLIC_URL ? failing : healthy),
      clock: fakeClock(CONSUME_MS)
    });
    expect(payout.endpoint).toBe(ARC_DRPC_URL);
  });

  it('fails no-mint at the deadline when the balance stays zero', async () => {
    const clock = fakeClock(CONSUME_MS);
    const failure = waitForGatewayPayout(args, {
      endpoints: [ARC_DRPC_URL],
      publicClient: () => stubClient(payoutChain({ balances: [0n], logs: [] })),
      clock
    });
    await expect(failure).rejects.toMatchObject({ failure: 'no-mint' });
    await expect(failure).rejects.toThrow(
      `no destination mint for this key by ${new Date(args.deadlineMs).toISOString()}`
    );
    expect(clock.slept).toEqual(Array(PAYOUT_TIMEOUT_MS / 5_000).fill(5_000));
  });

  it('fails scan-gaps when the balance arrived but no scan could run', async () => {
    const failure = waitForGatewayPayout(args, {
      endpoints: [ARC_DRPC_URL],
      publicClient: () => stubClient(payoutChain({ balances: [9_983_600n], logs: [SPIKE.log], failLogs: true })),
      clock: fakeClock(CONSUME_MS)
    });
    await expect(failure).rejects.toMatchObject({ failure: 'scan-gaps' });
    await expect(failure).rejects.toThrow('unknown: scan gaps none');
  });

  it('fails uncorrelated at the deadline when every complete scan finds no log', async () => {
    const failure = waitForGatewayPayout(args, {
      endpoints: [ARC_DRPC_URL],
      publicClient: () => stubClient(payoutChain({ balances: [9_983_600n], logs: [] })),
      clock: fakeClock(CONSUME_MS)
    });
    await expect(failure).rejects.toMatchObject({ failure: 'uncorrelated' });
    await expect(failure).rejects.toThrow('found 0 AttestationUsed logs');
  });
});

/** The write side of Arc: two endpoints, the first refusing raw transactions, the second taking them. */
function depositChain(opts: { allowance: bigint; revert?: Hex; alreadyKnown?: boolean }) {
  const sent: Hex[] = [];
  const nonces: number[] = [];
  const rpc: Rpc = (method, params) => {
    switch (method) {
      case 'eth_chainId':
        return toHex(ARC_CHAIN_ID);
      case 'eth_getTransactionCount':
        return '0x5';
      case 'eth_estimateGas':
        return '0x20551';
      case 'eth_maxPriorityFeePerGas':
        return '0x0';
      case 'eth_getBlockByNumber':
        return {
          number: '0x3f6763c',
          hash: `0x${'11'.repeat(32)}`,
          timestamp: '0x6a87a0a0',
          baseFeePerGas: '0x5d21dba00',
          transactions: []
        };
      case 'eth_call': {
        const call = callOf(params);
        if (call.functionName === 'allowance') return encodeUint(opts.allowance);
        if (call.functionName === 'approve') return encodeBool(true);
        if (opts.revert) throw rpcError(3, 'execution reverted', opts.revert);
        return '0x';
      }
      case 'eth_sendRawTransaction': {
        const raw = params[0];
        if (raw === '0x00') throw rpcError(-32602, 'failed to decode signed transaction');
        if (!isHex(raw)) throw new Error('raw transaction is not hex');
        sent.push(raw);
        nonces.push(parseTransaction(raw).nonce ?? -1);
        if (opts.alreadyKnown && sent.length === 1) throw rpcError(-32000, 'already known');
        return keccak256(raw);
      }
      case 'eth_getTransactionReceipt':
        return { ...DEPOSIT_RECEIPT, transactionHash: params[0], logs: [], status: '0x1' };
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  const refusing = stubClient((method, params) => {
    if (method === 'eth_chainId') return toHex(ARC_CHAIN_ID);
    if (method === 'eth_sendRawTransaction' && params[0] === '0x00') throw rpcError(-32601, 'method not supported');
    throw new Error(`unexpected ${method} on the refusing endpoint`);
  });
  return {
    sent,
    nonces,
    deps: {
      endpoints: ['https://read-only.example', ARC_DRPC_URL],
      publicClient: (endpoint: string) => (endpoint === ARC_DRPC_URL ? stubClient(rpc) : refusing),
      clock: fakeClock()
    }
  };
}

describe('submitDepositToMiden', () => {
  const key = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  const recipientHex = '0xf2f42cda8d010f417d1cad5dc4d52b';

  it('approves exactly the units, then deposits to Miden, on the first endpoint that takes writes', async () => {
    const chain = depositChain({ allowance: 0n });
    const submission = await submitDepositToMiden(
      { privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'exact' },
      chain.deps
    );

    expect(submission.endpoint).toBe(ARC_DRPC_URL);
    expect(submission.approved).toBe(true);
    expect(chain.nonces).toEqual([5, 6]);
    expect([submission.approveHash, submission.depositHash]).toEqual(chain.sent.map(raw => keccak256(raw)));
    const [approve, deposit] = chain.sent.map(raw => parseTransaction(raw));
    expect(approve?.to).toBe(ARC_USDC.toLowerCase());
    expect(decodeFunctionData({ abi: CALL_ABI, data: approve?.data ?? '0x' })).toEqual({
      functionName: 'approve',
      args: [ARC_XRESERVE, DEPOSIT_UNITS]
    });
    expect(deposit?.to).toBe(ARC_XRESERVE.toLowerCase());
    expect(decodeFunctionData({ abi: CALL_ABI, data: deposit?.data ?? '0x' })).toEqual({
      functionName: 'depositToRemote',
      args: [DEPOSIT_UNITS, 10007, midenAccountHexToXReserveRecipient(recipientHex), ARC_USDC, 0n, '0x']
    });
    expect(approve?.chainId).toBe(ARC_CHAIN_ID);
  });

  it("skips the approve when 'if-short' finds the allowance already covers the units", async () => {
    const chain = depositChain({ allowance: DEPOSIT_UNITS });
    const submission = await submitDepositToMiden(
      { privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'if-short' },
      chain.deps
    );
    expect(submission.approved).toBe(false);
    expect(submission.approveHash).toBeUndefined();
    expect(chain.nonces).toEqual([5]);
  });

  it('decodes a deposit revert before sending it', async () => {
    const paused = encodeErrorResult({ abi: XRESERVE_HARNESS_ABI, errorName: 'DomainDepositsPaused', args: [10007] });
    const chain = depositChain({ allowance: DEPOSIT_UNITS, revert: paused });
    await expect(
      submitDepositToMiden({ privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'if-short' }, chain.deps)
    ).rejects.toThrow(`xReserve depositToRemote would revert on ${ARC_DRPC_URL}`);
    await expect(
      submitDepositToMiden({ privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'if-short' }, chain.deps)
    ).rejects.toThrow('DomainDepositsPaused(10007)');
    expect(chain.sent).toEqual([]);
  });

  it("counts a node's 'already known' as sent, by the transaction's own hash", async () => {
    const chain = depositChain({ allowance: DEPOSIT_UNITS, alreadyKnown: true });
    const submission = await submitDepositToMiden(
      { privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'if-short' },
      chain.deps
    );
    expect(submission.depositHash).toBe(keccak256(chain.sent[0] ?? '0x'));
  });
});

describe('confirmDepositToMiden', () => {
  it("reads xReserve's DepositedToRemote from the captured 0x370bf19a receipt", async () => {
    const client = stubClient(method => {
      if (method !== 'eth_getTransactionReceipt') throw new Error(`unexpected ${method}`);
      return DEPOSIT_RECEIPT;
    });
    const confirmed = await confirmDepositToMiden(
      { endpoint: ARC_DRPC_URL, depositHash: hexOf(arcVectors.deposit.transactionHash), approved: false },
      { endpoints: [ARC_DRPC_URL], publicClient: () => client, clock: fakeClock() }
    );
    expect(confirmed).toEqual({
      approveBlock: undefined,
      depositBlock: 66290091n,
      event: {
        value: 2_000_000_000n,
        localDepositor: '0xe88F781e6Cc8B7496F259200b57E22cb9457FF99',
        remoteRecipient: '0x000000000000000000000000000000008da911727d5b53916f2c221c00c09100',
        remoteDomain: 10007,
        remoteToken: '0x000000000000000000000000000000004cbdcaffe75f0a317482224dae643600',
        maxFee: 0n,
        hookData: '0x',
        blockNumber: 66290091n
      },
      gasCostWei: 132433n * 25_000_000_000n
    });
  });

  it('refuses a reverted deposit', async () => {
    const client = stubClient(() => ({ ...DEPOSIT_RECEIPT, status: '0x0' }));
    await expect(
      confirmDepositToMiden(
        { endpoint: ARC_DRPC_URL, depositHash: hexOf(arcVectors.deposit.transactionHash), approved: false },
        { endpoints: [ARC_DRPC_URL], publicClient: () => client, clock: fakeClock() }
      )
    ).rejects.toThrow(`Arc transaction ${arcVectors.deposit.transactionHash} reverted in block 66290091`);
  });
});

describe('waitForXReserveAttestation', () => {
  const hash = hexOf(arcVectors.deposit.transactionHash);

  it("polls Circle until the deposit's Miden entry is listed", async () => {
    const clock = fakeClock();
    const lists = [[], [capturedAttestation()]];
    const asked: string[] = [];
    const attestation = await waitForXReserveAttestation(hash, {
      baseUrl: ARC_ATTESTATION_API,
      timeoutMs: 120_000,
      clock,
      fetchList: async (txHash, { baseUrl }) => {
        asked.push(`${baseUrl} ${txHash}`);
        return lists.shift() ?? [];
      }
    });
    expect(attestation).toEqual(capturedAttestation());
    expect(asked).toEqual([`${ARC_ATTESTATION_API} ${hash}`, `${ARC_ATTESTATION_API} ${hash}`]);
    expect(clock.slept).toEqual([3_000]);
  });

  it('refuses two Miden entries for one deposit', async () => {
    await expect(
      waitForXReserveAttestation(hash, {
        baseUrl: ARC_ATTESTATION_API,
        timeoutMs: 120_000,
        clock: fakeClock(),
        fetchList: async () => [capturedAttestation(), capturedAttestation()]
      })
    ).rejects.toThrow('Circle lists 2 attestations');
  });

  it('names the domains it saw and the last error when none arrives', async () => {
    const answers: Array<XReserveAttestation[] | Error> = [
      [{ ...capturedAttestation(), remoteDomain: 10001 }],
      new Error('HTTP 503')
    ];
    await expect(
      waitForXReserveAttestation(hash, {
        baseUrl: ARC_ATTESTATION_API,
        timeoutMs: 6_000,
        clock: fakeClock(),
        fetchList: async () => {
          const next = answers.shift() ?? [];
          if (next instanceof Error) throw next;
          return next;
        }
      })
    ).rejects.toThrow('0 entries for domain 10007 after 6000 ms (domains listed: [10001]; last error: HTTP 503)');
  });
});

describe('decodeDepositIntent and assertDepositIntent', () => {
  const expected = {
    amount: 2_000_000_000n,
    remoteToken: hexOf('0x000000000000000000000000000000004cbdcaffe75f0a317482224dae643600'),
    remoteRecipient: hexOf('0x000000000000000000000000000000008da911727d5b53916f2c221c00c09100'),
    localToken: ARC_USDC,
    localDepositor: addressOf('0xe88f781e6cc8b7496f259200b57e22cb9457ff99')
  };

  it('reads every field of the captured 0x370bf19a DepositIntent', () => {
    expect(decodeDepositIntent(capturedAttestation().payload)).toEqual({
      magic: '0x5a2e0acd',
      version: 1,
      amount: 2_000_000_000n,
      remoteDomain: 10007,
      remoteToken: '0x000000000000000000000000000000004cbdcaffe75f0a317482224dae643600',
      remoteRecipient: '0x000000000000000000000000000000008da911727d5b53916f2c221c00c09100',
      localToken: '0x0000000000000000000000003600000000000000000000000000000000000000',
      localDepositor: '0x000000000000000000000000e88f781e6cc8b7496f259200b57e22cb9457ff99',
      maxFee: 0n,
      nonce: '0x335d432e805b61478619eced3af4f3d074e217df74d49eb797542275318e8a41',
      hookLength: 0,
      hookData: '0x'
    });
  });

  it('names the field a malformed payload fails on', () => {
    const payload = capturedAttestation().payload;
    expect(() => decodeDepositIntent(hexOf(`0x00000000${payload.slice(10)}`))).toThrow(
      'DepositIntent magic: 0x00000000'
    );
    expect(() => decodeDepositIntent(hexOf(`${payload.slice(0, 10)}00000002${payload.slice(18)}`))).toThrow(
      'DepositIntent version: 2'
    );
    expect(() => decodeDepositIntent(hexOf(`${payload}00`))).toThrow('241 bytes, expected 240 + hookLen 0');
    expect(() => decodeDepositIntent(hexOf(payload.slice(0, -2)))).toThrow('239 bytes, below the 240-byte header');
  });

  it("checks every field against the deposit and recovers Circle's attester", async () => {
    await expect(assertDepositIntent(capturedAttestation(), expected)).resolves.toMatchObject({
      signer: '0xad1b523Cf15F086EB4CE54A1eF1DE2D13Fd38816'
    });
  });

  it('names the field that differs', async () => {
    await expect(
      assertDepositIntent(capturedAttestation(), {
        ...expected,
        remoteRecipient: hexOf('0x00000000000000000000000000000000f2f42cda8d010f417d1cad5dc4d52b00')
      })
    ).rejects.toThrow(
      'remoteRecipient@76: 0x000000000000000000000000000000008da911727d5b53916f2c221c00c09100, expected'
    );
    await expect(
      assertDepositIntent({ ...capturedAttestation(), messageHash: keccak256('0x00') }, expected)
    ).rejects.toThrow('messageHash');
  });
});
```

Mutation notes (constants block as in the first task, plus):
- "makes a fresh key whose address derives from it": return the address of a second `generatePrivateKey()`; the first `toBe` fails.
- "writes the ledger entry 0600 ...": drop `flag: 'wx'`; the second `recordArcKey` does not throw (run in the scratch copy).
- arcEndpoints "puts the operator endpoint first ...": drop the `.filter(...)`; the third `toEqual` sees arc.io twice.
- arcEndpoints "refuses an override that is set but empty": test `override === ''` instead of the trimmed value; `'   '` does not throw.
- readArcUsdc "moves to the next endpoint ...": drop `blockNumber` from the `readContract` call; `blocks` reads `['latest']`.
- readArcUsdc "names every endpoint when none answers": throw `what` alone; the regex fails.
- readXReserveDomainState: drop `pad(...)` around the depositor; `depositor` is a 20-byte address and `toEqual` fails.
- scanArcLogs "walks the range ...": compute `to` as `from + window`; `spans` fails.
- scanArcLogs "halves the window ...": shrink with `window -= 1n` instead of halving; the spans are not ten windows of 25.
- scanArcLogs "rethrows an error that is not about the range, at once": halve on every error; `calls` has more than one `eth_getLogs` (run in the scratch copy).
- waitForGatewayPayout "proves the spike payout ...": pass `null` for the recipient topic; the neighbour's log is found too and it fails `found 2 AttestationUsed logs` (run in the scratch copy).
- waitForGatewayPayout "correlates the captured payout of a %s-unit burn ...": search the calldata for `args.burnNoteId` with its `0x`; all six fail `calldata lacks the burn note id`.
- "fails uncorrelated, at once, when the gatewayMint calldata does not carry this burn": delete the calldata check; the promise resolves.
- "fails uncorrelated on two logs ... and on a value that is not the balance": delete `if (value !== balance)`; the second expectation resolves.
- "moves to the next endpoint with a fresh head when one fails": delete `index += 1`; it keeps the failing endpoint and ends `scan-gaps`.
- "fails no-mint at the deadline ...": delete `state.readOk = true`; the timeout reads `scan-gaps`.
- "fails scan-gaps when the balance arrived but no scan could run": drop `state.firstPaidMs !== undefined ||` from the scan-gaps branch; it ends `no-mint`.
- "fails uncorrelated at the deadline when every complete scan finds no log": delete `state.lastMiss = reason`; it ends `scan-gaps`.
- submitDepositToMiden "approves exactly the units, then deposits ...": delete `nonce += 1`; `nonces` reads `[5, 5]` (run in the scratch copy).
- "skips the approve when 'if-short' ...": set `approved = true`; `nonces` reads `[5, 6]`.
- "decodes a deposit revert before sending it": delete the deposit `simulate`; the transaction is sent and the promise resolves.
- "counts a node's 'already known' as sent ...": delete the `already known` catch; the promise rejects.
- confirmDepositToMiden "reads xReserve's DepositedToRemote ...": drop `* receipt.effectiveGasPrice`; `gasCostWei` fails.
- confirmDepositToMiden "refuses a reverted deposit": delete the `status !== 'success'` check; the promise resolves.
- waitForXReserveAttestation "polls Circle until ...": delete the `clock.sleep`; `slept` is `[]`.
- "refuses two Miden entries for one deposit": delete the `forMiden.length > 1` check; it returns the first.
- "names the domains it saw and the last error when none arrives": rebuild `domainsSeen` per poll; the message lists `[]` (seen while drafting).
- decodeDepositIntent "reads every field ...": read `nonce` at offset 172; `toEqual` fails.
- "names the field a malformed payload fails on": delete the version check; the v2 payload decodes.
- assertDepositIntent "checks every field ... and recovers Circle's attester": recover over `hashMessage({ raw: messageHash })`; the signer is `0xa9Bb37EB265f48891b3BAeBf07729B38E57D8c55`.
- assertDepositIntent "names the field that differs": delete the `remoteRecipient@76` check; the first expectation resolves.

- [ ] **Step 3: Run it and see it fail.**

```bash
yarn jest playwright/e2e/helpers/arc-usdcx.test.ts --maxWorkers=2
```

Expected: `Cannot find module './arc-usdcx' from 'playwright/e2e/helpers/arc-usdcx.test.ts'`.

- [ ] **Step 4: Implement.** Create `playwright/e2e/helpers/arc-usdcx.ts`:

```ts
/**
 * Arc Testnet legs of the USDCx live suites: the per-run key and its ledger, Circle's Gateway payout to that key, the
 * deposit back through xReserve, and Circle's attestation of it. Clients and the clock are injectable, so the unit
 * tests replay captured chain data with no network.
 *
 * Never imports usdcx/deposit.ts or executor.ts: they pull in lib/miden/activity and with it the wallet's SDK.
 */
import fs from 'fs';
import path from 'path';
import {
  createPublicClient,
  encodeFunctionData,
  formatLog,
  http,
  isAddressEqual,
  isHex,
  keccak256,
  pad,
  parseAbi,
  parseEventLogs,
  recoverAddress,
  size,
  slice,
  hexToBigInt,
  hexToNumber,
  toHex,
  TransactionReceiptNotFoundError,
  type Address,
  type Hash,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

import {
  ARC_CHAIN_ID,
  ARC_CIRCLE_DOMAIN,
  ARC_DRPC_LOG_CHUNK,
  ARC_KEY_LEDGER_DIR,
  ARC_LOG_CHUNK,
  ARC_USDC,
  ARC_XRESERVE,
  ATTESTATION_USED_TOPIC,
  DEFAULT_ARC_RPCS,
  GATEWAY_MINTER,
  realArcClock,
  USDCX_REMOTE_DOMAIN,
  type ArcClock
} from './usdcx-constants';
import { fetchXReserveAttestations, type XReserveAttestation } from '../../../src/lib/usdcx/attestation';
import { midenAccountHexToXReserveRecipient } from '../../../src/lib/usdcx/recipient';
import { ARC_TESTNET } from '../../../src/lib/walletconnect/config';

export { realArcClock, type ArcClock } from './usdcx-constants';

const ERC20_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)'
]);

/** The xReserve reads and the deposit, verified on Arc Testnet (Blockscout ABI of the implementation, 2026-10-10). */
export const XRESERVE_HARNESS_ABI = parseAbi([
  'function paused() view returns (bool)',
  'function domainDepositsPaused(uint32 domain) view returns (bool)',
  'function domainWithdrawalsPaused(uint32 domain) view returns (bool)',
  'function isRemoteDomainRegistered(uint32 remoteDomain) view returns (bool)',
  'function getRemoteToken(uint32 remoteDomain, address localToken) view returns (bytes32)',
  'function getRemoteDomainDepositor(uint32 remoteDomain) view returns (address)',
  'function gatewayMinter() view returns (address)',
  'function depositToRemote(uint256 value, uint32 remoteDomain, bytes32 remoteRecipient, address localToken, uint256 maxFee, bytes hookData)',
  'event DepositedToRemote(address indexed localToken, uint256 value, address indexed localDepositor, bytes32 indexed remoteRecipient, uint32 remoteDomain, bytes32 remoteToken, uint256 maxFee, bytes hookData)',
  'error EnforcedPause()',
  'error DomainDepositsPaused(uint32 domain)',
  'error DomainWithdrawalsPaused(uint32 domain)',
  'error RemoteDomainNotRegistered(uint32 remoteDomain)',
  'error LocalTokenNotRegistered(uint32 remoteDomain, address localToken)',
  'error InvalidDepositAmount(uint256 amount)',
  'error AccountBlocklisted(uint32 remoteDomain, bytes32 remoteAddress)',
  'error ZeroValue()'
]);

const GATEWAY_MINTER_ABI = parseAbi([
  'event AttestationUsed(address indexed token, address indexed recipient, bytes32 indexed transferSpecHash, uint32 sourceDomain, bytes32 sourceDepositor, bytes32 sourceSigner, uint256 value)'
]);

const PAYOUT_POLL_MS = 5_000;
const HEAD_LAG_BUDGET_MS = 60_000;
const RECEIPT_TIMEOUT_MS = 120_000;
const RECEIPT_POLL_MS = 1_000;
const DEPOSIT_INTENT_MAGIC: Hex = '0x5a2e0acd';
const DEPOSIT_INTENT_HEADER_BYTES = 240;

/** Appended to every payout failure (spec section 11). */
export const LATE_PAYOUT_NOTE =
  'Arc payouts have arrived up to ~17 h late and one 1 USDCx burn of 2026-10-08 was still unpaid after 45 h; red means a user was not paid in time';

function lowerHex(value: string): Hex {
  const lowered = value.toLowerCase();
  if (!isHex(lowered)) throw new Error(`${value} is not hex`);
  return lowered;
}

/** A viem error as one line: its short message, the RPC's own text, and a decoded revert. */
export function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 4; depth++, current = current.cause) {
    const short = Reflect.get(current, 'shortMessage');
    const details = Reflect.get(current, 'details');
    const data: unknown = Reflect.get(current, 'data');
    const errorName = data !== null && typeof data === 'object' ? Reflect.get(data, 'errorName') : undefined;
    const errorArgs = data !== null && typeof data === 'object' ? Reflect.get(data, 'args') : undefined;
    const revert =
      typeof errorName === 'string'
        ? `${errorName}(${Array.isArray(errorArgs) ? errorArgs.map(String).join(', ') : ''})`
        : undefined;
    for (const part of [typeof short === 'string' ? short : current.message, details, revert]) {
      const line = typeof part === 'string' ? part.split('\n')[0]?.trim() : undefined;
      if (line && !parts.includes(line)) parts.push(line);
    }
  }
  return parts.length > 0 ? parts.join(' | ') : String(error);
}

function rpcCode(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 6; depth++, current = current.cause) {
    const code = Reflect.get(current, 'code');
    if (typeof code === 'number' && code !== -1) return code;
  }
  return undefined;
}

export interface ArcKey {
  address: Address;
  privateKey: Hex;
}

export function newArcKey(): ArcKey {
  const privateKey = generatePrivateKey();
  return { address: privateKeyToAccount(privateKey).address, privateKey };
}

export interface ArcKeyLedgerEntry {
  iso: string;
  address: Address;
  privateKey: Hex;
  walletAddress: string;
}

/**
 * Writes the key to `<dir>/<iso with ':' and '.' as '-'>-<address>.json`, mode 0600, before any funds reach it, so a
 * paid run's payout stays recoverable. The directory is created 0700. Returns the path; never logs the key.
 */
export function recordArcKey(
  key: ArcKey,
  walletAddress: string,
  opts: { dir?: string; now?: () => Date } = {}
): string {
  const dir = opts.dir ?? ARC_KEY_LEDGER_DIR;
  const iso = (opts.now ?? (() => new Date()))().toISOString();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${iso.replace(/[:.]/g, '-')}-${key.address}.json`);
  const entry: ArcKeyLedgerEntry = { iso, address: key.address, privateKey: key.privateKey, walletAddress };
  // 'wx': a file that already exists may hold a funded key.
  fs.writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return file;
}

/** The endpoints a run reads Arc through: the operator's `--arc-rpc` first, then the defaults, without duplicates. */
export function arcEndpoints(override?: string): string[] {
  if (override === undefined) return [...DEFAULT_ARC_RPCS];
  const first = override.trim();
  if (first === '') throw new Error('E2E_ARC_RPC_URL is set but empty');
  return [first, ...DEFAULT_ARC_RPCS.filter(endpoint => endpoint !== first)];
}

export type ArcPublicClientFactory = (endpoint: string) => PublicClient;

export interface ArcReadDeps {
  endpoints: readonly string[];
  publicClient?: ArcPublicClientFactory;
  clock?: ArcClock;
}

/** Writes sign locally with the key and send raw through the read client, so they need nothing more. */
export type ArcWriteDeps = ArcReadDeps;

function defaultPublicClient(endpoint: string): PublicClient {
  // cacheTime 0: viem caches eth_blockNumber for its polling interval, and every payout cycle needs a fresh head.
  return createPublicClient({
    chain: ARC_TESTNET,
    cacheTime: 0,
    transport: http(endpoint, { retryCount: 0, timeout: 15_000 })
  });
}

function clientFor(deps: ArcReadDeps): ArcPublicClientFactory {
  return deps.publicClient ?? defaultPublicClient;
}

async function onFirstEndpoint<T>(
  deps: ArcReadDeps,
  what: string,
  read: (client: PublicClient, endpoint: string) => Promise<T>
): Promise<T> {
  const failures: string[] = [];
  for (const endpoint of deps.endpoints) {
    try {
      return await read(clientFor(deps)(endpoint), endpoint);
    } catch (error) {
      failures.push(`${endpoint}: ${errorText(error)}`);
    }
  }
  throw new Error(`${what}: no Arc endpoint answered\n  ${failures.join('\n  ') || 'no endpoints'}`);
}

/** USDC balance of `address` at `blockNumber` (default latest), from the first endpoint that answers. */
export async function readArcUsdc(address: Address, deps: ArcReadDeps, blockNumber?: bigint): Promise<bigint> {
  return onFirstEndpoint(deps, `Arc USDC balance of ${address}`, client =>
    client.readContract({ address: ARC_USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [address], blockNumber })
  );
}

export interface XReserveDomainState {
  endpoint: string;
  registered: boolean;
  paused: boolean;
  depositsPaused: boolean;
  withdrawalsPaused: boolean;
  /** `getRemoteToken(10007, ARC_USDC)`, lowercase bytes32: the USDCx faucet as xReserve names it. */
  remoteToken: Hex;
  /** `getRemoteDomainDepositor(10007)` padded to a lowercase bytes32, the payout's `sourceDepositor`. */
  depositor: Hex;
  gatewayMinter: Address;
}

/** Miden's domain on Arc's xReserve, all reads on one endpoint. */
export async function readXReserveDomainState(deps: ArcReadDeps): Promise<XReserveDomainState> {
  return onFirstEndpoint(deps, 'xReserve domain state', async (client, endpoint) => {
    const registered = await client.readContract({
      address: ARC_XRESERVE,
      abi: XRESERVE_HARNESS_ABI,
      functionName: 'isRemoteDomainRegistered',
      args: [USDCX_REMOTE_DOMAIN]
    });
    const paused = await client.readContract({
      address: ARC_XRESERVE,
      abi: XRESERVE_HARNESS_ABI,
      functionName: 'paused'
    });
    const depositsPaused = await client.readContract({
      address: ARC_XRESERVE,
      abi: XRESERVE_HARNESS_ABI,
      functionName: 'domainDepositsPaused',
      args: [USDCX_REMOTE_DOMAIN]
    });
    const withdrawalsPaused = await client.readContract({
      address: ARC_XRESERVE,
      abi: XRESERVE_HARNESS_ABI,
      functionName: 'domainWithdrawalsPaused',
      args: [USDCX_REMOTE_DOMAIN]
    });
    const remoteToken = await client.readContract({
      address: ARC_XRESERVE,
      abi: XRESERVE_HARNESS_ABI,
      functionName: 'getRemoteToken',
      args: [USDCX_REMOTE_DOMAIN, ARC_USDC]
    });
    const depositor = await client.readContract({
      address: ARC_XRESERVE,
      abi: XRESERVE_HARNESS_ABI,
      functionName: 'getRemoteDomainDepositor',
      args: [USDCX_REMOTE_DOMAIN]
    });
    const gatewayMinter = await client.readContract({
      address: ARC_XRESERVE,
      abi: XRESERVE_HARNESS_ABI,
      functionName: 'gatewayMinter'
    });
    return {
      endpoint,
      registered,
      paused,
      depositsPaused,
      withdrawalsPaused,
      remoteToken: lowerHex(remoteToken),
      depositor: lowerHex(pad(depositor)),
      gatewayMinter
    };
  });
}

export interface ScannedRange {
  endpoint: string;
  fromBlock: bigint;
  toBlock: bigint;
}

export interface ArcLogScan {
  logs: Log[];
  ranges: ScannedRange[];
}

function isRangeError(error: unknown): boolean {
  return /\branges?\b|too many (blocks|results|logs)|more than \d+ (blocks|results|logs)/i.test(errorText(error));
}

/** eth_getLogs over `fromBlock..toBlock` in `chunk`-block windows, halving the window on a range error down to 1. */
export async function scanArcLogs(
  client: PublicClient,
  endpoint: string,
  query: { address: Address; topics: readonly (Hex | null)[]; fromBlock: bigint; toBlock: bigint; chunk: number }
): Promise<ArcLogScan> {
  const logs: Log[] = [];
  const ranges: ScannedRange[] = [];
  let window = BigInt(Math.max(1, Math.floor(query.chunk)));
  let from = query.fromBlock;
  while (from <= query.toBlock) {
    const to = from + window - 1n < query.toBlock ? from + window - 1n : query.toBlock;
    try {
      const found = await client.request({
        method: 'eth_getLogs',
        params: [{ address: query.address, topics: [...query.topics], fromBlock: toHex(from), toBlock: toHex(to) }]
      });
      logs.push(...found.map(log => formatLog(log)));
      ranges.push({ endpoint, fromBlock: from, toBlock: to });
      from = to + 1n;
    } catch (error) {
      if (!isRangeError(error) || window === 1n) throw error;
      window /= 2n;
    }
  }
  return { logs, ranges };
}

export interface GatewayPayout {
  endpoint: string;
  /** Equals the key's balance at `balanceBlock` and the AttestationUsed value. */
  value: bigint;
  balanceBlock: bigint;
  logBlock: bigint;
  /** The gatewayMint transaction that emitted AttestationUsed. */
  transactionHash: Hash;
  sourceDomain: number;
  sourceDepositor: Hex;
  /** burnUnits - value: Circle's payout fee. */
  fee: bigint;
  /** First nonzero balance read minus the burn's consume time. */
  latencyMs: number;
  ranges: ScannedRange[];
}

export type PayoutGateFailure = 'no-mint' | 'scan-gaps' | 'uncorrelated';

export class PayoutGateError extends Error {
  readonly failure: PayoutGateFailure;
  readonly details: Readonly<Record<string, string>>;

  constructor(failure: PayoutGateFailure, headline: string, details: Record<string, string>) {
    super(
      `${headline}\n${Object.entries(details)
        .map(([key, value]) => `  ${key}: ${value}`)
        .join('\n')}\n${LATE_PAYOUT_NOTE}`
    );
    this.name = 'PayoutGateError';
    this.failure = failure;
    this.details = details;
  }
}

/** A cycle that saw the payout's balance but could not finish proving it: retried on the next endpoint. */
class PayoutScanMiss extends Error {}

function logChunkFor(endpoint: string): number {
  try {
    return new URL(endpoint).hostname.includes('drpc') ? ARC_DRPC_LOG_CHUNK : ARC_LOG_CHUNK;
  } catch {
    return ARC_LOG_CHUNK;
  }
}

function describeRanges(ranges: readonly ScannedRange[]): string {
  if (ranges.length === 0) return 'none';
  const byEndpoint = new Map<string, ScannedRange[]>();
  for (const range of ranges) byEndpoint.set(range.endpoint, [...(byEndpoint.get(range.endpoint) ?? []), range]);
  return [...byEndpoint]
    .map(([endpoint, list]) => `${endpoint} ${list.map(range => `${range.fromBlock}-${range.toBlock}`).join(',')}`)
    .join('; ');
}

export interface GatewayPayoutArgs {
  /** The per-run key. */
  recipient: Address;
  /** `usdcxBurn.noteId`: Circle's TransferSpec carries it as the salt, so it is in the gatewayMint calldata. */
  burnNoteId: Hex;
  burnUnits: bigint;
  /** `usdcxBurn.destinationBalanceBefore.blockNumber`, read before the burn was queued. */
  fromBlock: bigint;
  /** The burn's consume block time, in ms. */
  consumeTsMs: number;
  /** consumeTsMs + PAYOUT_TIMEOUT_MS. */
  deadlineMs: number;
  /** `readXReserveDomainState().depositor`. */
  depositor: Hex;
  /** `minimumUsdcxPayout(ARC_CHAIN_ID, burnUnits)`, the floor the wallet's own confirmation uses. */
  minimumValue: bigint;
}

interface PayoutState {
  readOk: boolean;
  firstPaidMs?: number;
  lastMiss?: string;
  ranges: ScannedRange[];
  errors: string[];
}

async function payoutCycle(
  client: PublicClient,
  endpoint: string,
  args: GatewayPayoutArgs,
  clock: ArcClock,
  state: PayoutState,
  base: Record<string, string>
): Promise<GatewayPayout | undefined> {
  const balanceBlock = await client.getBlockNumber();
  const balance = await client.readContract({
    address: ARC_USDC,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [args.recipient],
    blockNumber: balanceBlock
  });
  state.readOk = true;
  if (balance === 0n) return undefined;
  const firstPaidMs = (state.firstPaidMs ??= clock.now());

  const lagDeadline = clock.now() + HEAD_LAG_BUDGET_MS;
  while ((await client.getBlockNumber()) < balanceBlock) {
    if (clock.now() >= lagDeadline) throw new PayoutScanMiss(`head stayed below ${balanceBlock} for 60 s`);
    await clock.sleep(2_000);
  }
  const scan = await scanArcLogs(client, endpoint, {
    address: GATEWAY_MINTER,
    topics: [ATTESTATION_USED_TOPIC, lowerHex(pad(ARC_USDC)), lowerHex(pad(args.recipient))],
    fromBlock: args.fromBlock,
    toBlock: balanceBlock,
    chunk: logChunkFor(endpoint)
  });
  state.ranges.push(...scan.ranges);
  if (scan.logs.length === 0) throw new PayoutScanMiss(`found 0 AttestationUsed logs up to block ${balanceBlock}`);
  const where = {
    ...base,
    endpoint,
    balanceBlock: String(balanceBlock),
    balance: String(balance),
    ranges: describeRanges(scan.ranges)
  };
  const uncorrelated = (reason: string) =>
    new PayoutGateError('uncorrelated', `payout received but not correlated: ${reason}`, where);
  const decoded = parseEventLogs({ abi: GATEWAY_MINTER_ABI, logs: scan.logs });
  if (scan.logs.length > 1 || decoded.length !== 1) {
    throw uncorrelated(`found ${scan.logs.length} AttestationUsed logs, ${decoded.length} decodable`);
  }
  const [log] = decoded;
  if (!log || log.transactionHash === null || log.blockNumber === null)
    throw uncorrelated('the log has no transaction');
  const { sourceDomain, sourceDepositor, value } = log.args;
  if (sourceDomain !== ARC_CIRCLE_DOMAIN)
    throw uncorrelated(`sourceDomain ${sourceDomain}, expected ${ARC_CIRCLE_DOMAIN}`);
  if (sourceDepositor.toLowerCase() !== args.depositor.toLowerCase()) {
    throw uncorrelated(`sourceDepositor ${sourceDepositor}, expected ${args.depositor}`);
  }
  if (value !== balance)
    throw uncorrelated(`log value ${value} differs from the balance ${balance} at ${balanceBlock}`);
  const transaction = await client.getTransaction({ hash: log.transactionHash });
  if (!transaction.input.toLowerCase().includes(args.burnNoteId.slice(2).toLowerCase())) {
    throw uncorrelated(`gatewayMint ${log.transactionHash} calldata lacks the burn note id ${args.burnNoteId}`);
  }
  if (value < args.minimumValue) {
    throw uncorrelated(`value ${value} is below the wallet's minimum payout ${args.minimumValue}`);
  }
  return {
    endpoint,
    value,
    balanceBlock,
    logBlock: log.blockNumber,
    transactionHash: log.transactionHash,
    sourceDomain,
    sourceDepositor: lowerHex(sourceDepositor),
    fee: args.burnUnits - value,
    latencyMs: firstPaidMs - args.consumeTsMs,
    ranges: [...state.ranges]
  };
}

/**
 * Spec 5 step 8 (D3), the hard payout gate. Every 5 s reads the key's USDC balance at an explicit head B; once it is
 * nonzero, scans GatewayMinter's AttestationUsed logs for the key up to B on the same endpoint and requires exactly one,
 * from Arc's xReserve depositor, of exactly that balance, whose gatewayMint calldata carries the burn note id. An
 * endpoint error moves to the next endpoint with a fresh B. Throws a PayoutGateError at `deadlineMs`.
 */
export async function waitForGatewayPayout(args: GatewayPayoutArgs, deps: ArcReadDeps): Promise<GatewayPayout> {
  if (deps.endpoints.length === 0) throw new Error('waitForGatewayPayout: no Arc endpoints');
  const clock = deps.clock ?? realArcClock;
  const base = {
    recipient: args.recipient,
    burnNoteId: args.burnNoteId,
    fromBlock: String(args.fromBlock),
    deadline: new Date(args.deadlineMs).toISOString()
  };
  const state: PayoutState = { readOk: false, ranges: [], errors: [] };
  let index = 0;
  let failuresInRow = 0;
  for (;;) {
    const endpoint = deps.endpoints[index % deps.endpoints.length] ?? '';
    try {
      const payout = await payoutCycle(clientFor(deps)(endpoint), endpoint, args, clock, state, base);
      if (payout) return payout;
      failuresInRow = 0;
    } catch (error) {
      if (error instanceof PayoutGateError) throw error;
      const reason = `${endpoint}: ${errorText(error)}`;
      if (error instanceof PayoutScanMiss) state.lastMiss = reason;
      state.errors = [...state.errors, reason].slice(-6);
      index += 1;
      failuresInRow += 1;
    }
    // After an error, try the next endpoint at once, unless every endpoint just failed in a row.
    const retryNow = failuresInRow > 0 && failuresInRow < deps.endpoints.length;
    if (clock.now() >= args.deadlineMs) break;
    if (!retryNow) {
      failuresInRow = 0;
      await clock.sleep(PAYOUT_POLL_MS);
    }
  }
  const details = {
    ...base,
    ranges: describeRanges(state.ranges),
    endpointErrors: state.errors.join(' || ') || 'none'
  };
  if (state.firstPaidMs !== undefined && state.lastMiss !== undefined) {
    throw new PayoutGateError('uncorrelated', `payout received but not correlated: ${state.lastMiss}`, details);
  }
  if (state.firstPaidMs !== undefined || !state.readOk) {
    throw new PayoutGateError('scan-gaps', `unknown: scan gaps ${describeRanges(state.ranges)}`, details);
  }
  throw new PayoutGateError('no-mint', `no destination mint for this key by ${base.deadline}`, details);
}

export interface DepositSubmission {
  endpoint: string;
  approveHash?: Hash;
  depositHash: Hash;
  approved: boolean;
}

async function acceptsRawTransactions(client: PublicClient): Promise<boolean> {
  try {
    await client.request({ method: 'eth_sendRawTransaction', params: ['0x00'] });
    return false;
  } catch (error) {
    const code = rpcCode(error);
    const text = errorText(error);
    if (code === -32602 || /decode|rlp|typed transaction/i.test(text)) return true;
    if (code === -32601 || /not (supported|available|allowed)|method not found/i.test(text)) return false;
    throw error;
  }
}

/** The first endpoint on Arc Testnet that takes raw transactions: a garbage one must fail to decode, not be refused. */
async function pickWriteEndpoint(deps: ArcWriteDeps): Promise<{ client: PublicClient; endpoint: string }> {
  const failures: string[] = [];
  for (const endpoint of deps.endpoints) {
    const client = clientFor(deps)(endpoint);
    try {
      const chainId = await client.getChainId();
      if (chainId !== ARC_CHAIN_ID) failures.push(`${endpoint}: chain ${chainId}`);
      else if (await acceptsRawTransactions(client)) return { client, endpoint };
      else failures.push(`${endpoint}: refuses eth_sendRawTransaction`);
    } catch (error) {
      failures.push(`${endpoint}: ${errorText(error)}`);
    }
  }
  throw new Error(`no Arc endpoint takes writes\n  ${failures.join('\n  ') || 'no endpoints'}`);
}

async function simulate(endpoint: string, what: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    throw new Error(`${what} would revert on ${endpoint}: ${errorText(error)}`, { cause: error });
  }
}

async function sendSigned(
  client: PublicClient,
  account: PrivateKeyAccount,
  tx: { to: Address; data: Hex; nonce: number }
): Promise<Hash> {
  const gas = await client.estimateGas({ account: account.address, to: tx.to, data: tx.data });
  const fees = await client.estimateFeesPerGas();
  const serializedTransaction = await account.signTransaction({
    chainId: ARC_CHAIN_ID,
    type: 'eip1559',
    to: tx.to,
    data: tx.data,
    nonce: tx.nonce,
    gas: (gas * 12n) / 10n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas
  });
  const hash = keccak256(serializedTransaction);
  try {
    await client.sendRawTransaction({ serializedTransaction });
  } catch (error) {
    // The node already holding this exact transaction is not a failure: the hash is the signed bytes' own.
    if (!/already known/i.test(errorText(error))) throw error;
  }
  return hash;
}

async function waitForReceipt(client: PublicClient, hash: Hash, clock: ArcClock): Promise<TransactionReceipt> {
  const deadline = clock.now() + RECEIPT_TIMEOUT_MS;
  for (;;) {
    const receipt = await client.getTransactionReceipt({ hash }).catch((error: unknown) => {
      if (error instanceof TransactionReceiptNotFoundError) return undefined;
      throw error;
    });
    if (receipt) {
      if (receipt.status !== 'success')
        throw new Error(`Arc transaction ${hash} reverted in block ${receipt.blockNumber}`);
      return receipt;
    }
    if (clock.now() >= deadline)
      throw new Error(`Arc transaction ${hash} has no receipt after ${RECEIPT_TIMEOUT_MS} ms`);
    await clock.sleep(RECEIPT_POLL_MS);
  }
}

/**
 * Approve (when asked) and `depositToRemote(units, 10007, recipient, USDC, 0, 0x)` from the key, on one write endpoint
 * with a local nonce. Each call is simulated first so a revert decodes; the approve is mined before the deposit's
 * simulation reads its allowance. 'exact' always approves exactly `units`; 'if-short' only when the allowance is short.
 */
export async function submitDepositToMiden(
  args: { privateKey: Hex; units: bigint; recipientHex: string; approve: 'exact' | 'if-short' },
  deps: ArcWriteDeps
): Promise<DepositSubmission> {
  const clock = deps.clock ?? realArcClock;
  const account = privateKeyToAccount(args.privateKey);
  const remoteRecipient = midenAccountHexToXReserveRecipient(args.recipientHex);
  const { client, endpoint } = await pickWriteEndpoint(deps);
  let nonce = await client.getTransactionCount({ address: account.address, blockTag: 'pending' });
  const allowance = await client.readContract({
    address: ARC_USDC,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account.address, ARC_XRESERVE]
  });
  const approved = args.approve === 'exact' || allowance < args.units;
  let approveHash: Hash | undefined;
  if (approved) {
    await simulate(endpoint, 'USDC approve', () =>
      client.simulateContract({
        account: account.address,
        address: ARC_USDC,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [ARC_XRESERVE, args.units]
      })
    );
    approveHash = await sendSigned(client, account, {
      to: ARC_USDC,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [ARC_XRESERVE, args.units] }),
      nonce
    });
    nonce += 1;
    await waitForReceipt(client, approveHash, clock);
  }
  const depositArgs: readonly [bigint, number, Hex, Address, bigint, Hex] = [
    args.units,
    USDCX_REMOTE_DOMAIN,
    remoteRecipient,
    ARC_USDC,
    0n,
    '0x'
  ];
  await simulate(endpoint, 'xReserve depositToRemote', () =>
    client.simulateContract({
      account: account.address,
      address: ARC_XRESERVE,
      abi: XRESERVE_HARNESS_ABI,
      functionName: 'depositToRemote',
      args: depositArgs
    })
  );
  const depositHash = await sendSigned(client, account, {
    to: ARC_XRESERVE,
    data: encodeFunctionData({ abi: XRESERVE_HARNESS_ABI, functionName: 'depositToRemote', args: depositArgs }),
    nonce
  });
  return { endpoint, approveHash, depositHash, approved };
}

export interface DepositedToRemoteEvent {
  value: bigint;
  localDepositor: Address;
  remoteRecipient: Hex;
  remoteDomain: number;
  remoteToken: Hex;
  maxFee: bigint;
  hookData: Hex;
  blockNumber: bigint;
}

/** The submission's receipts, on its write endpoint, and the one DepositedToRemote xReserve emitted. */
export async function confirmDepositToMiden(
  submission: DepositSubmission,
  deps: ArcReadDeps
): Promise<{ approveBlock?: bigint; depositBlock: bigint; event: DepositedToRemoteEvent; gasCostWei: bigint }> {
  const clock = deps.clock ?? realArcClock;
  const client = clientFor(deps)(submission.endpoint);
  const approveReceipt = submission.approveHash
    ? await waitForReceipt(client, submission.approveHash, clock)
    : undefined;
  const depositReceipt = await waitForReceipt(client, submission.depositHash, clock);
  const events = parseEventLogs({
    abi: XRESERVE_HARNESS_ABI,
    eventName: 'DepositedToRemote',
    logs: depositReceipt.logs
  }).filter(log => isAddressEqual(log.address, ARC_XRESERVE));
  const [event] = events;
  if (!event || events.length !== 1) {
    throw new Error(
      `deposit ${submission.depositHash}: ${events.length} DepositedToRemote events from xReserve, expected 1`
    );
  }
  return {
    approveBlock: approveReceipt?.blockNumber,
    depositBlock: depositReceipt.blockNumber,
    event: {
      value: event.args.value,
      localDepositor: event.args.localDepositor,
      remoteRecipient: lowerHex(event.args.remoteRecipient),
      remoteDomain: event.args.remoteDomain,
      remoteToken: lowerHex(event.args.remoteToken),
      maxFee: event.args.maxFee,
      hookData: event.args.hookData,
      blockNumber: depositReceipt.blockNumber
    },
    gasCostWei: [approveReceipt, depositReceipt].reduce(
      (sum, receipt) => (receipt ? sum + receipt.gasUsed * receipt.effectiveGasPrice : sum),
      0n
    )
  };
}

/**
 * Circle's attestation of the deposit: polls `fetchXReserveAttestations` (attestation.ts) until it lists the deposit's
 * Miden entry. Throws naming the count on none by the deadline or on more than one.
 */
export async function waitForXReserveAttestation(
  depositHash: Hash,
  opts: {
    baseUrl: string;
    timeoutMs: number;
    pollMs?: number;
    clock?: ArcClock;
    fetchList?: (hash: Hash, o: { baseUrl: string }) => Promise<XReserveAttestation[]>;
  }
): Promise<XReserveAttestation> {
  const clock = opts.clock ?? realArcClock;
  const fetchList = opts.fetchList ?? fetchXReserveAttestations;
  const deadline = clock.now() + opts.timeoutMs;
  let lastError = 'none';
  const domainsSeen = new Set<number>();
  for (;;) {
    let list: XReserveAttestation[] | undefined;
    try {
      list = await fetchList(depositHash, { baseUrl: opts.baseUrl });
    } catch (error) {
      lastError = errorText(error);
    }
    if (list) {
      for (const entry of list) domainsSeen.add(entry.remoteDomain);
      const forMiden = list.filter(entry => entry.remoteDomain === USDCX_REMOTE_DOMAIN);
      if (forMiden.length > 1) {
        throw new Error(
          `Circle lists ${forMiden.length} attestations for deposit ${depositHash} to domain 10007, expected 1`
        );
      }
      const [attestation] = forMiden;
      if (attestation) return attestation;
    }
    if (clock.now() >= deadline) {
      throw new Error(
        `Circle has not attested deposit ${depositHash}: 0 entries for domain ${USDCX_REMOTE_DOMAIN} after ` +
          `${opts.timeoutMs} ms (domains listed: [${[...domainsSeen].join(', ')}]; last error: ${lastError})`
      );
    }
    await clock.sleep(opts.pollMs ?? 3_000);
  }
}

/** Circle's DepositIntent payload, field by field. Same layout as attestation.ts's product decoder. */
export interface DecodedDepositIntent {
  magic: Hex;
  version: number;
  amount: bigint;
  remoteDomain: number;
  remoteToken: Hex;
  remoteRecipient: Hex;
  localToken: Hex;
  localDepositor: Hex;
  maxFee: bigint;
  nonce: Hex;
  hookLength: number;
  hookData: Hex;
}

/**
 * The harness's own reader of the 240 + hookLen byte DepositIntent: magic@0[4] version@4[4] amount@8[32]
 * remoteDomain@40[4] remoteToken@44[32] remoteRecipient@76[32] localToken@108[32] localDepositor@140[32]
 * maxFee@172[32] nonce@204[32] hookLen@236[4] hookData@240. Throws naming the field that fails.
 */
export function decodeDepositIntent(payload: Hex): DecodedDepositIntent {
  const bytes = size(payload);
  if (bytes < DEPOSIT_INTENT_HEADER_BYTES) {
    throw new Error(`DepositIntent length: ${bytes} bytes, below the ${DEPOSIT_INTENT_HEADER_BYTES}-byte header`);
  }
  const word = (offset: number, length: number): Hex => lowerHex(slice(payload, offset, offset + length));
  const magic = word(0, 4);
  if (magic !== DEPOSIT_INTENT_MAGIC)
    throw new Error(`DepositIntent magic: ${magic}, expected ${DEPOSIT_INTENT_MAGIC}`);
  const version = hexToNumber(word(4, 4));
  if (version !== 1) throw new Error(`DepositIntent version: ${version}, expected 1`);
  const hookLength = hexToNumber(word(236, 4));
  if (bytes !== DEPOSIT_INTENT_HEADER_BYTES + hookLength) {
    throw new Error(
      `DepositIntent length: ${bytes} bytes, expected ${DEPOSIT_INTENT_HEADER_BYTES} + hookLen ${hookLength}`
    );
  }
  return {
    magic,
    version,
    amount: hexToBigInt(word(8, 32)),
    remoteDomain: hexToNumber(word(40, 4)),
    remoteToken: word(44, 32),
    remoteRecipient: word(76, 32),
    localToken: word(108, 32),
    localDepositor: word(140, 32),
    maxFee: hexToBigInt(word(172, 32)),
    nonce: word(204, 32),
    hookLength,
    hookData: hookLength === 0 ? '0x' : word(DEPOSIT_INTENT_HEADER_BYTES, hookLength)
  };
}

/**
 * Spec 5 step 12: every DepositIntent field against the deposit the key signed, `messageHash == keccak256(payload)`,
 * and the signer recovered from Circle's signature over `messageHash` (returned, not pinned).
 */
export async function assertDepositIntent(
  attestation: XReserveAttestation,
  expected: { amount: bigint; remoteToken: Hex; remoteRecipient: Hex; localToken: Address; localDepositor: Address }
): Promise<{ intent: DecodedDepositIntent; signer: Address }> {
  const intent = decodeDepositIntent(attestation.payload);
  const mismatches: string[] = [];
  const check = (field: string, actual: string | number | bigint, wanted: string | number | bigint) => {
    if (actual !== wanted) mismatches.push(`${field}: ${actual}, expected ${wanted}`);
  };
  check('entry remoteDomain', attestation.remoteDomain, USDCX_REMOTE_DOMAIN);
  check('amount@8', intent.amount, expected.amount);
  check('remoteDomain@40', intent.remoteDomain, USDCX_REMOTE_DOMAIN);
  check('remoteToken@44', intent.remoteToken, expected.remoteToken.toLowerCase());
  check('remoteRecipient@76', intent.remoteRecipient, expected.remoteRecipient.toLowerCase());
  check('localToken@108', intent.localToken, pad(expected.localToken).toLowerCase());
  check('localDepositor@140', intent.localDepositor, pad(expected.localDepositor).toLowerCase());
  check('maxFee@172', intent.maxFee, 0n);
  check('hookLen@236', intent.hookLength, 0);
  check('messageHash', attestation.messageHash.toLowerCase(), keccak256(attestation.payload));
  if (mismatches.length > 0) {
    throw new Error(`Circle's DepositIntent differs from the deposit:\n  ${mismatches.join('\n  ')}`);
  }
  const signer = await recoverAddress({ hash: attestation.messageHash, signature: attestation.attestation });
  return { intent, signer };
}
```

- [ ] **Step 5: Run it and see it pass.** Same command. Expected: `Tests: 41 passed, 41 total`.

- [ ] **Step 6: Every p3 suite, its directory, and the gates CI does not run for us.**

```bash
yarn jest playwright/e2e/helpers --maxWorkers=2
npx prettier --write playwright/e2e/helpers/arc-usdcx.ts playwright/e2e/helpers/arc-usdcx.test.ts
npx eslint --max-warnings 0 playwright/e2e/helpers/arc-usdcx.ts playwright/e2e/helpers/arc-usdcx.test.ts playwright/e2e/helpers/usdcx-constants.ts playwright/e2e/helpers/usdcx-guardian.ts playwright/e2e/helpers/usdcx-miden.ts playwright/e2e/helpers/usdcx-chain-evidence.mjs playwright/e2e/helpers/history.ts playwright/e2e/helpers/bridge.ts
yarn lint:e2e
perl -CSD -ne 'print "$ARGV:$.\n" if /[\x{2013}\x{2014}]/' playwright/e2e/helpers/usdcx-constants.ts playwright/e2e/helpers/arc-usdcx.ts playwright/e2e/helpers/arc-usdcx.test.ts playwright/e2e/helpers/arc-usdcx.vectors.json playwright/e2e/helpers/usdcx-guardian.ts playwright/e2e/helpers/usdcx-guardian.test.ts playwright/e2e/helpers/usdcx-miden.ts playwright/e2e/helpers/usdcx-miden.test.ts playwright/e2e/helpers/bridge.test.ts
git diff -U0 -- playwright/e2e/helpers | grep '^+' | perl -CSD -ne 'print if /[\x{2013}\x{2014}]/'
git status --porcelain -- playwright/e2e/helpers
printf 'x \xe2\x80\x94 y\n' | perl -CSD -ne 'print "control hit\n" if /[\x{2013}\x{2014}]/'
```

Expected: every helpers suite loads and passes, the six this partition touches with 135 tests (arc-usdcx 41, drain-progress 41, bridge 18, usdcx-miden 18, usdcx-guardian 11, history 6); eslint exit 0; `yarn lint:e2e` reports no new violations; both dash checks (the new files whole, the modified files by added line) print nothing while the positive control prints `control hit`. Modified files are checked by added line only because history.ts and bridge.ts already hold em dashes in untouched comments. `git status` lists exactly the 14 paths below (new files as `??`).

- [ ] **Step 7: Commit 9.**

```bash
git add playwright/e2e/helpers/usdcx-constants.ts playwright/e2e/helpers/arc-usdcx.ts playwright/e2e/helpers/arc-usdcx.test.ts playwright/e2e/helpers/arc-usdcx.vectors.json playwright/e2e/helpers/usdcx-guardian.ts playwright/e2e/helpers/usdcx-guardian.test.ts playwright/e2e/helpers/usdcx-miden.ts playwright/e2e/helpers/usdcx-miden.test.ts playwright/e2e/helpers/usdcx-chain-evidence.mjs playwright/e2e/helpers/history.ts playwright/e2e/helpers/history.test.ts playwright/e2e/helpers/bridge.ts playwright/e2e/helpers/bridge.test.ts playwright/e2e/helpers/drain-progress.test.ts
git diff --cached --name-only | wc -l
git commit -m "test(e2e): shared USDCx harness modules and row readers"
git show --stat --format=%B HEAD | head -3
```

Expected: `14` staged paths; the commit body is the single line `test(e2e): shared USDCx harness modules and row readers` with no trailer.

---

### Task 25: A Playwright config of its own for the USDCx live suites, ignored by the base config (p5-config-isolation)

Spec 4 (Files, Isolation from every CI job, Timeouts cover fixture setup) and interfaces section 5. Part of spec commit 11; the commit is made by Task 27 (p5-bridge-in).

**Files:**
- Create: `playwright.usdcx.config.ts`
- Modify: `playwright.e2e.config.ts:23-24` (the dApp comment line and the `testIgnore` line)
- Modify: `playwright/e2e/harness/spec-selection.test.ts:33-48` (the `overridingConfigs` list and the describe `dedicated e2e configs override the base testIgnore`)

**Interfaces:**
- Consumes: the default export of `playwright.e2e.config.ts` (`defineConfig({...})`, playwright.e2e.config.ts:12-78); `configSource(file: string): string` (playwright/e2e/harness/spec-selection.test.ts:22); the spread pattern of `playwright.earn.config.ts:12-16`.
- Produces:
  - `playwright.usdcx.config.ts`: `export default defineConfig({ ...base, testDir: './playwright/e2e/tests/usdcx', testIgnore: undefined, timeout: 3_600_000 })` (interfaces section 5; p4's SUITES name this file).
  - `playwright.e2e.config.ts`: `testIgnore` gains `'**/usdcx/**'` (interfaces section 5).
  - `playwright/e2e/harness/spec-selection.test.ts`: `const testIgnoreOf: (source: string) => string | undefined` (reads a single-line value or a whole array literal; prettier wraps the base list once it passes 120 columns, which the old `/testIgnore:\s*(.+)/` reader would truncate to `[`).

- [ ] **Step 1: Write the failing tests**

In `playwright/e2e/harness/spec-selection.test.ts` replace lines 33-48:

```ts
/** Configs whose testDir the base config ignores. */
const overridingConfigs = ['playwright.resilience.config.ts', 'playwright.swap.config.ts'];

describe('dedicated e2e configs override the base testIgnore', () => {
  it.each(overridingConfigs)('%s clears the inherited ignore list', file => {
    const testIgnore = /testIgnore:\s*(.+)/.exec(configSource(file))?.[1];
    expect(testIgnore).toMatch(/^undefined,?$/);
  });

  it('the base config is the reason the override is required', () => {
    const base = configSource('playwright.e2e.config.ts');
    const testIgnore = /testIgnore:\s*(.+)/.exec(base)?.[1];
    expect(testIgnore).toMatch(/resilience/);
    expect(testIgnore).toMatch(/swap/);
  });
});
```

with:

```ts
/** Configs whose testDir the base config ignores. */
const overridingConfigs = [
  'playwright.resilience.config.ts',
  'playwright.swap.config.ts',
  'playwright.usdcx.config.ts'
];

/** A config's `testIgnore` value: one line, or a whole array literal however prettier wraps it. */
const testIgnoreOf = (source: string) => /testIgnore:\s*(\[[^\]]*\]|[^\n]+)/.exec(source)?.[1];

describe('dedicated e2e configs override the base testIgnore', () => {
  it.each(overridingConfigs)('%s clears the inherited ignore list', file => {
    expect(testIgnoreOf(configSource(file))).toMatch(/^undefined,?$/);
  });

  it('the base config is the reason the override is required', () => {
    const testIgnore = testIgnoreOf(configSource('playwright.e2e.config.ts'));
    expect(testIgnore).toMatch(/resilience/);
    expect(testIgnore).toMatch(/swap/);
    expect(testIgnore).toMatch(/usdcx/);
  });
});

describe('the USDCx live suites have a config of their own', () => {
  it('playwright.usdcx.config.ts spreads the base config over tests/usdcx with an hour per test', () => {
    const source = configSource('playwright.usdcx.config.ts');
    expect(source).toMatch(/\.\.\.base,/);
    expect(source).toMatch(/testDir: '\.\/playwright\/e2e\/tests\/usdcx',/);
    expect(source).toMatch(/timeout: 3_600_000/);
  });
});
```

Mutation notes:
- `playwright.usdcx.config.ts clears the inherited ignore list`: delete `testIgnore: undefined,` from playwright.usdcx.config.ts; the reader then finds no value and `toMatch(/^undefined,?$/)` fails on `undefined`.
- `the base config is the reason the override is required`: delete `'**/usdcx/**'` from the base `testIgnore`; `toMatch(/usdcx/)` fails.
- `playwright.usdcx.config.ts spreads the base config over tests/usdcx with an hour per test`: change `timeout: 3_600_000` to `300_000`; `toMatch(/timeout: 3_600_000/)` fails.

- [ ] **Step 2: Run the tests and watch them fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
yarn jest playwright/e2e/harness/spec-selection.test.ts -t 'base testIgnore|config of their own' --maxWorkers=2
```

Expected: 3 failed, 2 passed (the rest skipped). `playwright.usdcx.config.ts clears the inherited ignore list` and `playwright.usdcx.config.ts spreads the base config over tests/usdcx with an hour per test` fail with `ENOENT: no such file or directory, open '<repo>/playwright.usdcx.config.ts'`; `the base config is the reason the override is required` fails with `Expected pattern: /usdcx/`.

- [ ] **Step 3: Create `playwright.usdcx.config.ts`**

```ts
import { defineConfig } from '@playwright/test';

import base from './playwright.e2e.config';

// Same harness as the blockchain E2E config, but runs ONLY the live USDCx suites, which the base config ignores.
// `yarn e2e:real --suite usdcx|usdcx-in|usdcx-burn` is its only caller; no workflow runs it. An hour per test because
// Playwright charges test-scoped fixture setup (wallet A and the CLI it depends on) to the test's own budget.
export default defineConfig({
  ...base,
  testDir: './playwright/e2e/tests/usdcx',
  testIgnore: undefined,
  timeout: 3_600_000
});
```

- [ ] **Step 4: Ignore tests/usdcx in the base config**

In `playwright.e2e.config.ts` replace lines 23-24:

```ts
  // need a Guardian on one axis and run via playwright.dapp.config.ts.
  testIgnore: ['**/guardian-*.spec.ts', '**/swap/**', '**/bridge/**', '**/earn/**', '**/resilience/**', '**/dapp/**'],
```

with (prettier wraps the list once it passes 120 columns, so it is written wrapped):

```ts
  // need a Guardian on one axis and run via playwright.dapp.config.ts. USDCx
  // live specs spend public testnet funds and run only through `yarn e2e:real`
  // (playwright.usdcx.config.ts), never in CI.
  testIgnore: [
    '**/guardian-*.spec.ts',
    '**/swap/**',
    '**/bridge/**',
    '**/earn/**',
    '**/resilience/**',
    '**/dapp/**',
    '**/usdcx/**'
  ],
```

- [ ] **Step 5: Run the tests and watch them pass**

```bash
yarn jest playwright/e2e/harness/spec-selection.test.ts -t 'base testIgnore|config of their own' --maxWorkers=2
```

Expected: 5 passed, 0 failed (three `clears the inherited ignore list` cases, the base-config case and the new config case; the rest skipped).

- [ ] **Step 6: Format and lint the touched files**

```bash
npx prettier --write playwright.usdcx.config.ts playwright.e2e.config.ts playwright/e2e/harness/spec-selection.test.ts
npx eslint --max-warnings 0 playwright.usdcx.config.ts playwright.e2e.config.ts playwright/e2e/harness/spec-selection.test.ts
```

Expected: prettier leaves the files as written; eslint prints nothing and exits 0.

- [ ] **Step 7: Commit deferred to Task 27 (p5-bridge-in)** (spec commit 11).

---

---

### Task 26: The shared run helpers, the grant and burn legs, and the extension Guardian round trip (p5-roundtrip)

Spec 5 (every step), spec 11 (spec-level failure messages), Q5(d), Q6, Q7, Q8 (spec side) and interfaces sections 3, 5 and 6. Part of spec commit 11; the commit is made by Task 27 (p5-bridge-in). Three files are added beyond the partition's list (ratified at assembly; Appendix A.7): `helpers/usdcx-run.ts` holds every pure decision the live specs make, so each has a jest test; `helpers/usdcx-legs.ts` holds the grant and burn legs that `usdcx-roundtrip.spec.ts` and `usdcx-burn.spec.ts` share (a spec file cannot import another spec file, and Playwright would collect a `.test.ts` placed in tests/usdcx). Live-network steps cannot run here: this task verifies with the jest suites of every helper the spec uses and `playwright test --list`; the live runs are spec 14 step 6.

A consume's landed path is told by its fee. `TransactionRowSnapshot` carries no `resultBytes` (only bridged-send rows are read with their bytes), a consume completed with its result always records `feeAmount` (`feeFieldsFromResult` in `completeConsumeTransaction`), and no landed path records one (Appendix A.1). `consumeFeePath` therefore reads a consume with neither `feeAmount` nor `resultReleasedAt` as landed, which its test 'calls a consume with no fee and no released result a landed path' documents; such a fee is bounded, never exact (Q5(d)).

Spike-dependent items, for the controller to patch after the running spike:
- (spike-dependent: step budgets) every `BUDGET` value in the spec, frozen by spec 14 step 1; `PAYOUT_TIMEOUT_MS` and `WALLET_CONFIRM_TIMEOUT_MS` come from p3's `usdcx-constants.ts`.
- (spike-dependent: the wallet's own payout confirmation timing) the `wallet_payout_confirmed` step waits `WALLET_CONFIRM_TIMEOUT_MS`.
- (spike-dependent: headless visibility, Q8) the spec keeps `walletA.page` on Home, `#/history-details/<id>` or the Send flow and never hides it; whether it runs headless is p4's `E2E_HEADLESS`.
- (spike-dependent: the deposit-back leg) `deposit_submit` relies on p3's write endpoint choice and gas against `GAS_RESERVE_UNITS`; `mint` relies on the mint latency on main.
- (spike-dependent: whether the grant note and the mint note carry the same account tag) `mint` compares the mint note's tag with the grant note's; drop that comparison if the spike shows the two differ.
- (spike-dependent: burnOutputs decode by role) `confirmBurn` trusts p3's `burnOutputs` roles.

**Files:**
- Create: `playwright/e2e/helpers/usdcx-run.ts`
- Create: `playwright/e2e/helpers/usdcx-run.test.ts`
- Create: `playwright/e2e/helpers/usdcx-legs.ts`
- Create: `playwright/e2e/tests/usdcx/usdcx-roundtrip.spec.ts`
- Modify: `playwright/e2e/harness/spec-selection.test.ts` (a new block after the describe `the USDCx live suites have a config of their own` that Task 25 (p5-config-isolation) added)

**Interfaces:**
- Consumes (p3, commit 9; exact signatures in interfaces section 3):
  - `helpers/arc-usdcx.ts`: `newArcKey(): ArcKey`, `recordArcKey(key: ArcKey, walletAddress: string, opts?): string`, `arcEndpoints(override?: string): string[]`, `readArcUsdc(address: Address, deps: ArcReadDeps, blockNumber?: bigint): Promise<bigint>`, `readXReserveDomainState(deps: ArcReadDeps): Promise<XReserveDomainState>`, `waitForGatewayPayout(args: { recipient; burnNoteId; burnUnits; fromBlock; consumeTsMs; deadlineMs; depositor; minimumValue }, deps: ArcReadDeps): Promise<GatewayPayout>`, `submitDepositToMiden(args: { privateKey; units; recipientHex; approve: 'exact' | 'if-short' }, deps: ArcWriteDeps): Promise<DepositSubmission>`, `confirmDepositToMiden(submission, deps): Promise<{ approveBlock?; depositBlock; event: DepositedToRemoteEvent; gasCostWei }>`, `waitForXReserveAttestation(depositHash: Hash, opts: { baseUrl; timeoutMs; pollMs? }): Promise<XReserveAttestation>`, `assertDepositIntent(attestation, expected: { amount; remoteToken; remoteRecipient; localToken; localDepositor }): Promise<{ intent: DecodedDepositIntent; signer: Address }>` (async, because viem's `recoverAddress` is: the spec awaits it), types `ArcKey`, `ArcWriteDeps`, `DecodedDepositIntent`, `DepositSubmission`, `GatewayPayout`, `XReserveDomainState`. `deadlineMs` is passed as an absolute epoch time, `consumeTsMs + PAYOUT_TIMEOUT_MS` (spec 5 step 8: "deadline consumeTs + 10 min").
  - `helpers/usdcx-miden.ts`: `bareId(id: string): string`, `accountHex(bech32OrComposite: string, run?): Promise<string>`, `burnEvidence(rpcUrl, args: { faucetBech32; noteId: Hex; senderBech32; domain; recipient: Address; amount }, run?): Promise<BurnEvidence>`, `burnOutputs(args: { resultBytesBase64; burnNoteId: Hex; faucetBech32 }, run?): Promise<BurnOutputs>`, `deriveUsdcxMintNoteId(args: { faucetHex; recipientHex; units; nonce: Hex }, run?): Promise<Hex>`, `note(rpcUrl, noteId: Hex, run?): Promise<MidenNoteRead>`, `nullifier(rpcUrl, noteId: Hex, run?): Promise<{ committed: boolean; blockNum?: number }>`, `waitForUsdcxMint(rpcUrl, args: { mintNoteId; depositHash; nonce; faucetBech32; accountBech32; sinceBlock; timeoutMs; pollMs? }, deps?): Promise<MidenNoteRead>`, `boundLandedFee(args: { vaultDelta: bigint; knownTerms: bigint; baseFee: number }): { fee: bigint; ceiling: bigint }` (used with `vaultDelta` = vault before minus vault after, so a consume passes its credit as a negative known term), types `BurnEvidence`, `MidenNoteRead`.
  - `helpers/usdcx-guardian.ts`: `guardianIdentity(url: string): Promise<GuardianIdentity>`, `guardianFailureContext(identity: GuardianIdentity): Promise<string>`, `assertNoGuardianOpInFlight(rows: readonly TransactionRowSnapshot[], accountId: string): void`, `burnFailureMessage(row: BridgedSendRow): string`.
  - `helpers/usdcx-constants.ts`: `ARC_ATTESTATION_API`, `ARC_CHAIN_ID`, `ARC_CIRCLE_DOMAIN`, `ARC_PUBLIC_URL`, `ARC_USDC`, `BURN_UNITS`, `DEPOSIT_UNITS`, `GAS_RESERVE_UNITS`, `GRANT_MARGIN_UNITS`, `PAYOUT_TIMEOUT_MS`, `WALLET_CONFIRM_TIMEOUT_MS`, `USDCX_BURN_TAG`, `USDCX_REMOTE_DOMAIN`, `minimumUsdcxPayout(chainId: number, amount: bigint): bigint`.
  - `helpers/bridge.ts`: `readBridgedSendRows(page: Page): Promise<BridgedSendRow[]>` (widened `BridgedSendRow` of interfaces 3.6), `readNativeDisplaySymbol(page: Page, nativeTokenId: string): Promise<string>`, `enText(key: string, values?: Record<string, string>): string`, `bridgeOutUsdcx(wallet: ChromeWalletPageApi, opts: BridgeOutUsdcxOptions): Promise<BridgeOutUsdcxResult>`, `createUsdcxBridgeReceive(wallet: ChromeWalletPageApi, args: CreateUsdcxBridgeReceiveArgs): Promise<string>`, `bridgeReceiveState(wallet: ChromeWalletPageApi, txId: string): Promise<BridgeReceiveStateSnapshot>`.
  - `helpers/history.ts`: `type JsonValue`, `TransactionRowSnapshot` with `extraInputs?: { [key: string]: JsonValue }` and `resultReleasedAt?: number` (interfaces 3.5); existing `TxStatus` (history.ts:28-35), `readTransactionRows(page)` (:144), `readTransactionRow(page, rowId)` (:242), `describeTransactionRow(row)` (:248), `openHistoryDetails(wallet, rowId)` (:632) (origin/main lines; p3's commit 9 may shift the later ones).
- Consumes (p1, commit 1): `matchUsdcxDepositAttestation(list: readonly XReserveAttestation[], expected: UsdcxDepositExpectation): UsdcxAttestationMatch` (src/lib/usdcx/attestation.ts, interfaces 1.4).
- Consumes (existing, unchanged): `test` and `expect` (playwright/e2e/fixtures/two-wallets.ts:839, :1048), `GuardianAwareWalletPage` (:113), fixtures `envConfig` (:841), `steps` (:869), `walletA` (:937) and option `injectFeeFaucet` (:840); `GuardianFaultTestApi.ownsProfile` (:68), `trackGuardianCommitments()` (:101), `waitForGuardianSettled(timeoutMs?)` (:110); `TestStepRunner.step(name, fn)` (playwright/e2e/harness/test-step.ts:78); `ChromeWalletPage.createGuardianWallet(guardianUrl)` (playwright/e2e/helpers/wallet-page.ts:663), `assertGuardianAuth(pk, expected)` (:1402), `currentGuardianEndpoint()` (:1435), `navigateHome()` (WalletPage, :168); `walletDiscoveredNativeFaucetId(page)` (playwright/e2e/helpers/balance-truth.ts:542), `walletDiscoveredBaseFee(page)` (:525), `vaultBalanceOfCurrentAccount(page, faucetId)` (:399), `waitForVaultBalanceOfCurrentAccount(page, faucetId, expected, { timeoutMs })` (:409), `fromBaseUnits(baseUnits, decimals)` (:57); `mintFromPublicFaucet(baseUrl, accountId)` (@main playwright/e2e/helpers/public-faucet.ts:247, returns `{ noteId }`), `publicFaucetApiUrl(network)` (@main :50); `waitForPublicNoteCommitment(rpcUrl, noteId, timeoutMs?)` (playwright/e2e/helpers/public-note-commitment.ts:32); `midenAccountHexToXReserveRecipient(hexId)` (src/lib/usdcx/recipient.ts:19); `CIRCLE_USDC_DECIMALS` (src/lib/usdcx/constant.ts:322), `USDCX_DECIMALS` (:333); `ARC_TESTNET` (src/lib/walletconnect/config.ts:12-19); `listPlaywrightTests(config, envOverrides?)` (playwright/e2e/harness/playwright-list.ts:12); `isHash` (viem).
- Produces:
  - `playwright/e2e/helpers/usdcx-run.ts`:
    ```ts
    export function errorText(error: unknown): string;
    export function assertUsdcxLiveRun(env: NodeJS.ProcessEnv, opts: { needsArcKey: boolean }): void;
    export function arcPrivateKeyFromEnv(env: NodeJS.ProcessEnv): Hex;
    export type StepContext = () => Promise<string>;
    export function withStepBudget<T>(name: string, budgetMs: number, run: () => Promise<T>, context?: StepContext): Promise<T>;
    export interface StepRecorder { step(name: string, fn: () => Promise<void>): Promise<void> }
    export type NamedStep = <T>(name: string, budgetMs: number, run: () => Promise<T>, context?: StepContext) => Promise<T>;
    export function namedSteps(recorder: StepRecorder): NamedStep;
    export interface PhaseSample { phase: string; atMs: number }
    export class PhaseTimeline { constructor(label: string, order: readonly string[]); record(phase: string | undefined, atMs: number): void; samples(): PhaseSample[]; last(): string | undefined; firstAt(phase: string): number | undefined; saw(phase: string): boolean; describe(): string; assertMonotone(): void }
    export interface BackgroundSampler { stop(): Promise<void> }
    export function sampleInBackground(tick: () => Promise<boolean>, intervalMs: number, sleep?: (ms: number) => Promise<void>): BackgroundSampler;
    export interface PollOptions<T> { timeoutMs: number; intervalMs: number; describe?: (last: T | undefined) => Promise<string>; now?: () => number; sleep?: (ms: number) => Promise<void> }
    export function pollUntil<T>(label: string, read: () => Promise<T>, done: (value: T) => boolean, opts: PollOptions<T>): Promise<T>;
    export function readSettledChange(read: () => Promise<bigint>, from: bigint, opts: Omit<PollOptions<bigint[]>, 'describe'>): Promise<bigint>;
    export interface FeeTerm { name: string; amount: bigint; kind: 'exact' | 'bounded'; ceiling?: bigint }
    export function boundedTerm(name: string, bound: { fee: bigint; ceiling: bigint }): FeeTerm;
    export type ConsumeFeePath = { kind: 'result'; fee: bigint } | { kind: 'landed' };
    export function consumeFeePath(row: { id: string; feeAmount?: string; resultReleasedAt?: number }): ConsumeFeePath;
    export type BurnCompletionPath = { kind: 'result'; resultBytes: string } | { kind: 'landed' };
    export function burnCompletionPath(row: { resultBytes?: string; resultReleasedAt?: number }): BurnCompletionPath;
    export function exactlyOne<T>(items: readonly T[], what: string, describe: (item: T) => string): T;
    export function jsonObject(value: JsonValue | undefined): { [key: string]: JsonValue } | undefined;
    export function jsonString(value: JsonValue | undefined): string | undefined;
    export interface RunEvidence { suite: string; guardian?: { url: string; version: string; gitCommit: string; commitment: string }; ids: Record<string, string>; hashes: Record<string, string>; fees: FeeTerm[]; latenciesMs: Record<string, number>; phases: Record<string, PhaseSample[]>; settleMs: Record<string, number>; notes: string[] }
    export function newRunEvidence(suite: string): RunEvidence;
    export function evidenceJson(evidence: RunEvidence, secrets: readonly string[]): string;
    export function explainSettleFailure(error: unknown): Error;
    export function describePage(url: string, visibility: () => Promise<string>): Promise<string>;
    export function ledgerLine(terms: ReadonlyArray<readonly [string, bigint]>): string;
    export function anyOf(texts: readonly string[]): RegExp;
    ```
  - `playwright/e2e/helpers/usdcx-legs.ts`:
    ```ts
    export interface UsdcxWalletIds { address: string; bare: string; accountHex: string; native: string; nativeBare: string; nativeHex: string; baseFee: number }
    export function pageWhere(wallet: GuardianAwareWalletPage): StepContext;
    export function resolveUsdcxIds(page: Page, address: string): Promise<UsdcxWalletIds>;
    export function createGuardianUsdcxWallet(wallet: GuardianAwareWalletPage, guardianUrl: string): Promise<string>;
    export function settleGuardian(wallet: GuardianAwareWalletPage, timeoutMs: number): Promise<number>;
    export function waitForConsumeOf(page: Page, noteId: string, label: string, timeoutMs: number, where: StepContext): Promise<TransactionRowSnapshot>;
    export function consumeFeeAndVault(page: Page, ids: UsdcxWalletIds, consume: TransactionRowSnapshot, ledger: { fee: string; vaultBefore: bigint; credit: bigint; terms: ReadonlyArray<readonly [string, bigint]> }): Promise<{ fee: FeeTerm; vault: bigint }>;
    export interface GrantFunding { grantNoteId: Hash; grant: bigint; grantTag?: number; consumeId: string; f0: FeeTerm; vault: bigint }
    export function fundFromPublicFaucet(page: Page, ids: UsdcxWalletIds, rpcUrl: string, where: StepContext): Promise<GrantFunding>;
    export function submitBurn(wallet: GuardianAwareWalletPage, ids: UsdcxWalletIds, opts: { destination: Address; units: bigint; screenshotDir: string }): Promise<ReadonlySet<string>>;
    export interface BurnLeg { row: BridgedSendRow; burnNoteId: Hash; fee: FeeTerm; sponsorship: bigint; vault: bigint; oracle: BurnEvidence; arcFromBlock: bigint; phases: PhaseTimeline }
    export interface ConfirmBurnOptions { priorRowIds: ReadonlySet<string>; destination: Address; units: bigint; vaultBefore: bigint; rpcUrl: string; guardian: boolean; timeoutMs: number; where: StepContext }
    export function confirmBurn(wallet: GuardianAwareWalletPage, ids: UsdcxWalletIds, opts: ConfirmBurnOptions): Promise<BurnLeg>;
    export function assertBurnDetails(wallet: GuardianAwareWalletPage, rowId: string, destination: Address): Promise<void>;
    export function historyPill(wallet: GuardianAwareWalletPage, rowId: string): Promise<string>;
    export function receivingTxHash(page: Page, timeoutMs: number): Promise<string | null>;
    export function attachEvidence(info: TestInfo, name: string, evidence: RunEvidence, secrets: readonly string[]): Promise<void>;
    ```
  - `playwright/e2e/tests/usdcx/usdcx-roundtrip.spec.ts`: describe `USDCx round trip: burn to a fresh Arc key, Circle payout, deposit back` with one test `Guardian wallet: public faucet grant, Send burn, payout and its confirmation, deposit back, receipt` (runner grep `USDCx round trip`, interfaces section 5); it attaches `usdcx-round-trip-evidence.json`.

- [ ] **Step 1: Write the failing unit tests for the run helpers**

Create `playwright/e2e/helpers/usdcx-run.test.ts`:

```ts
/** @jest-environment node */
import type { JsonValue } from './history';
import {
  anyOf,
  arcPrivateKeyFromEnv,
  assertUsdcxLiveRun,
  boundedTerm,
  burnCompletionPath,
  consumeFeePath,
  describePage,
  errorText,
  evidenceJson,
  exactlyOne,
  explainSettleFailure,
  jsonObject,
  jsonString,
  ledgerLine,
  namedSteps,
  newRunEvidence,
  PhaseTimeline,
  pollUntil,
  readSettledChange,
  sampleInBackground,
  withStepBudget
} from './usdcx-run';

const KEY = 'ab'.repeat(32);
const RUNNER = { E2E_REAL_USDCX: 'true', E2E_NETWORK: 'testnet' };
const RECEIVE_ORDER = ['delivering', 'ready', 'received'];

/** The message a call throws, or '' when it returns. */
function thrown(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return errorText(error);
  }
  return '';
}

/** A clock that moves only when the code under test sleeps; a loop that never ends fails instead of hanging. */
function fakeClock() {
  const clock = { at: 0, sleeps: 0 };
  return {
    now: () => clock.at,
    sleep: async (ms: number) => {
      clock.sleeps += 1;
      if (clock.sleeps > 100) throw new Error('slept more than 100 times');
      clock.at += ms;
    }
  };
}

/** Lets a loop that yields through `setImmediate` run `rounds` times. */
async function macrotasks(rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setImmediate(resolve));
}

describe('assertUsdcxLiveRun', () => {
  it('accepts a run the runner started on testnet', () => {
    expect(thrown(() => assertUsdcxLiveRun(RUNNER, { needsArcKey: false }))).toBe('');
    expect(thrown(() => assertUsdcxLiveRun({ ...RUNNER, E2E_ARC_PRIVATE_KEY: KEY }, { needsArcKey: true }))).toBe('');
  });

  it('refuses a run the runner did not start', () => {
    expect(thrown(() => assertUsdcxLiveRun({ E2E_NETWORK: 'testnet' }, { needsArcKey: false }))).toBe(
      'the USDCx live suites run only through `yarn e2e:real --suite usdcx|usdcx-in|usdcx-burn` ' +
        '(E2E_REAL_USDCX is not "true")'
    );
  });

  it('refuses every network but testnet', () => {
    expect(thrown(() => assertUsdcxLiveRun({ ...RUNNER, E2E_NETWORK: 'devnet' }, { needsArcKey: false }))).toBe(
      'the USDCx live suites run only on testnet, but E2E_NETWORK is devnet'
    );
    expect(thrown(() => assertUsdcxLiveRun({ E2E_REAL_USDCX: 'true' }, { needsArcKey: false }))).toBe(
      'the USDCx live suites run only on testnet, but E2E_NETWORK is unset'
    );
  });

  it('refuses usdcx-in without a key and never echoes one', () => {
    expect(thrown(() => assertUsdcxLiveRun(RUNNER, { needsArcKey: true }))).toBe(
      'usdcx-in needs a funded Arc key: pass --arc-key to yarn e2e:real or export E2E_ARC_PRIVATE_KEY'
    );
    const devnet = thrown(() =>
      assertUsdcxLiveRun({ ...RUNNER, E2E_NETWORK: 'devnet', E2E_ARC_PRIVATE_KEY: KEY }, { needsArcKey: true })
    );
    expect(devnet).not.toContain(KEY);
  });
});

describe('arcPrivateKeyFromEnv', () => {
  it('returns the key as 0x and lowercase hex', () => {
    expect(arcPrivateKeyFromEnv({ E2E_ARC_PRIVATE_KEY: ` 0X${KEY.toUpperCase()} ` })).toBe(`0x${KEY}`);
    expect(arcPrivateKeyFromEnv({ E2E_ARC_PRIVATE_KEY: KEY })).toBe(`0x${KEY}`);
  });

  it('refuses a key of the wrong length with a message that does not echo it', () => {
    expect(thrown(() => arcPrivateKeyFromEnv({ E2E_ARC_PRIVATE_KEY: KEY.slice(1) }))).toBe(
      'E2E_ARC_PRIVATE_KEY is not a 32-byte hex private key'
    );
  });
});

describe('withStepBudget', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('hands back the step result', async () => {
    await expect(withStepBudget('fund', 1_000, async () => 7)).resolves.toBe(7);
  });

  it('names the step on a failure and keeps the cause', async () => {
    const cause = new Error('vault 5, expected 6');
    const failure = await withStepBudget('fund', 1_000, async () => Promise.reject(cause)).catch(
      (error: unknown) => error
    );
    expect(errorText(failure)).toBe('fund: vault 5, expected 6');
    expect(failure instanceof Error ? failure.cause : undefined).toBe(cause);
  });

  it('rejects a step that outruns its budget and appends its context', async () => {
    jest.useFakeTimers();
    const outcome = withStepBudget(
      'payout',
      1_000,
      () => new Promise<never>(() => undefined),
      async () => 'key 0xabc'
    ).catch((error: unknown) => errorText(error));
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toBe('payout: exceeded its 1000 ms budget\nkey 0xabc');
  });

  it('keeps the failure when the context cannot be read', async () => {
    const outcome = withStepBudget(
      'settle_grant',
      1_000,
      async () => Promise.reject(new Error('not canonical')),
      async () => Promise.reject(new Error('guardian down'))
    ).catch((error: unknown) => errorText(error));
    await expect(outcome).resolves.toBe('settle_grant: not canonical\n(context unavailable: guardian down)');
  });
});

describe('namedSteps', () => {
  it('records each step under its name and hands back its value', async () => {
    const names: string[] = [];
    const step = namedSteps({
      step: async (name, fn) => {
        names.push(name);
        await fn();
      }
    });
    await expect(step('arc_state', 1_000, async () => 'ok')).resolves.toBe('ok');
    expect(names).toEqual(['arc_state']);
  });

  it('rejects with the step-named failure the recorder rethrows', async () => {
    const step = namedSteps({ step: async (_name, fn) => fn() });
    await expect(step('mint', 1_000, async () => Promise.reject(new Error('no note')))).rejects.toThrow(
      'mint: no note'
    );
  });
});

describe('PhaseTimeline', () => {
  it('keeps one sample per change and ignores unread phases', () => {
    const timeline = new PhaseTimeline('POSITIVE', RECEIVE_ORDER);
    timeline.record('delivering', 1_000);
    timeline.record('delivering', 2_000);
    timeline.record(undefined, 3_000);
    timeline.record('ready', 4_000);
    expect(timeline.samples()).toEqual([
      { phase: 'delivering', atMs: 1_000 },
      { phase: 'ready', atMs: 4_000 }
    ]);
    expect([timeline.last(), timeline.firstAt('ready'), timeline.saw('received')]).toEqual(['ready', 4_000, false]);
    expect(timeline.describe()).toBe('delivering@1970-01-01T00:00:01.000Z -> ready@1970-01-01T00:00:04.000Z');
  });

  it('accepts phases in order, skipped ones included', () => {
    const timeline = new PhaseTimeline('POSITIVE', RECEIVE_ORDER);
    timeline.record('delivering', 1_000);
    timeline.record('received', 2_000);
    expect(thrown(() => timeline.assertMonotone())).toBe('');
  });

  it('refuses a phase that goes back', () => {
    const timeline = new PhaseTimeline('POSITIVE', RECEIVE_ORDER);
    timeline.record('ready', 1_000);
    timeline.record('delivering', 4_000);
    expect(thrown(() => timeline.assertMonotone())).toBe(
      'POSITIVE: phase "delivering" breaks the order delivering -> ready -> received ' +
        '(ready@1970-01-01T00:00:01.000Z -> delivering@1970-01-01T00:00:04.000Z)'
    );
  });

  it('refuses a phase outside the order, even as the first sample', () => {
    const timeline = new PhaseTimeline('NEGATIVE', ['delivering', 'failed']);
    timeline.record('ready', 1_000);
    expect(thrown(() => timeline.assertMonotone())).toBe(
      'NEGATIVE: phase "ready" breaks the order delivering -> failed (ready@1970-01-01T00:00:01.000Z)'
    );
  });
});

describe('sampleInBackground', () => {
  const yieldOnce = () => new Promise<void>(resolve => setImmediate(resolve));

  it('samples until a tick reports done', async () => {
    let calls = 0;
    const sampler = sampleInBackground(
      async () => {
        calls += 1;
        return calls >= 3;
      },
      2_000,
      yieldOnce
    );
    await macrotasks(10);
    await sampler.stop();
    expect(calls).toBe(3);
  });

  it('rides out one failed tick', async () => {
    let calls = 0;
    const sampler = sampleInBackground(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('service worker restarting');
        return true;
      },
      2_000,
      yieldOnce
    );
    await macrotasks(5);
    await expect(sampler.stop()).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it('ends on the third failure in a row and reports it on stop', async () => {
    let calls = 0;
    const sampler = sampleInBackground(
      async () => {
        calls += 1;
        throw new Error(`service worker gone ${calls}`);
      },
      2_000,
      yieldOnce
    );
    await macrotasks(10);
    await expect(sampler.stop()).rejects.toThrow('service worker gone 3');
    expect(calls).toBe(3);
  });
});

describe('pollUntil', () => {
  it('returns the first read that is done', async () => {
    const reads = [1, 2, 3];
    const clock = fakeClock();
    await expect(
      pollUntil(
        'count',
        async () => reads.shift() ?? 0,
        value => value >= 2,
        { timeoutMs: 10_000, intervalMs: 1_000, ...clock }
      )
    ).resolves.toBe(2);
    expect(reads).toEqual([3]);
  });

  it('names the label, the last read and the detail when time runs out', async () => {
    const clock = fakeClock();
    const outcome = pollUntil(
      'burn row to reach confirmed',
      async () => ({ phase: 'pending', amount: 5n }),
      row => row.phase === 'confirmed',
      { timeoutMs: 10_000, intervalMs: 3_000, describe: async last => `phase ${last?.phase}`, ...clock }
    );
    await expect(outcome).rejects.toThrow(
      'burn row to reach confirmed: not reached within 10000 ms; last read {"phase":"pending","amount":"5"}; phase pending'
    );
    expect(clock.now()).toBe(10_000);
  });

  it('lets a failed read through at once', async () => {
    let calls = 0;
    const outcome = pollUntil(
      'grant consume',
      async () => {
        calls += 1;
        throw new Error('consume failed at stage proving');
      },
      () => true,
      { timeoutMs: 10_000, intervalMs: 1_000, ...fakeClock() }
    );
    await expect(outcome).rejects.toThrow('consume failed at stage proving');
    expect(calls).toBe(1);
  });
});

describe('readSettledChange', () => {
  it('waits for the balance to move and then hold', async () => {
    const reads = [5n, 5n, 3n, 4n, 4n];
    await expect(
      readSettledChange(async () => reads.shift() ?? 0n, 5n, { timeoutMs: 60_000, intervalMs: 4_000, ...fakeClock() })
    ).resolves.toBe(4n);
  });

  it('times out when the balance never moves', async () => {
    await expect(
      readSettledChange(async () => 5n, 5n, { timeoutMs: 8_000, intervalMs: 4_000, ...fakeClock() })
    ).rejects.toThrow('balance to move from 5 and hold: not reached within 8000 ms; last read ["5","5"]');
  });
});

describe('consumeFeePath', () => {
  it('reads the fee a consume recorded with its result', () => {
    expect(consumeFeePath({ id: 'c1', feeAmount: '133' })).toEqual({ kind: 'result', fee: 133n });
  });

  it('calls a consume with no fee and no released result a landed path', () => {
    expect(consumeFeePath({ id: 'c1' })).toEqual({ kind: 'landed' });
  });

  it('refuses a recorded fee that is not positive', () => {
    expect(thrown(() => consumeFeePath({ id: 'c1', feeAmount: '0' }))).toBe(
      'consume c1 recorded fee 0, not a positive base-unit amount'
    );
  });

  it('refuses a released result with no fee', () => {
    expect(thrown(() => consumeFeePath({ id: 'c1', resultReleasedAt: 1_760_000_000 }))).toBe(
      'consume c1 released its result at 2025-10-09T08:53:20.000Z but recorded no fee'
    );
  });
});

describe('burnCompletionPath', () => {
  it('decodes from resultBytes when the row still has them', () => {
    expect(burnCompletionPath({ resultBytes: 'AAEC', resultReleasedAt: 1 })).toEqual({
      kind: 'result',
      resultBytes: 'AAEC'
    });
  });

  it('reports a reaped result instead of guessing the outputs', () => {
    expect(thrown(() => burnCompletionPath({ resultReleasedAt: 1_760_000_000 }))).toBe(
      'resultBytes released at 2025-10-09T08:53:20.000Z, 10 min after completedAt; outputs not decoded'
    );
  });

  it('calls a row with neither a landed path', () => {
    expect(burnCompletionPath({})).toEqual({ kind: 'landed' });
  });
});

describe('fee and ledger text', () => {
  it('records a bounded fee with its ceiling', () => {
    expect(boundedTerm('f2', { fee: 133n, ceiling: 399n })).toEqual({
      name: 'f2',
      amount: 133n,
      kind: 'bounded',
      ceiling: 399n
    });
  });

  it('prints every ledger term', () => {
    expect(
      ledgerLine([
        ['G', 100_000_000n],
        ['f0', 133n]
      ])
    ).toBe('G=100000000 f0=133');
  });
});

describe('exactlyOne', () => {
  it('returns the only item', () => {
    expect(exactlyOne(['a'], 'consume row', item => item)).toBe('a');
  });

  it('names every item when there is more than one, and the count when there is none', () => {
    expect(thrown(() => exactlyOne(['a', 'b'], 'consume row', item => item))).toBe(
      'expected exactly one consume row, found 2: a; b'
    );
    expect(thrown(() => exactlyOne([], 'consume row', item => item))).toBe('expected exactly one consume row, found 0');
  });
});

describe('JSON narrowing', () => {
  it('keeps only objects and strings', () => {
    const bridgeIn: JsonValue = { bridgeReceiveTxId: 'row-1' };
    expect(jsonString(jsonObject(bridgeIn)?.bridgeReceiveTxId)).toBe('row-1');
    expect([jsonObject(['row-1']), jsonObject(null), jsonObject('row-1'), jsonString(5)]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined
    ]);
  });
});

describe('evidenceJson', () => {
  it('writes bigints as decimal strings', () => {
    const evidence = newRunEvidence('usdcx');
    evidence.fees.push({ name: 'f0', amount: 133n, kind: 'exact' });
    expect(JSON.parse(evidenceJson(evidence, [`0x${KEY}`])).fees).toEqual([
      { name: 'f0', amount: '133', kind: 'exact' }
    ]);
  });

  it('refuses evidence that holds the key in any spelling', () => {
    const evidence = newRunEvidence('usdcx');
    evidence.notes.push(`leaked ${KEY.toUpperCase()}`);
    expect(thrown(() => evidenceJson(evidence, [`0x${KEY}`]))).toBe(
      'the evidence would contain a private key, so it was not written'
    );
  });
});

describe('explainSettleFailure', () => {
  it('reads a missing push as tracking that started late', () => {
    const error = new Error('waitForGuardianSettled: no delta push was observed, so there is nothing to wait for');
    expect(explainSettleFailure(error).message).toBe(
      'tracking started late: waitForGuardianSettled: no delta push was observed, so there is nothing to wait for'
    );
  });

  it('passes any other failure through unchanged', () => {
    const error = new Error('waitForGuardianSettled: the guardian has not canonicalized the last pushed delta');
    expect(explainSettleFailure(error)).toBe(error);
  });
});

describe('describePage', () => {
  it('names the route and the visibility', async () => {
    await expect(describePage('chrome-extension://abc/fullpage.html#/history', async () => 'hidden')).resolves.toBe(
      'page route #/history, visibility hidden'
    );
  });

  it('still names the route when the visibility cannot be read', async () => {
    await expect(
      describePage('chrome-extension://abc/fullpage.html', async () => Promise.reject(new Error('page closed')))
    ).resolves.toBe('page route (no route), visibility unreadable (page closed)');
  });
});

describe('anyOf', () => {
  it('matches each text whole, around whitespace, and nothing else', () => {
    const pill = anyOf(['Burn confirmed', 'Confirmed']);
    expect(['Burn confirmed', ' Confirmed ', 'Burn confirmed.', 'Not Confirmed'].map(text => pill.test(text))).toEqual([
      true,
      true,
      false,
      false
    ]);
    expect(anyOf(['a.b']).test('axb')).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
yarn jest playwright/e2e/helpers/usdcx-run.test.ts --maxWorkers=2
```

Expected: the suite fails to load with `Cannot find module './usdcx-run' from 'playwright/e2e/helpers/usdcx-run.test.ts'` (Tests: 0 total; read the suite error, not the count).

Mutation notes (each mutation is one edit to `usdcx-run.ts`, reverted after the run; every one was run against this exact module and test file while drafting):
- `assertUsdcxLiveRun › accepts a run the runner started on testnet` and `› refuses a run the runner did not start`: flip `env.E2E_REAL_USDCX !== 'true'` to `=== 'true'`; the first call throws and the second returns.
- `assertUsdcxLiveRun › refuses every network but testnet`: make the `E2E_NETWORK` check `if (false)`; both calls return ''.
- `assertUsdcxLiveRun › refuses usdcx-in without a key and never echoes one`: make the `E2E_ARC_PRIVATE_KEY` check `if (false)`; the first call returns ''.
- `arcPrivateKeyFromEnv › returns the key as 0x and lowercase hex`: drop `.toLowerCase()` from the return; the uppercase key comes back uppercase.
- `arcPrivateKeyFromEnv › refuses a key of the wrong length with a message that does not echo it`: widen `{64}` to `{63,64}`; the 63-digit key is returned.
- `withStepBudget › hands back the step result`: race only `overrun` (`Promise.race([overrun])`); the step rejects at its 1 s budget.
- `withStepBudget › names the step on a failure and keeps the cause`: rethrow `error` unchanged in the catch; the message lacks `fund: `.
- `withStepBudget › rejects a step that outruns its budget and appends its context`: replace the `setTimeout` that rejects `overrun` with `timer = undefined`; the outcome never settles and the test times out.
- `withStepBudget › keeps the failure when the context cannot be read`: delete the rejection handler of `context().then(...)`; the step rejects with `guardian down`.
- `namedSteps › records each step under its name and hands back its value`: pass `'step'` instead of `name` to `recorder.step`; `names` reads `['step']`.
- `namedSteps › rejects with the step-named failure the recorder rethrows`: replace `.catch(reject)` with `.catch(() => undefined)`; the promise never settles and the test times out.
- `PhaseTimeline › keeps one sample per change and ignores unread phases`: drop `|| this.last() === phase` from `record`; three samples are kept.
- `PhaseTimeline › accepts phases in order, skipped ones included`: replace `next < rank` with `next !== rank + 1`; delivering then received throws.
- `PhaseTimeline › refuses a phase that goes back`: drop `|| next < rank`; nothing throws.
- `PhaseTimeline › refuses a phase outside the order, even as the first sample`: drop `next === -1 ||`; rank -1 against -1 throws nothing.
- `sampleInBackground › samples until a tick reports done`: replace `if (await tick()) return;` with `await tick();`; the loop keeps sampling and `calls` passes 3.
- `sampleInBackground › rides out one failed tick`: lower the limit to `failures >= 1`; `stop` rejects with `service worker restarting`.
- `sampleInBackground › ends on the third failure in a row and reports it on stop`: delete `state.failure = error;`; `stop` resolves.
- `pollUntil › returns the first read that is done`: delete `if (done(value)) return value;`; the poll runs to its deadline and rejects.
- `pollUntil › names the label, the last read and the detail when time runs out`: drop `${detail}` from the thrown message; the text ends at the last read.
- `pollUntil › lets a failed read through at once`: wrap `await read()` in a catch that sleeps and continues; the fake clock refuses its 101st sleep and the rejection names that instead.
- `readSettledChange › waits for the balance to move and then hold` and `› times out when the balance never moves`: drop `latest !== from &&`; both resolve `5n` at the first two equal reads.
- `consumeFeePath › reads the fee a consume recorded with its result`: make `if (row.feeAmount !== undefined)` `if (false)`; the row reads as landed.
- `consumeFeePath › calls a consume with no fee and no released result a landed path`: return `{ kind: 'result', fee: 0n }` in place of `{ kind: 'landed' }`.
- `consumeFeePath › refuses a recorded fee that is not positive`: loosen `POSITIVE_UNITS` to `/^\d+$/`; `'0'` returns a result of `0n`.
- `consumeFeePath › refuses a released result with no fee`: make its `resultReleasedAt` check `if (false)`; the row reads as landed.
- `burnCompletionPath › decodes from resultBytes when the row still has them`: delete the `resultBytes` line; the released time throws as reaped.
- `burnCompletionPath › reports a reaped result instead of guessing the outputs`: make its `resultReleasedAt` check `if (false)`; the row reads as landed.
- `burnCompletionPath › calls a row with neither a landed path`: return `{ kind: 'result', resultBytes: '' }` in place of `{ kind: 'landed' }`.
- `fee and ledger text › records a bounded fee with its ceiling`: drop `ceiling` from `boundedTerm`'s return.
- `fee and ledger text › prints every ledger term`: join with `','` instead of `' '`.
- `exactlyOne › returns the only item`: compare `items.length !== 2`; the one-item call throws.
- `exactlyOne › names every item when there is more than one, and the count when there is none`: drop `items.length !== 1 ||`; two items return `'a'`.
- `JSON narrowing › keeps only objects and strings`: drop `!Array.isArray(value)`; an array reads as an object.
- `evidenceJson › writes bigints as decimal strings`: pass `undefined` instead of the bigint replacer; `JSON.stringify` throws on `133n`.
- `evidenceJson › refuses evidence that holds the key in any spelling`: drop `.replace(/^0x/, '')`; the 0x-prefixed secret is not found in the bare hex and the evidence is written.
- `explainSettleFailure › reads a missing push as tracking that started late`: make the `no delta push was observed` branch `if (false)`.
- `explainSettleFailure › passes any other failure through unchanged`: always return `new Error(message)`; `toBe(error)` fails on identity.
- `describePage › names the route and the visibility` and `› still names the route when the visibility cannot be read`: read `.pathname` instead of `.hash`; the route reads `/fullpage.html`.
- `describePage › still names the route when the visibility cannot be read`: drop the `.catch` on `visibility()`; the call rejects with `page closed`.
- `anyOf › matches each text whole, around whitespace, and nothing else`: drop the regex escape (`a.b` then matches `axb`), or drop the `^`/`$` anchors (`Not Confirmed` then matches).

- [ ] **Step 3: Write the run helpers**

Create `playwright/e2e/helpers/usdcx-run.ts`:

```ts
import type { Hex } from 'viem';

import type { JsonValue } from './history';

const ARC_PRIVATE_KEY = /^(0x)?[0-9a-f]{64}$/i;
const POSITIVE_UNITS = /^[1-9]\d*$/;

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** The message of any thrown value. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Throws unless `yarn e2e:real` started this run for a usdcx suite on testnet. The suites throw instead of skipping, so
 * a run that lacks its inputs never reports green. Messages name variables, never their values.
 */
export function assertUsdcxLiveRun(env: NodeJS.ProcessEnv, opts: { needsArcKey: boolean }): void {
  if (env.E2E_REAL_USDCX !== 'true') {
    throw new Error(
      'the USDCx live suites run only through `yarn e2e:real --suite usdcx|usdcx-in|usdcx-burn` ' +
        '(E2E_REAL_USDCX is not "true")'
    );
  }
  if (env.E2E_NETWORK !== 'testnet') {
    throw new Error(`the USDCx live suites run only on testnet, but E2E_NETWORK is ${env.E2E_NETWORK ?? 'unset'}`);
  }
  if (opts.needsArcKey && !env.E2E_ARC_PRIVATE_KEY) {
    throw new Error('usdcx-in needs a funded Arc key: pass --arc-key to yarn e2e:real or export E2E_ARC_PRIVATE_KEY');
  }
}

/** The funded Arc key as `0x` and 64 lowercase hex digits. */
export function arcPrivateKeyFromEnv(env: NodeJS.ProcessEnv): Hex {
  const raw = (env.E2E_ARC_PRIVATE_KEY ?? '').trim();
  if (!ARC_PRIVATE_KEY.test(raw)) throw new Error('E2E_ARC_PRIVATE_KEY is not a 32-byte hex private key');
  return `0x${raw.replace(/^0x/i, '').toLowerCase()}`;
}

/** Extra text for a failed step: a Guardian re-read, the page's route. */
export type StepContext = () => Promise<string>;

/**
 * Runs one step under its budget. A failure and an overrun both reject with a message that starts with the step's
 * name; `context` is appended best-effort.
 */
export async function withStepBudget<T>(
  name: string,
  budgetMs: number,
  run: () => Promise<T>,
  context?: StepContext
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const overrun = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`exceeded its ${budgetMs} ms budget`)), budgetMs);
  });
  const work = run();
  // The losing side of the race keeps running, and a Playwright worker fails the test on its unhandled rejection.
  work.catch(() => undefined);
  try {
    return await Promise.race([work, overrun]);
  } catch (error) {
    const detail = context
      ? await context().then(
          text => (text ? `\n${text}` : ''),
          (failure: unknown) => `\n(context unavailable: ${errorText(failure)})`
        )
      : '';
    throw new Error(`${name}: ${errorText(error)}${detail}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

/** What `TestStepRunner` offers: a named checkpoint around one step. */
export interface StepRecorder {
  step(name: string, fn: () => Promise<void>): Promise<void>;
}

export type NamedStep = <T>(name: string, budgetMs: number, run: () => Promise<T>, context?: StepContext) => Promise<T>;

/** Each step is a checkpoint in the run's report, runs under its own budget, and hands its result back. */
export function namedSteps(recorder: StepRecorder): NamedStep {
  return <T>(name: string, budgetMs: number, run: () => Promise<T>, context?: StepContext) =>
    new Promise<T>((resolve, reject) => {
      recorder
        .step(name, async () => {
          resolve(await withStepBudget(name, budgetMs, run, context));
        })
        .catch(reject);
    });
}

export interface PhaseSample {
  phase: string;
  atMs: number;
}

/** The phases one row was seen in, in order, for the monotonicity checks and the evidence. */
export class PhaseTimeline {
  private readonly seen: PhaseSample[] = [];

  constructor(
    readonly label: string,
    private readonly order: readonly string[]
  ) {}

  record(phase: string | undefined, atMs: number): void {
    if (phase === undefined || this.last() === phase) return;
    this.seen.push({ phase, atMs });
  }

  samples(): PhaseSample[] {
    return [...this.seen];
  }

  last(): string | undefined {
    return this.seen[this.seen.length - 1]?.phase;
  }

  firstAt(phase: string): number | undefined {
    return this.seen.find(sample => sample.phase === phase)?.atMs;
  }

  saw(phase: string): boolean {
    return this.firstAt(phase) !== undefined;
  }

  describe(): string {
    if (this.seen.length === 0) return 'no samples';
    return this.seen.map(sample => `${sample.phase}@${new Date(sample.atMs).toISOString()}`).join(' -> ');
  }

  /** Throws when a phase falls outside `order` or follows a later one. */
  assertMonotone(): void {
    let rank = -1;
    for (const sample of this.seen) {
      const next = this.order.indexOf(sample.phase);
      if (next === -1 || next < rank) {
        throw new Error(
          `${this.label}: phase "${sample.phase}" breaks the order ${this.order.join(' -> ')} (${this.describe()})`
        );
      }
      rank = next;
    }
  }
}

export interface BackgroundSampler {
  /** Ends the loop after the tick in flight, and rejects with the failure that ended it early, if one did. */
  stop(): Promise<void>;
}

/**
 * Runs `tick` every `intervalMs` until it returns true or `stop` is called. One failed tick (a service worker
 * restarting) is ridden out; three in a row end the loop with the last failure.
 */
export function sampleInBackground(
  tick: () => Promise<boolean>,
  intervalMs: number,
  sleep: (ms: number) => Promise<void> = defaultSleep
): BackgroundSampler {
  const state: { stopped: boolean; failure?: unknown } = { stopped: false };
  const loop = (async () => {
    let failures = 0;
    while (!state.stopped) {
      try {
        if (await tick()) return;
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures >= 3) {
          state.failure = error;
          return;
        }
      }
      await sleep(intervalMs);
    }
  })();
  return {
    async stop() {
      state.stopped = true;
      await loop;
      if (state.failure !== undefined) throw state.failure;
    }
  };
}

function show(value: unknown): string {
  const text = JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item));
  if (text === undefined) return 'nothing';
  return text.length > 2_000 ? `${text.slice(0, 2_000)}...` : text;
}

export interface PollOptions<T> {
  timeoutMs: number;
  intervalMs: number;
  /** Extra text for the timeout message: the page's route, an oracle verdict. */
  describe?: (last: T | undefined) => Promise<string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Re-reads until `done`, or throws naming `label`, the last read and `describe`'s text. A failed read fails at once. */
export async function pollUntil<T>(
  label: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  opts: PollOptions<T>
): Promise<T> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = now() + opts.timeoutMs;
  let last: { value: T } | undefined;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    last = { value };
    if (now() >= deadline) break;
    await sleep(Math.min(opts.intervalMs, deadline - now()));
  }
  const detail = opts.describe
    ? await opts.describe(last.value).then(
        text => `; ${text}`,
        (failure: unknown) => `; (no detail: ${errorText(failure)})`
      )
    : '';
  throw new Error(`${label}: not reached within ${opts.timeoutMs} ms; last read ${show(last.value)}${detail}`);
}

/**
 * Waits for a balance to leave `from` and then read the same twice in a row: the vault after a landed path, which
 * records no fee to say what the vault should become.
 */
export async function readSettledChange(
  read: () => Promise<bigint>,
  from: bigint,
  opts: Omit<PollOptions<bigint[]>, 'describe'>
): Promise<bigint> {
  const reads: bigint[] = [];
  const [, settled] = await pollUntil(
    `balance to move from ${from} and hold`,
    async () => {
      reads.push(await read());
      return reads.slice(-2);
    },
    ([previous, latest]) => latest !== undefined && latest !== from && latest === previous,
    opts
  );
  if (settled === undefined) throw new Error(`balance to move from ${from}: no second read`);
  return settled;
}

/** One fee term of a ledger: read off the row that paid it, or bounded from the vault on a landed path (Q5(d)). */
export interface FeeTerm {
  name: string;
  amount: bigint;
  kind: 'exact' | 'bounded';
  /** `baseFee x FEE_RESERVE_MULTIPLE`, which a bounded fee was checked against. */
  ceiling?: bigint;
}

export function boundedTerm(name: string, bound: { fee: bigint; ceiling: bigint }): FeeTerm {
  return { name, amount: bound.fee, kind: 'bounded', ceiling: bound.ceiling };
}

export type ConsumeFeePath = { kind: 'result'; fee: bigint } | { kind: 'landed' };

/**
 * How a Completed consume finished. One that kept its result recorded its fee at completion; one that completed
 * through a landed path recorded no fee and never released a result. The row snapshot carries no `resultBytes`, so
 * the recorded fee is the signal.
 */
export function consumeFeePath(row: { id: string; feeAmount?: string; resultReleasedAt?: number }): ConsumeFeePath {
  if (row.feeAmount !== undefined) {
    if (!POSITIVE_UNITS.test(row.feeAmount)) {
      throw new Error(`consume ${row.id} recorded fee ${row.feeAmount}, not a positive base-unit amount`);
    }
    return { kind: 'result', fee: BigInt(row.feeAmount) };
  }
  if (row.resultReleasedAt !== undefined) {
    throw new Error(`consume ${row.id} released its result at ${isoSeconds(row.resultReleasedAt)} but recorded no fee`);
  }
  return { kind: 'landed' };
}

export type BurnCompletionPath = { kind: 'result'; resultBytes: string } | { kind: 'landed' };

/** A Completed burn decodes its outputs from `resultBytes`, which the reaper releases 10 min after `completedAt`. */
export function burnCompletionPath(row: { resultBytes?: string; resultReleasedAt?: number }): BurnCompletionPath {
  if (row.resultBytes) return { kind: 'result', resultBytes: row.resultBytes };
  if (row.resultReleasedAt !== undefined) {
    throw new Error(
      `resultBytes released at ${isoSeconds(row.resultReleasedAt)}, 10 min after completedAt; outputs not decoded`
    );
  }
  return { kind: 'landed' };
}

function isoSeconds(seconds: number): string {
  return new Date(seconds * 1_000).toISOString();
}

/** The one item, or a throw naming how many there were. */
export function exactlyOne<T>(items: readonly T[], what: string, describe: (item: T) => string): T {
  const [only] = items;
  if (items.length !== 1 || only === undefined) {
    const listed = items.length > 0 ? `: ${items.map(describe).join('; ')}` : '';
    throw new Error(`expected exactly one ${what}, found ${items.length}${listed}`);
  }
  return only;
}

export function jsonObject(value: JsonValue | undefined): { [key: string]: JsonValue } | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

export function jsonString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** What a run attaches as its evidence JSON. Never a private key. */
export interface RunEvidence {
  suite: string;
  guardian?: { url: string; version: string; gitCommit: string; commitment: string };
  ids: Record<string, string>;
  hashes: Record<string, string>;
  fees: FeeTerm[];
  latenciesMs: Record<string, number>;
  phases: Record<string, PhaseSample[]>;
  settleMs: Record<string, number>;
  notes: string[];
}

export function newRunEvidence(suite: string): RunEvidence {
  return { suite, ids: {}, hashes: {}, fees: [], latenciesMs: {}, phases: {}, settleMs: {}, notes: [] };
}

/** The evidence as JSON with bigints as decimal strings; throws instead when any secret appears in it. */
export function evidenceJson(evidence: RunEvidence, secrets: readonly string[]): string {
  const text = JSON.stringify(
    evidence,
    (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
    2
  );
  const haystack = text.toLowerCase();
  const leaked = secrets.some(secret => {
    const digits = secret.toLowerCase().replace(/^0x/, '');
    return digits.length > 0 && haystack.includes(digits);
  });
  if (leaked) throw new Error('the evidence would contain a private key, so it was not written');
  return text;
}

/** `waitForGuardianSettled` finding no push means tracking started after the transaction, not a slow Guardian. */
export function explainSettleFailure(error: unknown): Error {
  const message = errorText(error);
  if (message.includes('no delta push was observed')) {
    return new Error(`tracking started late: ${message}`, { cause: error });
  }
  return error instanceof Error ? error : new Error(message);
}

/** Where the page is, for phase timeouts: the wallet's watcher polls only while a wallet route is visible. */
export async function describePage(url: string, visibility: () => Promise<string>): Promise<string> {
  const route = new URL(url).hash || '(no route)';
  const state = await visibility().catch((error: unknown) => `unreadable (${errorText(error)})`);
  return `page route ${route}, visibility ${state}`;
}

export function ledgerLine(terms: ReadonlyArray<readonly [string, bigint]>): string {
  return terms.map(([name, amount]) => `${name}=${amount}`).join(' ');
}

/** Matches exactly one of `texts`, as a pill reads it. */
export function anyOf(texts: readonly string[]): RegExp {
  const alternatives = texts.map(text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`^\\s*(?:${alternatives})\\s*$`);
}
```

- [ ] **Step 4: Run the unit tests and watch them pass**

```bash
yarn jest playwright/e2e/helpers/usdcx-run.test.ts --maxWorkers=2
```

Expected: `Tests: 43 passed, 43 total`.

- [ ] **Step 5: Write the failing config-selection tests for the round trip**

In `playwright/e2e/harness/spec-selection.test.ts`, directly after the describe `the USDCx live suites have a config of their own` (added by Task 25 (p5-config-isolation)), whose end reads:

```ts
    expect(source).toMatch(/timeout: 3_600_000/);
  });
});
```

insert:

```ts
const USDCX_TESTS_DIR = 'playwright/e2e/tests/usdcx';
const ROUND_TRIP_TEST =
  'usdcx-roundtrip.spec.ts › USDCx round trip: burn to a fresh Arc key, Circle payout, deposit back › ' +
  'Guardian wallet: public faucet grant, Send burn, payout and its confirmation, deposit back, receipt';
/** Every test `playwright.usdcx.config.ts` must list, and nothing else. */
const USDCX_LIVE_TESTS = [ROUND_TRIP_TEST];
/** Each runner suite's grep, compiled case-insensitive as scripts/e2e-real.mjs does, and the tests it must select. */
const USDCX_RUNNER_GREPS: Array<[grep: string, tests: string[]]> = [['USDCx round trip', [ROUND_TRIP_TEST]]];
/** Each live spec file and how many describes it guards. */
const USDCX_LIVE_SPECS: Array<[file: string, describes: number]> = [['usdcx-roundtrip.spec.ts', 1]];
/** A live USDCx spec in another config's listing. */
const USDCX_LIVE_SPEC = /usdcx-roundtrip\.spec\.ts|usdcx-burn\.spec\.ts/;

/** `playwright test --list` lines as `file › describe › test`, without the line and column. */
const listedTests = (listing: string): string[] =>
  listing.split('\n').flatMap(line => {
    const match = /^\s+(\S+\.spec\.ts):\d+:\d+ › (.+)$/.exec(line);
    return match ? [`${match[1]} › ${match[2]}`] : [];
  });

describe('the USDCx live suites run under their own config only', () => {
  let usdcxTests: string[];

  beforeAll(() => {
    usdcxTests = listedTests(listPlaywrightTests('playwright.usdcx.config.ts'));
  });

  it('playwright.usdcx.config.ts lists exactly the live USDCx tests', () => {
    expect([...usdcxTests].sort()).toEqual([...USDCX_LIVE_TESTS].sort());
  });

  it.each(USDCX_RUNNER_GREPS)('the runner grep "%s" selects only its own tests', (grep, tests) => {
    expect(usdcxTests.filter(listed => new RegExp(grep, 'i').test(listed))).toEqual(tests);
  });

  it.each(['playwright.e2e.config.ts', 'playwright.bridge.config.ts'])('%s lists no live USDCx spec', config => {
    expect(listPlaywrightTests(config)).not.toMatch(USDCX_LIVE_SPEC);
  });

  it('no live USDCx spec is named into the Guardian or bridge-guardian config', () => {
    const named = readdirSync(resolve(repoRoot, USDCX_TESTS_DIR)).filter(
      name => /^guardian-.*\.spec\.ts$/.test(name) || name === 'bridge-out-epoch-guardian.spec.ts'
    );
    expect(named).toEqual([]);
  });

  it.each(USDCX_LIVE_SPECS)('%s throws instead of skipping outside the runner', (file, describes) => {
    const source = configSource(`${USDCX_TESTS_DIR}/${file}`);
    expect(source).not.toMatch(/test\.skip\(/);
    expect(source.match(/test\.beforeAll\(\(\) => assertUsdcxLiveRun\(process\.env, /g)).toHaveLength(describes);
  });
});
```

Mutation notes:
- `playwright.usdcx.config.ts lists exactly the live USDCx tests`: delete the round-trip describe from the spec; the listing is empty (Playwright exits 1, `No tests found`) and the hook fails.
- `the runner grep "USDCx round trip" selects only its own tests`: rename the describe to `USDCx roundtrip: ...`; the filter returns `[]`.
- `playwright.e2e.config.ts lists no live USDCx spec`: delete `'**/usdcx/**'` from the base `testIgnore`; the base listing names `usdcx/usdcx-roundtrip.spec.ts`.
- `playwright.bridge.config.ts lists no live USDCx spec`: move the spec to `tests/bridge/`; the bridge listing names it.
- `no live USDCx spec is named into the Guardian or bridge-guardian config`: rename the spec `guardian-usdcx-roundtrip.spec.ts`; `named` is not `[]`.
- `usdcx-roundtrip.spec.ts throws instead of skipping outside the runner`: replace the `test.beforeAll` guard with `test.skip(process.env.E2E_REAL_USDCX !== 'true')`; both expectations fail.

- [ ] **Step 6: Run them and watch them fail**

```bash
yarn jest playwright/e2e/harness/spec-selection.test.ts -t 'run under their own config only' --maxWorkers=2
```

Expected: all 6 tests in the describe fail. The `beforeAll` listing throws `Command failed: <repo>/node_modules/.bin/playwright test --list --reporter list --config playwright.usdcx.config.ts` with `Error: No tests found` in its output (tests/usdcx does not exist yet), and `usdcx-roundtrip.spec.ts throws instead of skipping outside the runner` also reads `ENOENT: no such file or directory, open '<repo>/playwright/e2e/tests/usdcx/usdcx-roundtrip.spec.ts'`.

- [ ] **Step 7: Write the grant and burn legs**

Create `playwright/e2e/helpers/usdcx-legs.ts`:

```ts
import { expect, type Page, type TestInfo } from '@playwright/test';
import { isHash, type Address, type Hash } from 'viem';

import {
  fromBaseUnits,
  vaultBalanceOfCurrentAccount,
  waitForVaultBalanceOfCurrentAccount,
  walletDiscoveredBaseFee,
  walletDiscoveredNativeFaucetId
} from './balance-truth';
import { bridgeOutUsdcx, enText, readBridgedSendRows, readNativeDisplaySymbol, type BridgedSendRow } from './bridge';
import {
  describeTransactionRow,
  openHistoryDetails,
  readTransactionRows,
  TxStatus,
  type TransactionRowSnapshot
} from './history';
import { mintFromPublicFaucet, publicFaucetApiUrl } from './public-faucet';
import { waitForPublicNoteCommitment } from './public-note-commitment';
import { ARC_CHAIN_ID, ARC_CIRCLE_DOMAIN, BURN_UNITS, GRANT_MARGIN_UNITS, USDCX_BURN_TAG } from './usdcx-constants';
import { assertNoGuardianOpInFlight, burnFailureMessage } from './usdcx-guardian';
import {
  accountHex,
  bareId,
  boundLandedFee,
  burnEvidence,
  burnOutputs,
  note,
  nullifier,
  type BurnEvidence
} from './usdcx-miden';
import {
  anyOf,
  boundedTerm,
  burnCompletionPath,
  consumeFeePath,
  describePage,
  errorText,
  evidenceJson,
  exactlyOne,
  explainSettleFailure,
  ledgerLine,
  PhaseTimeline,
  pollUntil,
  readSettledChange,
  type FeeTerm,
  type RunEvidence,
  type StepContext
} from './usdcx-run';
import { USDCX_DECIMALS } from '../../../src/lib/usdcx/constant';
import { ARC_TESTNET } from '../../../src/lib/walletconnect/config';
import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';

/**
 * The legs the live USDCx specs share: a Guardian or standard wallet funded by one public faucet grant, and a burn
 * through Send to an Arc key. Their pure decisions live in usdcx-run.ts, which has the unit tests; this file is the
 * live wiring, run by `yarn e2e:real --suite usdcx|usdcx-in|usdcx-burn`.
 */

const VAULT_TIMEOUT_MS = 120_000;
const ARC_EXPLORER = ARC_TESTNET.blockExplorers.default.url;

/** A wallet's ids in each form the run needs: composite for the wallet, bare bech32 and hex for the Node oracle. */
export interface UsdcxWalletIds {
  address: string;
  bare: string;
  accountHex: string;
  /** The native (fee) faucet as the wallet discovered it, composite like every `feeFaucetId` the wallet writes. */
  native: string;
  nativeBare: string;
  nativeHex: string;
  baseFee: number;
}

/** The route and visibility of the wallet's page, for phase timeouts. */
export function pageWhere(wallet: GuardianAwareWalletPage): StepContext {
  return () => describePage(wallet.page.url(), () => wallet.page.evaluate(() => document.visibilityState));
}

/**
 * The native faucet and base fee the wallet discovered for itself, and the Node-side ids. The fee faucet comes from the
 * wallet, never from the public faucet API, whose `id` is its distributor wallet rather than the USDCx faucet.
 */
export async function resolveUsdcxIds(page: Page, address: string): Promise<UsdcxWalletIds> {
  const discovered = await pollUntil(
    'native asset discovery',
    async () => ({ native: await walletDiscoveredNativeFaucetId(page), baseFee: await walletDiscoveredBaseFee(page) }),
    found => found.native !== null && found.baseFee !== null,
    { timeoutMs: 120_000, intervalMs: 2_000 }
  );
  if (discovered.native === null || discovered.baseFee === null) {
    throw new Error('native asset discovery found nothing');
  }
  const bare = bareId(address);
  const nativeBare = bareId(discovered.native);
  return {
    address,
    bare,
    accountHex: await accountHex(bare),
    native: discovered.native,
    nativeBare,
    nativeHex: await accountHex(nativeBare),
    baseFee: discovered.baseFee
  };
}

async function currentAccountType(page: Page): Promise<string> {
  return page.evaluate(() => {
    const store: { getState?: () => { currentAccount?: { type?: string } | null } } | undefined = Reflect.get(
      window,
      '__TEST_STORE__'
    );
    return store?.getState?.().currentAccount?.type ?? '';
  });
}

/** Spec 5 step 1: a fresh Guardian wallet bound to `guardianUrl`, tracked before its first transaction. */
export async function createGuardianUsdcxWallet(wallet: GuardianAwareWalletPage, guardianUrl: string): Promise<string> {
  const { address } = await wallet.createGuardianWallet(guardianUrl);
  // A reused profile could hold another run's account, whose rows and vault would break every exact ledger here.
  if (!wallet.ownsProfile) throw new Error('wallet A runs on a profile this run did not create');
  // Before the grant consume, the account's first push: tracking that starts later finds no push to settle.
  wallet.trackGuardianCommitments();
  await pollUntil(
    'the new account binding to the Guardian',
    async () => ({ endpoint: await wallet.currentGuardianEndpoint(), type: await currentAccountType(wallet.page) }),
    bound => bound.endpoint === guardianUrl && bound.type === 'guardian',
    { timeoutMs: 120_000, intervalMs: 2_000 }
  );
  return address;
}

/** `waitForGuardianSettled`, timed; a missing push reads as tracking that started late. */
export async function settleGuardian(wallet: GuardianAwareWalletPage, timeoutMs: number): Promise<number> {
  const started = Date.now();
  await wallet.waitForGuardianSettled(timeoutMs).catch((error: unknown) => {
    throw explainSettleFailure(error);
  });
  return Date.now() - started;
}

/** The one consume row whose notes include `noteId`, once Completed; a Failed one fails the run with its stage. */
export async function waitForConsumeOf(
  page: Page,
  noteId: string,
  label: string,
  timeoutMs: number,
  where: StepContext
): Promise<TransactionRowSnapshot> {
  const wanted = noteId.toLowerCase();
  const row = await pollUntil(
    `${label} consume of note ${noteId}`,
    async () => {
      const rows = (await readTransactionRows(page)).filter(
        candidate => candidate.type === 'consume' && (candidate.noteIds ?? []).some(id => id.toLowerCase() === wanted)
      );
      if (rows.length > 1) {
        throw new Error(
          `${rows.length} consume rows carry note ${noteId}: ${rows.map(describeTransactionRow).join('; ')}`
        );
      }
      const [found] = rows;
      // Unconfirmed (4) waits for the node's verdict and keeps polling; only Completed ends the wait.
      if (found?.status === TxStatus.Failed) {
        throw new Error(
          `${label} consume ${found.id} failed at stage ${found.stage ?? 'unknown'}: ` +
            `${found.rawError ?? found.error ?? 'no error recorded'}`
        );
      }
      return found;
    },
    found => found?.status === TxStatus.Completed,
    { timeoutMs, intervalMs: 3_000, describe: () => where() }
  );
  if (!row) throw new Error(`${label} consume of note ${noteId} disappeared`);
  return row;
}

async function exactVault(
  page: Page,
  native: string,
  expected: bigint,
  terms: ReadonlyArray<readonly [string, bigint]>
): Promise<bigint> {
  await waitForVaultBalanceOfCurrentAccount(page, native, expected, { timeoutMs: VAULT_TIMEOUT_MS }).catch(
    (error: unknown) => {
      throw new Error(`ledger ${ledgerLine(terms)}: expected vault ${expected}; ${errorText(error)}`, { cause: error });
    }
  );
  return expected;
}

/**
 * A landed path (reconcile-unconfirmed.ts:130-134, transaction/index.ts:1464-1467) records no fee, so the fee is the
 * vault's debit less the known terms, held to `0 < fee <= baseFee x FEE_RESERVE_MULTIPLE` (Q5(d)).
 */
function landedFee(name: string, args: { vaultDelta: bigint; knownTerms: bigint; baseFee: number }): FeeTerm {
  try {
    return boundedTerm(name, boundLandedFee(args));
  } catch (error) {
    throw new Error(`${name} took a landed path (no resultBytes, no resultReleasedAt): ${errorText(error)}`, {
      cause: error
    });
  }
}

/**
 * A Completed consume's fee and the vault after it. A consume that kept its result recorded its fee, so the vault
 * must land exactly; one that completed through a landed path recorded none, so its fee is bounded from the settled
 * vault instead (Q5(d)).
 */
export async function consumeFeeAndVault(
  page: Page,
  ids: UsdcxWalletIds,
  consume: TransactionRowSnapshot,
  ledger: { fee: string; vaultBefore: bigint; credit: bigint; terms: ReadonlyArray<readonly [string, bigint]> }
): Promise<{ fee: FeeTerm; vault: bigint }> {
  const path = consumeFeePath(consume);
  if (path.kind === 'result' && consume.feeFaucetId !== ids.native) {
    throw new Error(`consume ${consume.id} paid its fee in ${consume.feeFaucetId ?? 'nothing'}, not ${ids.native}`);
  }
  const vault =
    path.kind === 'result'
      ? await exactVault(page, ids.native, ledger.vaultBefore + ledger.credit - path.fee, [
          ...ledger.terms,
          [ledger.fee, path.fee]
        ])
      : await readSettledChange(() => vaultBalanceOfCurrentAccount(page, ids.native), ledger.vaultBefore, {
          timeoutMs: VAULT_TIMEOUT_MS,
          intervalMs: 4_000
        });
  const fee: FeeTerm =
    path.kind === 'result'
      ? { name: ledger.fee, amount: path.fee, kind: 'exact' }
      : landedFee(ledger.fee, {
          vaultDelta: ledger.vaultBefore - vault,
          // A consume credits the vault, so its known term enters the debit negated.
          knownTerms: -ledger.credit,
          baseFee: ids.baseFee
        });
  return { fee, vault };
}

export interface GrantFunding {
  grantNoteId: Hash;
  grant: bigint;
  grantTag?: number;
  consumeId: string;
  f0: FeeTerm;
  vault: bigint;
}

/**
 * Spec 5 step 3: one public faucet grant, which the service worker consumes by itself (a claim call would add a
 * second consume row). The grant consume is also the account's deploy.
 */
export async function fundFromPublicFaucet(
  page: Page,
  ids: UsdcxWalletIds,
  rpcUrl: string,
  where: StepContext
): Promise<GrantFunding> {
  const faucetApi = publicFaucetApiUrl('testnet');
  if (!faucetApi) throw new Error('the harness names no public faucet for testnet');
  // No amount: the helper asks for what the wallet's Fund button asks for, and once more at a cap the faucet names.
  const { noteId } = await mintFromPublicFaucet(faucetApi, ids.bare);
  if (!isHash(noteId)) throw new Error(`the public faucet returned note id ${noteId}, not 32 bytes of hex`);
  await waitForPublicNoteCommitment(rpcUrl, noteId, 60_000);
  // G is what the node holds in the note, not what the faucet said it would grant.
  const grantNote = await note(rpcUrl, noteId);
  const asset = exactlyOne(
    grantNote.assets,
    `asset on grant note ${noteId}`,
    item => `${item.faucetHex} ${item.amount}`
  );
  expect(asset.faucetHex.toLowerCase(), 'the grant is the native (USDCx) asset').toBe(ids.nativeHex.toLowerCase());
  const consume = await waitForConsumeOf(page, noteId, 'grant', 90_000, where);
  const { fee: f0, vault } = await consumeFeeAndVault(page, ids, consume, {
    fee: 'f0',
    vaultBefore: 0n,
    credit: asset.amount,
    terms: [['G', asset.amount]]
  });
  if (vault < BURN_UNITS + GRANT_MARGIN_UNITS) {
    throw new Error(
      `faucet granted ${asset.amount}, need >= ${fromBaseUnits(BURN_UNITS + GRANT_MARGIN_UNITS, USDCX_DECIMALS)} ` +
        `USDCx after the ${f0.amount} fee`
    );
  }
  return { grantNoteId: noteId, grant: asset.amount, grantTag: grantNote.tag, consumeId: consume.id, f0, vault };
}

/** Spec 5 step 6: the burn through Send; resolves with the bridged-send rows that existed before it. */
export async function submitBurn(
  wallet: GuardianAwareWalletPage,
  ids: UsdcxWalletIds,
  opts: { destination: Address; units: bigint; screenshotDir: string }
): Promise<ReadonlySet<string>> {
  // A Guardian burn is not requeued on a pending-delta 409 (transaction/index.ts:196-202), so nothing may be in flight.
  assertNoGuardianOpInFlight(await readTransactionRows(wallet.page), ids.address);
  const prior = new Set((await readBridgedSendRows(wallet.page)).map(row => row.id));
  await bridgeOutUsdcx(wallet, {
    destAddress: opts.destination,
    amount: fromBaseUnits(opts.units, USDCX_DECIMALS),
    nativeTokenId: ids.native,
    nativeSymbol: await readNativeDisplaySymbol(wallet.page, ids.native),
    screenshotDir: opts.screenshotDir
  });
  // The burn and destination watchers poll from the provider while a wallet route is visible.
  await wallet.navigateHome();
  return prior;
}

export interface BurnLeg {
  row: BridgedSendRow;
  burnNoteId: Hash;
  fee: FeeTerm;
  sponsorship: bigint;
  vault: bigint;
  oracle: BurnEvidence;
  arcFromBlock: bigint;
  phases: PhaseTimeline;
}

export interface ConfirmBurnOptions {
  priorRowIds: ReadonlySet<string>;
  destination: Address;
  units: bigint;
  vaultBefore: bigint;
  rpcUrl: string;
  guardian: boolean;
  timeoutMs: number;
  where: StepContext;
}

async function burnVerdict(noteId: string | undefined, rpcUrl: string): Promise<string> {
  if (!noteId || !isHash(noteId)) return 'no burn note id to look up';
  try {
    if (!(await note(rpcUrl, noteId)).committed) return 'never committed (expired after the 20-block cap)';
    const spent = await nullifier(rpcUrl, noteId);
    return spent.committed
      ? `consumed by the faucet in block ${spent.blockNum ?? 'unknown'}`
      : 'committed, faucet has not consumed';
  } catch (error) {
    return `oracle unavailable (${errorText(error)})`;
  }
}

async function burnStuckReport(last: BridgedSendRow | undefined, rpcUrl: string, where: StepContext): Promise<string> {
  const burn = last?.extraInputs?.usdcxBurn;
  return [
    `status ${last?.status ?? 'no row'}, phase ${burn?.phase ?? 'none'}, lastError ${burn?.lastError ?? 'none'}, ` +
      `attemptCount ${burn?.attemptCount ?? 'unset'}, lastAttemptBlockNum ${burn?.lastAttemptBlockNum ?? 'unset'}`,
    await burnVerdict(burn?.noteId, rpcUrl),
    await where()
  ].join('; ');
}

/** The fee and sponsorship a burn's own outputs carry; they must name the row's burn note and fee exactly. */
async function decodeBurnTerms(
  resultBytes: string,
  row: BridgedSendRow,
  burnNoteId: Hash,
  ids: UsdcxWalletIds,
  units: bigint,
  liveSponsorship: bigint
): Promise<{ fee: bigint; sponsorship: bigint }> {
  const outputs = await burnOutputs({ resultBytesBase64: resultBytes, burnNoteId, faucetBech32: ids.nativeBare });
  const mismatches = [
    outputs.burn.noteId.toLowerCase() === burnNoteId.toLowerCase()
      ? null
      : `burn note ${outputs.burn.noteId}, row names ${burnNoteId}`,
    outputs.burn.amount === units ? null : `burn amount ${outputs.burn.amount}, sent ${units}`,
    outputs.sponsorship.amount === liveSponsorship
      ? null
      : `sponsorship ${outputs.sponsorship.amount}, live fee_schedule ${liveSponsorship}`,
    row.feeAmount === outputs.fee.amount.toString()
      ? null
      : `fee note ${outputs.fee.amount}, row feeAmount ${row.feeAmount ?? 'unset'}`,
    row.feeFaucetId === ids.native ? null : `fee paid in ${row.feeFaucetId ?? 'nothing'}, not ${ids.native}`
  ].filter((text): text is string => text !== null);
  if (mismatches.length > 0) throw new Error(`burn ${row.id} outputs disagree: ${mismatches.join('; ')}`);
  return { fee: outputs.fee.amount, sponsorship: outputs.sponsorship.amount };
}

/**
 * Spec 5 step 7: the burn row reaches `confirmed`, its outputs and the vault agree to the base unit, and the node
 * shows the row's burn note, consumed by the faucet. The first read that carries `resultBytes` is kept: the reaper
 * releases them 10 min after `completedAt`.
 */
export async function confirmBurn(
  wallet: GuardianAwareWalletPage,
  ids: UsdcxWalletIds,
  opts: ConfirmBurnOptions
): Promise<BurnLeg> {
  const page = wallet.page;
  const phases = new PhaseTimeline('USDCx burn', ['pending', 'consuming', 'confirmed']);
  const kept: { withResult?: BridgedSendRow } = {};
  const row = await pollUntil(
    'USDCx burn row to reach confirmed',
    async () => {
      const rows = (await readBridgedSendRows(page)).filter(
        candidate => candidate.extraInputs?.provider === 'usdcx' && !opts.priorRowIds.has(candidate.id)
      );
      if (rows.length > 1) {
        throw new Error(`the burn queued ${rows.length} usdcx rows: ${rows.map(r => r.id).join(', ')}`);
      }
      const [found] = rows;
      // Unconfirmed (4) is pending: a burn whose submit outcome is unknown waits for the node's verdict.
      if (found?.status === TxStatus.Failed) throw new Error(burnFailureMessage(found));
      phases.record(found?.extraInputs?.usdcxBurn?.phase, Date.now());
      if (found?.resultBytes) kept.withResult ??= found;
      return found;
    },
    found => found?.status === TxStatus.Completed && found.extraInputs?.usdcxBurn?.phase === 'confirmed',
    {
      timeoutMs: opts.timeoutMs,
      intervalMs: 3_000,
      describe: last => burnStuckReport(last, opts.rpcUrl, opts.where)
    }
  );
  if (!row) throw new Error('the burn row disappeared');
  phases.assertMonotone();
  const burn = row.extraInputs?.usdcxBurn;
  if (!burn) throw new Error(`burn row ${row.id} has no usdcxBurn record`);
  const burnNoteId = burn.noteId;
  if (!isHash(burnNoteId)) throw new Error(`burn row ${row.id} names note ${burnNoteId}, not 32 bytes of hex`);

  // The node, not the row, proves the burn: its amount, tag, scheme-5 target and sender, and the faucet's consume.
  const oracle = await burnEvidence(opts.rpcUrl, {
    faucetBech32: ids.nativeBare,
    noteId: burnNoteId,
    senderBech32: ids.bare,
    domain: ARC_CIRCLE_DOMAIN,
    recipient: opts.destination,
    amount: opts.units
  });
  expect(
    {
      amount: oracle.amount,
      tag: oracle.tag,
      sender: oracle.senderHex.toLowerCase(),
      domain: oracle.domain,
      recipient: oracle.recipient.toLowerCase(),
      nullifierCommitted: oracle.nullifierCommitted
    },
    `the node's view of burn note ${burnNoteId}`
  ).toEqual({
    amount: opts.units,
    tag: USDCX_BURN_TAG,
    sender: ids.accountHex.toLowerCase(),
    domain: ARC_CIRCLE_DOMAIN,
    recipient: opts.destination.toLowerCase(),
    nullifierCommitted: true
  });
  expect(oracle.scriptRoot).toMatch(/^0x[0-9a-f]{64}$/i);
  // A missing schedule entry would read as a zero sponsorship and hide inside a bounded fee.
  if (oracle.sponsorshipUnits <= 0n) {
    throw new Error(`the faucet's fee_schedule names no sponsorship for burn root ${oracle.scriptRoot}`);
  }

  const resultRow = kept.withResult ?? row;
  const path = burnCompletionPath(resultRow);
  const decoded =
    path.kind === 'result'
      ? await decodeBurnTerms(path.resultBytes, resultRow, burnNoteId, ids, opts.units, oracle.sponsorshipUnits)
      : undefined;
  const sponsorship = decoded?.sponsorship ?? oracle.sponsorshipUnits;
  const terms: Array<readonly [string, bigint]> = [
    ['V1', opts.vaultBefore],
    ['N', opts.units],
    ['s', sponsorship]
  ];
  const vault = decoded
    ? await exactVault(page, ids.native, opts.vaultBefore - (opts.units + decoded.fee + sponsorship), [
        ...terms,
        ['f1', decoded.fee]
      ])
    : await readSettledChange(() => vaultBalanceOfCurrentAccount(page, ids.native), opts.vaultBefore, {
        timeoutMs: VAULT_TIMEOUT_MS,
        intervalMs: 4_000
      });
  const fee: FeeTerm = decoded
    ? { name: 'f1', amount: decoded.fee, kind: 'exact' }
    : landedFee('f1', {
        vaultDelta: opts.vaultBefore - vault,
        knownTerms: opts.units + sponsorship,
        baseFee: ids.baseFee
      });

  // Saved before the burn was queued (burn.ts:103,116-121); the payout scan starts at its block.
  const before = burn.destinationBalanceBefore;
  expect(before?.balance, 'a fresh Arc key holds no USDC before the burn').toBe('0');
  expect(before?.blockNumber).toMatch(/^[1-9]\d*$/);
  const requiredStages = opts.guardian ? ['creating-proposal', 'signing-proposal'] : [];
  expect(Object.keys(row.stageTimestamps ?? {})).toEqual(expect.arrayContaining(requiredStages));
  expect({
    destination: row.extraInputs?.destinationAddress?.toLowerCase(),
    network: row.extraInputs?.destinationNetwork,
    domain: burn.destinationDomain
  }).toEqual({ destination: opts.destination.toLowerCase(), network: ARC_CHAIN_ID, domain: ARC_CIRCLE_DOMAIN });
  expect(row.transactionId).toMatch(/^0x[0-9a-f]+$/);
  expect(row.outputNoteIds ?? []).toContain(burnNoteId);
  return {
    row,
    burnNoteId,
    fee,
    sponsorship,
    vault,
    oracle,
    arcFromBlock: BigInt(before?.blockNumber ?? '0'),
    phases
  };
}

/** Spec 5 step 7: the burn's details read Burn confirmed (or Confirmed once paid), name Arc Testnet and link the key. */
export async function assertBurnDetails(
  wallet: GuardianAwareWalletPage,
  rowId: string,
  destination: Address
): Promise<void> {
  await openHistoryDetails(wallet, rowId);
  const page = wallet.page;
  await expect(page.getByTestId('history-status-pill')).toHaveText(
    anyOf([enText('usdcxBurnConfirmed'), enText('confirmed')])
  );
  await expect(page.locator(`a[href="${ARC_EXPLORER}/address/${destination}" i]`)).toBeVisible();
  await expect(page.getByText(ARC_TESTNET.name, { exact: true }).first()).toBeVisible();
}

/** The details pill of `rowId` as it reads once rendered. */
export async function historyPill(wallet: GuardianAwareWalletPage, rowId: string): Promise<string> {
  await openHistoryDetails(wallet, rowId);
  const pill = wallet.page.getByTestId('history-status-pill');
  await pill.waitFor({ state: 'visible', timeout: 30_000 });
  return ((await pill.textContent()) ?? '').trim();
}

/**
 * The receiving-tx link's hash if the open details page renders it within `timeoutMs`, else null. The link is a
 * best-effort RPC match the details page looks up once (Q7), so its absence is recorded, never failed.
 */
export async function receivingTxHash(page: Page, timeoutMs: number): Promise<string | null> {
  const link = page.locator(`a[href^="${ARC_EXPLORER}/tx/"]`).first();
  const rendered = await link.waitFor({ state: 'attached', timeout: timeoutMs }).then(
    () => true,
    () => false
  );
  if (!rendered) return null;
  const href = (await link.getAttribute('href')) ?? '';
  return href.slice(href.lastIndexOf('/') + 1).toLowerCase();
}

/** Attaches the run's evidence; throws instead when a private key would be written. */
export async function attachEvidence(
  info: TestInfo,
  name: string,
  evidence: RunEvidence,
  secrets: readonly string[]
): Promise<void> {
  await info.attach(name, { body: evidenceJson(evidence, secrets), contentType: 'application/json' });
}
```

- [ ] **Step 8: Write the round-trip spec**

Create `playwright/e2e/tests/usdcx/usdcx-roundtrip.spec.ts`:

```ts
import type { Hex } from 'viem';

import { matchUsdcxDepositAttestation } from '../../../../src/lib/usdcx/attestation';
import { CIRCLE_USDC_DECIMALS } from '../../../../src/lib/usdcx/constant';
import { midenAccountHexToXReserveRecipient } from '../../../../src/lib/usdcx/recipient';
import { expect, test, type GuardianAwareWalletPage } from '../../fixtures/two-wallets';
import {
  arcEndpoints,
  assertDepositIntent,
  confirmDepositToMiden,
  newArcKey,
  readArcUsdc,
  readXReserveDomainState,
  recordArcKey,
  submitDepositToMiden,
  waitForGatewayPayout,
  waitForXReserveAttestation,
  type ArcKey,
  type ArcWriteDeps,
  type DecodedDepositIntent,
  type DepositSubmission,
  type GatewayPayout,
  type XReserveDomainState
} from '../../helpers/arc-usdcx';
import { fromBaseUnits } from '../../helpers/balance-truth';
import { bridgeReceiveState, createUsdcxBridgeReceive, enText, readBridgedSendRows } from '../../helpers/bridge';
import { describeTransactionRow, openHistoryDetails, readTransactionRow } from '../../helpers/history';
import {
  ARC_ATTESTATION_API,
  ARC_CHAIN_ID,
  ARC_CIRCLE_DOMAIN,
  ARC_PUBLIC_URL,
  ARC_USDC,
  BURN_UNITS,
  DEPOSIT_UNITS,
  GAS_RESERVE_UNITS,
  minimumUsdcxPayout,
  PAYOUT_TIMEOUT_MS,
  USDCX_REMOTE_DOMAIN,
  WALLET_CONFIRM_TIMEOUT_MS
} from '../../helpers/usdcx-constants';
import { guardianFailureContext, guardianIdentity, type GuardianIdentity } from '../../helpers/usdcx-guardian';
import {
  assertBurnDetails,
  attachEvidence,
  confirmBurn,
  consumeFeeAndVault,
  createGuardianUsdcxWallet,
  fundFromPublicFaucet,
  historyPill,
  pageWhere,
  receivingTxHash,
  resolveUsdcxIds,
  settleGuardian,
  submitBurn,
  waitForConsumeOf,
  type BurnLeg,
  type UsdcxWalletIds
} from '../../helpers/usdcx-legs';
import { deriveUsdcxMintNoteId, waitForUsdcxMint, type MidenNoteRead } from '../../helpers/usdcx-miden';
import {
  assertUsdcxLiveRun,
  errorText,
  jsonObject,
  jsonString,
  ledgerLine,
  namedSteps,
  newRunEvidence,
  PhaseTimeline,
  pollUntil,
  sampleInBackground,
  type FeeTerm,
  type NamedStep,
  type RunEvidence,
  type StepContext
} from '../../helpers/usdcx-run';

/**
 * Live USDCx on testnet with a fresh Guardian wallet on the hosted Guardian (playwright/e2e/docs/e2e-architecture.md,
 * section 8). Run only through `yarn e2e:real --suite usdcx` or `--suite usdcx-in`: both describes throw, never skip,
 * without the runner's environment.
 */

/** Step budgets of spec sections 5 and 6, each a small multiple of the spike's step time. */
const BUDGET = {
  guardianWallet: 180_000,
  arcState: 30_000,
  fund: 180_000,
  settle: 240_000,
  freshKey: 10_000,
  fundedKey: 10_000,
  burnViaUi: 180_000,
  burnRowPoll: 180_000,
  burnConfirmed: 300_000,
  payout: PAYOUT_TIMEOUT_MS + 120_000,
  walletPayoutConfirmed: WALLET_CONFIRM_TIMEOUT_MS + 60_000,
  depositSubmit: 120_000,
  trackingRows: 10_000,
  depositConfirm: 120_000,
  attest: 120_000,
  mint: 180_000,
  receive: 360_000,
  check: 10_000
} as const;

const SETTLE_WAIT_MS = 120_000;
const RECEIVING_TX_LINK_MS = 15_000;

/**
 * A real Arc deposit Circle attested, with this token and amount, to Miden account 0x8da911727d5b53916f2c221c00c091.
 * Claimed for this run's account, it must end `failed`, never `ready`.
 */
const FOREIGN_DEPOSIT = {
  amount: '2000000000',
  sourceAddress: '0xe88f781e6cc8b7496f259200b57e22cb9457ff99',
  sourceAmount: '2000',
  evmTxHash: '0x370bf19aefa34f6f07d7b731d5b5f323a364c6f4116a22768d4e44a16ffeca4d'
} as const;
const FOREIGN_RECIPIENT_ERROR = 'Circle attested this deposit to a different Miden account.';

interface ReceiveTracker {
  positive: PhaseTimeline;
  negative: { id: string; timeline: PhaseTimeline; error(): string | undefined } | null;
  stop(): Promise<void>;
}

interface DepositRun {
  submission: DepositSubmission;
  positiveId: string;
  tracker: ReceiveTracker;
  intent: DecodedDepositIntent;
  attestedAt: number;
  mintNoteId: Hex;
  mint: MidenNoteRead;
}

interface DepositOptions {
  key: ArcKey;
  /** USDC base units the key holds, which must cover the deposit and its gas. */
  keyBalance: bigint;
  approve: 'exact' | 'if-short';
  arc: ArcWriteDeps;
  xreserve: XReserveDomainState;
  rpcUrl: string;
  withNegative: boolean;
  /** Miden block from which the faucet's notes to this account count as recent, for the mint failure's listing. */
  sinceBlock: number;
  /** The tag the grant note carried to this account; the mint note must route the same way. */
  accountTag?: number;
  evidence: RunEvidence;
  cleanups: Array<() => Promise<void>>;
}

interface ReceiveOptions {
  vaultBefore: bigint;
  terms: ReadonlyArray<readonly [string, bigint]>;
  where: StepContext;
  onGuardian: StepContext;
  evidence: RunEvidence;
}

/** Spec 5 step 1: a fresh Guardian wallet on the hosted Guardian, with that Guardian's identity recorded. */
async function guardianWallet(
  wallet: GuardianAwareWalletPage,
  guardianUrl: string,
  evidence: RunEvidence
): Promise<{ identity: GuardianIdentity; ids: UsdcxWalletIds }> {
  const identity = await guardianIdentity(guardianUrl);
  evidence.guardian = {
    url: identity.url,
    version: identity.version,
    gitCommit: identity.gitCommit,
    commitment: identity.commitment
  };
  const address = await createGuardianUsdcxWallet(wallet, guardianUrl);
  const ids = await resolveUsdcxIds(wallet.page, address);
  evidence.ids.address = ids.address;
  evidence.ids.native = ids.native;
  return { identity, ids };
}

/**
 * Samples both tracking rows every 2 s from the moment they exist. The mint lands ~30 s after the attestation and the
 * receive step starts only then, so a POSITIVE row can pass through `ready` long before anything else looks at it.
 */
function trackReceiveRows(
  wallet: GuardianAwareWalletPage,
  positiveId: string,
  negativeId: string | undefined
): ReceiveTracker {
  const positive = new PhaseTimeline('POSITIVE bridged-receive', ['delivering', 'ready', 'received']);
  const negative = new PhaseTimeline('NEGATIVE bridged-receive', ['delivering', 'failed']);
  const negativeState: { error?: string } = {};
  const sampler = sampleInBackground(async () => {
    const at = Date.now();
    positive.record((await bridgeReceiveState(wallet, positiveId)).phase, at);
    const foreign = negativeId === undefined ? undefined : await bridgeReceiveState(wallet, negativeId);
    negative.record(foreign?.phase, at);
    negativeState.error = foreign?.error ?? negativeState.error;
    return positive.last() === 'received' && (negativeId === undefined || negative.last() === 'failed');
  }, 2_000);
  return {
    positive,
    negative:
      negativeId === undefined ? null : { id: negativeId, timeline: negative, error: () => negativeState.error },
    stop: () => sampler.stop()
  };
}

/** Spec 5 steps 9 to 13: a Node-signed deposit from `key`, its tracking rows, Circle's attestation and the mint. */
async function depositLeg(
  step: NamedStep,
  wallet: GuardianAwareWalletPage,
  ids: UsdcxWalletIds,
  opts: DepositOptions
): Promise<DepositRun> {
  // R is derived in Node from the account id, apart from the wallet's own derivation (usdcx/deposit-target.ts).
  const recipient = midenAccountHexToXReserveRecipient(ids.accountHex);
  const submission = await step('deposit_submit', BUDGET.depositSubmit, async () => {
    if (opts.keyBalance < DEPOSIT_UNITS + GAS_RESERVE_UNITS) {
      throw new Error(
        `key ${opts.key.address} holds ${opts.keyBalance} USDC base units, ` +
          `needs ${DEPOSIT_UNITS + GAS_RESERVE_UNITS} for the deposit and its gas`
      );
    }
    const submission = await submitDepositToMiden(
      { privateKey: opts.key.privateKey, units: DEPOSIT_UNITS, recipientHex: ids.accountHex, approve: opts.approve },
      opts.arc
    );
    // A fresh key has no allowance, so its deposit must approve exactly the deposit amount first (deposit.ts:101-104).
    if (opts.approve === 'exact' && (!submission.approved || !submission.approveHash)) {
      throw new Error(`the fresh key's deposit ${submission.depositHash} sent no approve`);
    }
    return submission;
  });
  opts.evidence.hashes.deposit = submission.depositHash;
  opts.evidence.hashes.approve = submission.approveHash ?? 'none';
  opts.evidence.notes.push(
    `deposit approve (${opts.approve}) ${submission.approved ? 'sent' : 'not needed'} via ${submission.endpoint}`
  );

  // The hook persists no recipient, so both rows exercise the reconciler's derive-from-row path. `provider` and
  // `sourceChainId` keep them off the Epoch branch and the legacy Sepolia default (bridge-receive.ts:128-134,235-245).
  const rows = await step('tracking_rows', BUDGET.trackingRows, async () => {
    const shared = { accountId: ids.address, faucetId: ids.native, sourceChainId: ARC_CHAIN_ID, sourceSymbol: 'USDC' };
    const positiveId = await createUsdcxBridgeReceive(wallet, {
      ...shared,
      amount: DEPOSIT_UNITS.toString(),
      sourceAddress: opts.key.address,
      sourceAmount: fromBaseUnits(DEPOSIT_UNITS, CIRCLE_USDC_DECIMALS),
      evmTxHash: submission.depositHash
    });
    // A real attested deposit to another account: the reconciler must fail it on the recipient, never mark it ready.
    const negativeId = opts.withNegative
      ? await createUsdcxBridgeReceive(wallet, { ...shared, ...FOREIGN_DEPOSIT })
      : undefined;
    return { positiveId, negativeId };
  });
  opts.evidence.ids.positiveRow = rows.positiveId;
  opts.evidence.ids.negativeRow = rows.negativeId ?? 'none';
  const tracker = trackReceiveRows(wallet, rows.positiveId, rows.negativeId);
  opts.cleanups.push(() => tracker.stop().catch(() => undefined));

  // maxFee 0 and empty hookData are what the product signs (usdcx/constant.ts:342-344).
  await step('deposit_confirm', BUDGET.depositConfirm, async () => {
    const { event } = await confirmDepositToMiden(submission, opts.arc);
    expect(
      {
        value: event.value,
        localDepositor: event.localDepositor.toLowerCase(),
        remoteRecipient: event.remoteRecipient.toLowerCase(),
        remoteDomain: event.remoteDomain,
        remoteToken: event.remoteToken.toLowerCase(),
        maxFee: event.maxFee,
        hookData: event.hookData
      },
      `DepositedToRemote of ${submission.depositHash}`
    ).toEqual({
      value: DEPOSIT_UNITS,
      localDepositor: opts.key.address.toLowerCase(),
      remoteRecipient: recipient.toLowerCase(),
      remoteDomain: USDCX_REMOTE_DOMAIN,
      remoteToken: opts.xreserve.remoteToken.toLowerCase(),
      maxFee: 0n,
      hookData: '0x'
    });
  });

  const attested = await step('attest', BUDGET.attest, async () => {
    const attestation = await waitForXReserveAttestation(submission.depositHash, {
      baseUrl: ARC_ATTESTATION_API,
      timeoutMs: BUDGET.attest - 15_000,
      pollMs: 3_000
    });
    // When the harness first saw the attestation; the wallet's reconciler polls every 8 s while its page is visible.
    const attestedAt = Date.now();
    const { intent, signer } = await assertDepositIntent(attestation, {
      amount: DEPOSIT_UNITS,
      remoteToken: opts.xreserve.remoteToken,
      remoteRecipient: recipient,
      localToken: ARC_USDC,
      localDepositor: opts.key.address
    });
    const verdict = matchUsdcxDepositAttestation([attestation], {
      remoteRecipient: recipient,
      remoteToken: opts.xreserve.remoteToken,
      amount: DEPOSIT_UNITS
    });
    expect(verdict.kind, "the wallet's own matcher accepts Circle's attestation").toBe('attested');
    opts.evidence.ids.attestationSigner = signer;
    opts.evidence.hashes.attestationMessage = attestation.messageHash;
    return { intent, attestedAt };
  });

  const mint = await step('mint', BUDGET.mint, async () => {
    // Derived, not discovered: a mint to any other account or of any other amount cannot satisfy this read.
    const mintNoteId = await deriveUsdcxMintNoteId({
      faucetHex: ids.nativeHex,
      recipientHex: ids.accountHex,
      units: DEPOSIT_UNITS,
      nonce: attested.intent.nonce
    });
    const read = await waitForUsdcxMint(opts.rpcUrl, {
      mintNoteId,
      depositHash: submission.depositHash,
      nonce: attested.intent.nonce,
      faucetBech32: ids.nativeBare,
      accountBech32: ids.bare,
      sinceBlock: opts.sinceBlock,
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
    if (opts.accountTag !== undefined && read.tag !== opts.accountTag) {
      throw new Error(
        `mint note ${mintNoteId} carries tag ${read.tag}; the grant note to this account carried ${opts.accountTag}`
      );
    }
    return { mintNoteId, read };
  });
  opts.evidence.ids.mintNote = mint.mintNoteId;
  opts.evidence.notes.push(`mint note tag ${mint.read.tag ?? 'unread'}`);
  opts.evidence.latenciesMs.attestationToMint = Date.now() - attested.attestedAt;
  return {
    submission,
    positiveId: rows.positiveId,
    tracker,
    intent: attested.intent,
    attestedAt: attested.attestedAt,
    mintNoteId: mint.mintNoteId,
    mint: mint.read
  };
}

/** Spec 5 step 14: the service worker consumes the mint by itself, and the POSITIVE row ends `received` on that consume. */
async function receiveLeg(
  step: NamedStep,
  wallet: GuardianAwareWalletPage,
  ids: UsdcxWalletIds,
  deposit: DepositRun,
  opts: ReceiveOptions
): Promise<{ consumeId: string; fee: FeeTerm; vault: bigint }> {
  return step(
    'receive',
    BUDGET.receive,
    async () => {
      const page = wallet.page;
      // A row sampled at `ready` must read Confirmed, or Completed once a re-read shows it already `received`.
      const readyPill = deposit.tracker.positive.saw('ready') ? await historyPill(wallet, deposit.positiveId) : null;
      const phaseAfterPill = readyPill === null ? null : (await bridgeReceiveState(wallet, deposit.positiveId)).phase;
      if (
        readyPill !== null &&
        readyPill !== enText('confirmed') &&
        !(readyPill === enText('completed') && phaseAfterPill === 'received')
      ) {
        throw new Error(
          `the ready POSITIVE row's details read "${readyPill}" (phase now ${phaseAfterPill ?? 'unread'})`
        );
      }
      opts.evidence.notes.push(
        readyPill === null ? 'POSITIVE was not sampled at ready' : `ready POSITIVE details read "${readyPill}"`
      );
      await wallet.navigateHome();

      // The service worker consumes the mint by itself; a claim call would add a second consume row.
      const consume = await waitForConsumeOf(page, deposit.mintNoteId, 'mint', BUDGET.receive - 120_000, opts.where);
      expect(
        (consume.noteIds ?? []).map(id => id.toLowerCase()),
        'the mint consume carries nothing but the mint note'
      ).toEqual([deposit.mintNoteId.toLowerCase()]);
      // The adoption writes the consume's `bridgeIn` and the POSITIVE's `received` right after the consume completes.
      const adopted = await pollUntil(
        'the mint consume adopting the POSITIVE row',
        async () => ({
          consume: await readTransactionRow(page, consume.id),
          positive: await bridgeReceiveState(wallet, deposit.positiveId)
        }),
        ({ consume: row, positive }) =>
          jsonObject(row?.extraInputs?.bridgeIn) !== undefined && positive.phase === 'received',
        {
          timeoutMs: 60_000,
          intervalMs: 3_000,
          describe: async last =>
            `consume ${last?.consume ? describeTransactionRow(last.consume) : 'missing'}, ` +
            `POSITIVE ${last?.positive.phase ?? 'unread'}; ${await opts.where()}`
        }
      );
      const consumeRow = adopted.consume;
      if (!consumeRow) throw new Error(`consume ${consume.id} disappeared`);
      expect({
        displayMessage: consumeRow.displayMessage,
        bridgeReceiveTxId: jsonString(jsonObject(consumeRow.extraInputs?.bridgeIn)?.bridgeReceiveTxId)
      }).toEqual({ displayMessage: 'Bridged from EVM', bridgeReceiveTxId: deposit.positiveId });

      const { fee, vault } = await consumeFeeAndVault(page, ids, consumeRow, {
        fee: 'f2',
        vaultBefore: opts.vaultBefore,
        credit: DEPOSIT_UNITS,
        terms: [...opts.terms, ['M', DEPOSIT_UNITS]]
      });
      opts.evidence.notes.push(
        `mint consume ${consumeRow.id} completed ${fee.kind === 'exact' ? 'with its result' : 'through a landed path'}`
      );

      const positiveRow = await readTransactionRow(page, deposit.positiveId);
      expect({
        phase: adopted.positive.phase,
        midenNoteId: adopted.positive.midenNoteId?.toLowerCase(),
        amount: adopted.positive.amount,
        error: adopted.positive.error,
        transactionId: positiveRow?.transactionId
      }).toEqual({
        phase: 'received',
        midenNoteId: deposit.mintNoteId.toLowerCase(),
        amount: DEPOSIT_UNITS.toString(),
        error: undefined,
        transactionId: consumeRow.transactionId
      });

      await deposit.tracker.stop();
      const positive = deposit.tracker.positive;
      positive.assertMonotone();
      opts.evidence.phases.positive = positive.samples();
      opts.evidence.notes.push(`POSITIVE ready ${positive.saw('ready') ? 'was' : 'was not'} sampled`);
      // The watcher reconciles within one 8 s tick of the attestation, give or take Circle's API; 20 s allows two.
      const settledAt = Math.min(positive.firstAt('ready') ?? Infinity, positive.firstAt('received') ?? Infinity);
      expect(
        settledAt,
        `POSITIVE stayed delivering 20 s after the attestation: ${positive.describe()}`
      ).toBeLessThanOrEqual(deposit.attestedAt + 20_000);

      await openHistoryDetails(wallet, deposit.positiveId);
      await expect(page.getByTestId('history-status-pill')).toHaveText(enText('completed'));
      await wallet.navigateHome();
      return { consumeId: consumeRow.id, fee, vault };
    },
    opts.onGuardian
  );
}

/** Spec 5 step 14: the NEGATIVE row fails on the recipient within 30 s of the attestation and is never `ready`. */
function assertNegativeFailed(deposit: DepositRun, evidence: RunEvidence): void {
  const negative = deposit.tracker.negative;
  if (!negative) throw new Error('the run tracked no NEGATIVE row');
  evidence.phases.negative = negative.timeline.samples();
  negative.timeline.assertMonotone();
  expect({ last: negative.timeline.last(), error: negative.error() }).toEqual({
    last: 'failed',
    error: FOREIGN_RECIPIENT_ERROR
  });
  expect(
    negative.timeline.firstAt('failed') ?? Infinity,
    `NEGATIVE failed more than 30 s after the attestation: ${negative.timeline.describe()}`
  ).toBeLessThanOrEqual(deposit.attestedAt + 30_000);
}

/** Spec 5 step 8 failure body: the key, its ledger file, the burn's consume and xReserve's pause flags now. */
function payoutContext(arc: ArcWriteDeps, key: ArcKey, ledgerPath: string, burn: BurnLeg): StepContext {
  return async () => {
    const flags = await readXReserveDomainState(arc).then(
      state =>
        `paused ${state.paused}, deposits paused ${state.depositsPaused}, withdrawals paused ${state.withdrawalsPaused}`,
      (error: unknown) => `pause flags unreadable (${errorText(error)})`
    );
    const consumedAt = new Date(burn.oracle.consumeTimestampSec * 1_000).toISOString();
    return (
      `key ${key.address} (ledger ${ledgerPath}); burn note ${burn.burnNoteId} consumed in Miden block ` +
      `${burn.oracle.consumeBlock} at ${consumedAt}; xReserve ${flags}`
    );
  };
}

/** Spec 5 step 8b (Q6, a hard gate): the wallet's own destination check confirms the payout Circle made. */
async function walletConfirmsPayout(
  wallet: GuardianAwareWalletPage,
  burn: BurnLeg,
  payout: GatewayPayout,
  key: ArcKey,
  arc: ArcWriteDeps,
  where: StepContext,
  evidence: RunEvidence
): Promise<number> {
  await wallet.navigateHome();
  const row = await pollUntil(
    'the wallet confirming the payout',
    async () => (await readBridgedSendRows(wallet.page)).find(candidate => candidate.id === burn.row.id),
    found => found?.extraInputs?.usdcxBurn?.destinationBalanceConfirmed !== undefined,
    {
      timeoutMs: WALLET_CONFIRM_TIMEOUT_MS,
      intervalMs: 3_000,
      describe: async last => {
        const keyNow = await readArcUsdc(key.address, arc).then(String, errorText);
        const arcIo = await readArcUsdc(key.address, { endpoints: [ARC_PUBLIC_URL] }).then(
          balance => `arc.io reads ${balance}`,
          (error: unknown) => `arc.io failed: ${errorText(error)}`
        );
        const before = JSON.stringify(last?.extraInputs?.usdcxBurn?.destinationBalanceBefore);
        return (
          `Circle paid this burn (harness proof) but the wallet never confirmed it; destinationBalanceBefore ` +
          `${before}, key balance now ${keyNow}, ${arcIo}; ${await where()}`
        );
      }
    }
  );
  const confirmedAt = Date.now();
  const confirmed = row?.extraInputs?.usdcxBurn?.destinationBalanceConfirmed;
  const confirmedBlock = BigInt(confirmed?.blockNumber ?? '0');
  expect(
    {
      balance: confirmed?.balance,
      afterSnapshot: confirmedBlock > burn.arcFromBlock,
      atOrAfterPayout: confirmedBlock >= payout.logBlock
    },
    `confirmation at Arc block ${confirmedBlock}, snapshot ${burn.arcFromBlock}, payout log ${payout.logBlock}`
  ).toEqual({ balance: payout.value.toString(), afterSnapshot: true, atOrAfterPayout: true });
  await openHistoryDetails(wallet, burn.row.id);
  await expect(wallet.page.getByTestId('history-status-pill')).toHaveText(enText('confirmed'));
  const linkHash = await receivingTxHash(wallet.page, RECEIVING_TX_LINK_MS);
  if (linkHash !== null && linkHash !== payout.transactionHash.toLowerCase()) {
    throw new Error(
      `the receiving-tx link names ${linkHash}; the AttestationUsed transaction is ${payout.transactionHash}`
    );
  }
  evidence.notes.push(
    linkHash === null
      ? 'receiving-tx link did not render within 15 s'
      : 'receiving-tx link is the AttestationUsed transaction'
  );
  await wallet.navigateHome();
  return confirmedAt;
}

test.describe('USDCx round trip: burn to a fresh Arc key, Circle payout, deposit back', () => {
  // The injected fee faucet masks the wallet's own native-asset discovery (two-wallets.ts:840).
  test.use({ injectFeeFaucet: false });
  test.beforeAll(() => assertUsdcxLiveRun(process.env, { needsArcKey: false }));

  test('Guardian wallet: public faucet grant, Send burn, payout and its confirmation, deposit back, receipt', async ({
    walletA,
    envConfig,
    steps
  }) => {
    const step = namedSteps(steps);
    const arc: ArcWriteDeps = { endpoints: arcEndpoints(process.env.E2E_ARC_RPC_URL) };
    const where = pageWhere(walletA);
    const evidence = newRunEvidence('usdcx');
    const secrets: string[] = [];
    const cleanups: Array<() => Promise<void>> = [];
    let passed = false;
    try {
      const { identity, ids } = await step(
        'guardian_wallet',
        BUDGET.guardianWallet,
        () => guardianWallet(walletA, envConfig.guardianUrl, evidence),
        async () => `GUARDIAN_URL=${envConfig.guardianUrl}`
      );
      const onGuardian: StepContext = () => guardianFailureContext(identity);

      const xreserve = await step('arc_state', BUDGET.arcState, async () => {
        const state = await readXReserveDomainState(arc);
        expect(
          {
            registered: state.registered,
            paused: state.paused,
            depositsPaused: state.depositsPaused,
            withdrawalsPaused: state.withdrawalsPaused
          },
          `xReserve domain ${USDCX_REMOTE_DOMAIN} read on ${state.endpoint}`
        ).toEqual({ registered: true, paused: false, depositsPaused: false, withdrawalsPaused: false });
        return state;
      });

      const funding = await step(
        'fund',
        BUDGET.fund,
        async () => {
          expect(xreserve.remoteToken.toLowerCase(), "xReserve's remote token is the wallet's native faucet").toBe(
            midenAccountHexToXReserveRecipient(ids.nativeHex)
          );
          const funding = await fundFromPublicFaucet(walletA.page, ids, envConfig.rpcUrl, where);
          await walletA.assertGuardianAuth(ids.address, {
            signerCount: 2,
            threshold: 2,
            guardianCommitment: identity.commitment
          });
          return funding;
        },
        onGuardian
      );
      evidence.fees.push(funding.f0);
      evidence.ids.grantNote = funding.grantNoteId;
      evidence.ids.grantConsume = funding.consumeId;

      evidence.settleMs.grant = await step(
        'settle_grant',
        BUDGET.settle,
        () => settleGuardian(walletA, SETTLE_WAIT_MS),
        onGuardian
      );

      const { key, ledgerPath } = await step('fresh_key', BUDGET.freshKey, async () => {
        const key = newArcKey();
        secrets.push(key.privateKey);
        const ledgerPath = recordArcKey(key, ids.address);
        expect(await readArcUsdc(key.address, arc), 'a fresh key holds no USDC').toBe(0n);
        return { key, ledgerPath };
      });
      evidence.ids.arcKey = key.address;
      evidence.ids.ledgerPath = ledgerPath;

      const priorBurns = await step(
        'burn_via_ui',
        BUDGET.burnViaUi,
        () =>
          submitBurn(walletA, ids, {
            destination: key.address,
            units: BURN_UNITS,
            screenshotDir: test.info().outputDir
          }),
        onGuardian
      );
      const burn = await step(
        'burn_confirmed',
        BUDGET.burnConfirmed,
        async () => {
          const burn = await confirmBurn(walletA, ids, {
            priorRowIds: priorBurns,
            destination: key.address,
            units: BURN_UNITS,
            vaultBefore: funding.vault,
            rpcUrl: envConfig.rpcUrl,
            guardian: true,
            timeoutMs: BUDGET.burnRowPoll,
            where
          });
          await assertBurnDetails(walletA, burn.row.id, key.address);
          await walletA.navigateHome();
          return burn;
        },
        onGuardian
      );
      evidence.ids.burnRow = burn.row.id;
      evidence.ids.burnNote = burn.burnNoteId;
      evidence.hashes.burnTransaction = burn.row.transactionId ?? 'none';
      evidence.fees.push(burn.fee, { name: 's', amount: burn.sponsorship, kind: 'exact' });
      evidence.phases.burn = burn.phases.samples();

      // A discarded Guardian candidate fails here with the Guardian's message, not later as a 409 on the consume.
      evidence.settleMs.burn = await step(
        'settle_burn',
        BUDGET.settle,
        () => settleGuardian(walletA, SETTLE_WAIT_MS),
        onGuardian
      );

      const consumeTsMs = burn.oracle.consumeTimestampSec * 1_000;
      // D3: one AttestationUsed log whose mint calldata carries the burn note id; any other transfer to the key does
      // not count. Red after 10 min means a user was not paid in time.
      const payout = await step(
        'payout',
        BUDGET.payout,
        () =>
          waitForGatewayPayout(
            {
              recipient: key.address,
              burnNoteId: burn.burnNoteId,
              burnUnits: BURN_UNITS,
              fromBlock: burn.arcFromBlock,
              consumeTsMs,
              deadlineMs: consumeTsMs + PAYOUT_TIMEOUT_MS,
              depositor: xreserve.depositor,
              minimumValue: minimumUsdcxPayout(ARC_CHAIN_ID, BURN_UNITS)
            },
            arc
          ),
        payoutContext(arc, key, ledgerPath, burn)
      );
      expect({ domain: payout.sourceDomain, total: payout.value + payout.fee }).toEqual({
        domain: ARC_CIRCLE_DOMAIN,
        total: BURN_UNITS
      });
      evidence.hashes.payout = payout.transactionHash;
      evidence.fees.push({ name: 'circle payout fee', amount: payout.fee, kind: 'exact' });
      evidence.latenciesMs.consumeToPayout = payout.latencyMs;

      // Before the deposit, which spends from the key and would hold its balance below the wallet's threshold
      // (destination-status.ts:59), leaving the row at Burn confirmed.
      const walletConfirmedAt = await step('wallet_payout_confirmed', BUDGET.walletPayoutConfirmed, () =>
        walletConfirmsPayout(walletA, burn, payout, key, arc, where, evidence)
      );
      evidence.latenciesMs.payoutToWalletConfirmation = walletConfirmedAt - (consumeTsMs + payout.latencyMs);

      const deposit = await depositLeg(step, walletA, ids, {
        key,
        keyBalance: payout.value,
        approve: 'exact',
        arc,
        xreserve,
        rpcUrl: envConfig.rpcUrl,
        withNegative: true,
        sinceBlock: burn.oracle.consumeBlock,
        accountTag: funding.grantTag,
        evidence,
        cleanups
      });
      const terms: Array<readonly [string, bigint]> = [
        ['G', funding.grant],
        ['f0', funding.f0.amount],
        ['N', BURN_UNITS],
        ['f1', burn.fee.amount],
        ['s', burn.sponsorship]
      ];
      const received = await receiveLeg(step, walletA, ids, deposit, {
        vaultBefore: burn.vault,
        terms,
        where,
        onGuardian,
        evidence
      });
      evidence.fees.push(received.fee);
      evidence.ids.mintConsume = received.consumeId;

      await step('receive_negative', BUDGET.check, async () => assertNegativeFailed(deposit, evidence));
      await step('ledger', BUDGET.check, async () => {
        const whole: Array<readonly [string, bigint]> = [...terms, ['M', DEPOSIT_UNITS], ['f2', received.fee.amount]];
        expect(received.vault, `whole ledger ${ledgerLine(whole)}`).toBe(
          funding.grant -
            funding.f0.amount -
            BURN_UNITS -
            burn.fee.amount -
            burn.sponsorship +
            DEPOSIT_UNITS -
            received.fee.amount
        );
      });
      passed = true;
    } finally {
      for (const cleanup of cleanups) await cleanup();
      await attachEvidence(test.info(), 'usdcx-round-trip-evidence.json', evidence, secrets).catch((error: unknown) => {
        if (passed) throw error;
      });
    }
  });
});
```

- [ ] **Step 9: Run the config-selection tests and watch them pass**

```bash
yarn jest playwright/e2e/harness/spec-selection.test.ts -t 'run under their own config only|config of their own|base testIgnore' --maxWorkers=2
```

Expected: 11 passed, 0 failed (5 from Task 25 (p5-config-isolation) and 6 here: the listing, one grep case, the base and bridge configs, the name check and one guard case; the rest skipped).

- [ ] **Step 10: List the tests Playwright selects**

```bash
E2E_NETWORK=localhost node_modules/.bin/playwright test --list --reporter list --config playwright.usdcx.config.ts
E2E_NETWORK=localhost node_modules/.bin/playwright test --list --reporter list --config playwright.usdcx.config.ts --grep 'USDCx round trip'
```

Expected, both commands (line and column numbers may differ):

```
Listing tests:
  usdcx-roundtrip.spec.ts:<line>:<col> › USDCx round trip: burn to a fresh Arc key, Circle payout, deposit back › Guardian wallet: public faucet grant, Send burn, payout and its confirmation, deposit back, receipt
Total: 1 test in 1 file
```

- [ ] **Step 11: Run every suite in the helpers and harness directories**

```bash
yarn jest playwright/e2e/helpers playwright/e2e/harness --maxWorkers=2
```

Expected: 0 failed. This covers the unit tests of every helper the spec calls: p3's `arc-usdcx.test.ts`, `usdcx-guardian.test.ts`, `usdcx-miden.test.ts` and `history.test.ts`, the existing `balance-truth.test.ts`, `public-faucet.test.ts`, `public-note-commitment.test.ts`, the new `usdcx-run.test.ts`, and the source-scanning guards (`linked-pr-injection.test.ts` still holds #1401's ceiling line).

- [ ] **Step 12: Format, lint, run the harness ratchet and check for dashes**

```bash
FILES="playwright/e2e/helpers/usdcx-run.ts playwright/e2e/helpers/usdcx-run.test.ts playwright/e2e/helpers/usdcx-legs.ts playwright/e2e/tests/usdcx/usdcx-roundtrip.spec.ts playwright/e2e/harness/spec-selection.test.ts"
npx prettier --write $FILES
npx eslint --max-warnings 0 $FILES
node scripts/lint-e2e-harness.mjs
printf 'a\xe2\x80\x94b\n' | grep -c -e $'\xe2\x80\x94'
git diff -U0 -- $FILES | grep '^+' | grep -c -e $'\xe2\x80\x94' -e $'\xe2\x80\x93'
cat playwright/e2e/helpers/usdcx-run.ts playwright/e2e/helpers/usdcx-run.test.ts playwright/e2e/helpers/usdcx-legs.ts playwright/e2e/tests/usdcx/usdcx-roundtrip.spec.ts | grep -c -e $'\xe2\x80\x94' -e $'\xe2\x80\x93'
```

Expected: prettier leaves the files unchanged; eslint prints nothing; `lint-e2e-harness.mjs` passes with no new file or count over its baseline (the new files add zero `no-unfalsifiable-balance-assertion`, `no-long-bare-wait` and `no-conditional-expect` hits); the positive control prints `1`; the last two commands print `0` (the new files are untracked, so the `cat` line checks them whole).

- [ ] **Step 13: Commit deferred to Task 27 (p5-bridge-in)** (spec commit 11).

---

---

### Task 27: The extension funded-key bridge-in describe (p5-bridge-in)

Spec 6, spec 11 and interfaces sections 4 and 5. The describe reuses the round trip's deposit and receive legs (spec 6 step 4: "section 5 steps 9-13"), with the approve conditional (`if-short`, recorded in the evidence) and no NEGATIVE row. Spike-dependent items as in Task 26 (p5-roundtrip), plus (spike-dependent: what a fresh Guardian account reads before its first transaction) the `guardian_wallet` step's zero-vault read and its check that no consume, send or bridged-send row exists yet (spec 6 step 1: "vault zero, account undeployed"; the strict "first transaction" check runs in `receive_deploy`); the describe timeout 1_800_000 is the spec's (budgets ~21 min plus fixture setup). Spec text deviation: spec 6 applies section 5 step 13's tag check, but this describe has no grant note to compare the mint's tag with, so it records the tag in the evidence instead (no oracle in interfaces 3.4 gives an account's tag).

**Files:**
- Modify: `playwright/e2e/tests/usdcx/usdcx-roundtrip.spec.ts` (imports; a second describe at the end of the file)
- Modify: `playwright/e2e/harness/spec-selection.test.ts` (the USDCx constants added by Task 26 (p5-roundtrip))

**Interfaces:**
- Consumes: `arcPrivateKeyFromEnv(env: NodeJS.ProcessEnv): Hex` and `assertUsdcxLiveRun(env, { needsArcKey: true })` (Task 26, p5-roundtrip); `privateKeyToAccount(privateKey: Hex): { address: Address }` (`viem/accounts`); `vaultBalanceOfCurrentAccount(page, faucetId): Promise<bigint>` (playwright/e2e/helpers/balance-truth.ts:399); `readTransactionRows(page): Promise<TransactionRowSnapshot[]>` (playwright/e2e/helpers/history.ts:144); the module-scope `guardianWallet`, `depositLeg`, `receiveLeg` and `BUDGET` of usdcx-roundtrip.spec.ts (Task 26, p5-roundtrip); env `E2E_ARC_PRIVATE_KEY`, `E2E_ARC_RPC_URL` from p4 (interfaces section 4).
- Produces: describe `USDCx bridge-in from a funded Arc key` with `test.describe.configure({ timeout: 1_800_000 })` and one test `Guardian wallet receives a Node-signed xReserve deposit` (runner grep `funded Arc key`, interfaces section 5); it attaches `usdcx-in-evidence.json`.

- [ ] **Step 1: Write the failing config-selection tests**

In `playwright/e2e/harness/spec-selection.test.ts` replace:

```ts
  'Guardian wallet: public faucet grant, Send burn, payout and its confirmation, deposit back, receipt';
/** Every test `playwright.usdcx.config.ts` must list, and nothing else. */
const USDCX_LIVE_TESTS = [ROUND_TRIP_TEST];
/** Each runner suite's grep, compiled case-insensitive as scripts/e2e-real.mjs does, and the tests it must select. */
const USDCX_RUNNER_GREPS: Array<[grep: string, tests: string[]]> = [['USDCx round trip', [ROUND_TRIP_TEST]]];
/** Each live spec file and how many describes it guards. */
const USDCX_LIVE_SPECS: Array<[file: string, describes: number]> = [['usdcx-roundtrip.spec.ts', 1]];
```

with:

```ts
  'Guardian wallet: public faucet grant, Send burn, payout and its confirmation, deposit back, receipt';
const BRIDGE_IN_TEST =
  'usdcx-roundtrip.spec.ts › USDCx bridge-in from a funded Arc key › ' +
  'Guardian wallet receives a Node-signed xReserve deposit';
/** Every test `playwright.usdcx.config.ts` must list, and nothing else. */
const USDCX_LIVE_TESTS = [ROUND_TRIP_TEST, BRIDGE_IN_TEST];
/** Each runner suite's grep, compiled case-insensitive as scripts/e2e-real.mjs does, and the tests it must select. */
const USDCX_RUNNER_GREPS: Array<[grep: string, tests: string[]]> = [
  ['USDCx round trip', [ROUND_TRIP_TEST]],
  ['funded Arc key', [BRIDGE_IN_TEST]]
];
/** Each live spec file and how many describes it guards. */
const USDCX_LIVE_SPECS: Array<[file: string, describes: number]> = [['usdcx-roundtrip.spec.ts', 2]];
```

Mutation notes:
- `playwright.usdcx.config.ts lists exactly the live USDCx tests`: delete the bridge-in describe; the listing lacks `BRIDGE_IN_TEST`.
- `the runner grep "funded Arc key" selects only its own tests`: rename the describe `USDCx bridge-in from a pre-funded key`; the filter returns `[]`.
- `usdcx-roundtrip.spec.ts throws instead of skipping outside the runner`: drop the bridge-in describe's `test.beforeAll` guard; the match count is 1, not 2.

- [ ] **Step 2: Run them and watch them fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
yarn jest playwright/e2e/harness/spec-selection.test.ts -t 'run under their own config only' --maxWorkers=2
```

Expected: 3 failed, 4 passed. `lists exactly the live USDCx tests` shows `BRIDGE_IN_TEST` missing from the received array; `the runner grep "funded Arc key"` expected `[BRIDGE_IN_TEST]`, received `[]`; `usdcx-roundtrip.spec.ts throws instead of skipping` reads `Expected length: 2, Received length: 1`.

- [ ] **Step 3: Import what the bridge-in describe uses**

In `playwright/e2e/tests/usdcx/usdcx-roundtrip.spec.ts` make four import edits.

Replace:

```ts
import type { Hex } from 'viem';

import { matchUsdcxDepositAttestation } from '../../../../src/lib/usdcx/attestation';
```

with:

```ts
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { matchUsdcxDepositAttestation } from '../../../../src/lib/usdcx/attestation';
```

Replace:

```ts
import { fromBaseUnits } from '../../helpers/balance-truth';
```

with:

```ts
import { fromBaseUnits, vaultBalanceOfCurrentAccount } from '../../helpers/balance-truth';
```

Replace:

```ts
import { describeTransactionRow, openHistoryDetails, readTransactionRow } from '../../helpers/history';
```

with:

```ts
import {
  describeTransactionRow,
  openHistoryDetails,
  readTransactionRow,
  readTransactionRows
} from '../../helpers/history';
```

Replace:

```ts
import {
  assertUsdcxLiveRun,
  errorText,
```

with:

```ts
import {
  arcPrivateKeyFromEnv,
  assertUsdcxLiveRun,
  errorText,
```

- [ ] **Step 4: Append the bridge-in describe**

At the end of `playwright/e2e/tests/usdcx/usdcx-roundtrip.spec.ts`, after the round-trip describe's closing `});`, add one blank line and:

```ts
test.describe('USDCx bridge-in from a funded Arc key', () => {
  test.use({ injectFeeFaucet: false });
  // Budgets add up to ~21 min, plus ~2 min of fixture setup charged to the test.
  test.describe.configure({ timeout: 1_800_000 });
  test.beforeAll(() => assertUsdcxLiveRun(process.env, { needsArcKey: true }));

  test('Guardian wallet receives a Node-signed xReserve deposit', async ({ walletA, envConfig, steps }) => {
    const step = namedSteps(steps);
    const arc: ArcWriteDeps = { endpoints: arcEndpoints(process.env.E2E_ARC_RPC_URL) };
    const where = pageWhere(walletA);
    const evidence = newRunEvidence('usdcx-in');
    const secrets: string[] = [];
    const cleanups: Array<() => Promise<void>> = [];
    let passed = false;
    try {
      const { identity, ids } = await step(
        'guardian_wallet',
        BUDGET.guardianWallet,
        async () => {
          const created = await guardianWallet(walletA, envConfig.guardianUrl, evidence);
          expect(
            await vaultBalanceOfCurrentAccount(walletA.page, created.ids.native),
            'a fresh account holds nothing'
          ).toBe(0n);
          // Nothing may have claimed or sent yet: the mint consume must be the account's first transaction and deploy.
          const written = (await readTransactionRows(walletA.page)).filter(
            row => row.type === 'consume' || row.type === 'send' || row.type === 'bridged-send'
          );
          expect(written, 'nothing has deployed the account yet').toEqual([]);
          return created;
        },
        async () => `GUARDIAN_URL=${envConfig.guardianUrl}`
      );
      const onGuardian: StepContext = () => guardianFailureContext(identity);

      const xreserve = await step('arc_state', BUDGET.arcState, async () => {
        const state = await readXReserveDomainState(arc);
        expect(
          { registered: state.registered, paused: state.paused, depositsPaused: state.depositsPaused },
          `xReserve domain ${USDCX_REMOTE_DOMAIN} read on ${state.endpoint}`
        ).toEqual({ registered: true, paused: false, depositsPaused: false });
        expect(state.remoteToken.toLowerCase(), "xReserve's remote token is the wallet's native faucet").toBe(
          midenAccountHexToXReserveRecipient(ids.nativeHex)
        );
        return state;
      });

      const funded = await step('funded_key', BUDGET.fundedKey, async () => {
        const privateKey = arcPrivateKeyFromEnv(process.env);
        secrets.push(privateKey);
        const key: ArcKey = { address: privateKeyToAccount(privateKey).address, privateKey };
        const balance = await readArcUsdc(key.address, arc);
        if (balance < DEPOSIT_UNITS + GAS_RESERVE_UNITS) {
          throw new Error(
            `funded key ${key.address} holds ${balance} USDC base units, needs ${DEPOSIT_UNITS + GAS_RESERVE_UNITS}; ` +
              'any paid usdcx run leaves about 9 USDC on its key in ~/.miden-e2e/arc-keys'
          );
        }
        return { key, balance };
      });
      evidence.ids.arcKey = funded.key.address;

      const deposit = await depositLeg(step, walletA, ids, {
        key: funded.key,
        keyBalance: funded.balance,
        approve: 'if-short',
        arc,
        xreserve,
        rpcUrl: envConfig.rpcUrl,
        withNegative: false,
        // The account was created in this run, so every faucet note to its tag is recent.
        sinceBlock: 0,
        evidence,
        cleanups
      });
      const received = await receiveLeg(step, walletA, ids, deposit, {
        vaultBefore: 0n,
        terms: [],
        where,
        onGuardian,
        evidence
      });
      evidence.fees.push(received.fee);
      evidence.ids.mintConsume = received.consumeId;

      await step(
        'receive_deploy',
        BUDGET.check + 50_000,
        async () => {
          const transactions = (await readTransactionRows(walletA.page)).filter(row => row.type !== 'bridged-receive');
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
      await attachEvidence(test.info(), 'usdcx-in-evidence.json', evidence, secrets).catch((error: unknown) => {
        if (passed) throw error;
      });
    }
  });
});
```

- [ ] **Step 5: Run the config-selection tests and watch them pass**

```bash
yarn jest playwright/e2e/harness/spec-selection.test.ts -t 'run under their own config only|config of their own|base testIgnore' --maxWorkers=2
```

Expected: 12 passed, 0 failed.

- [ ] **Step 6: List the tests Playwright selects**

```bash
E2E_NETWORK=localhost node_modules/.bin/playwright test --list --reporter list --config playwright.usdcx.config.ts
E2E_NETWORK=localhost node_modules/.bin/playwright test --list --reporter list --config playwright.usdcx.config.ts --grep 'funded Arc key'
E2E_NETWORK=localhost node_modules/.bin/playwright test --list --reporter list --config playwright.usdcx.config.ts --grep 'USDCx round trip'
```

Expected (line and column numbers may differ): the first lists exactly

```
  usdcx-roundtrip.spec.ts:<line>:<col> › USDCx round trip: burn to a fresh Arc key, Circle payout, deposit back › Guardian wallet: public faucet grant, Send burn, payout and its confirmation, deposit back, receipt
  usdcx-roundtrip.spec.ts:<line>:<col> › USDCx bridge-in from a funded Arc key › Guardian wallet receives a Node-signed xReserve deposit
Total: 2 tests in 1 file
```

the second only the bridge-in line (`Total: 1 test in 1 file`), the third only the round-trip line (`Total: 1 test in 1 file`).

- [ ] **Step 7: Run every suite in the helpers and harness directories**

```bash
yarn jest playwright/e2e/helpers playwright/e2e/harness --maxWorkers=2
```

Expected: 0 failed.

- [ ] **Step 8: Format, lint, run the harness ratchet and check for dashes**

```bash
FILES="playwright/e2e/tests/usdcx/usdcx-roundtrip.spec.ts playwright/e2e/harness/spec-selection.test.ts"
npx prettier --write $FILES
npx eslint --max-warnings 0 $FILES
node scripts/lint-e2e-harness.mjs
printf 'a\xe2\x80\x94b\n' | grep -c -e $'\xe2\x80\x94'
cat playwright/e2e/tests/usdcx/usdcx-roundtrip.spec.ts | grep -c -e $'\xe2\x80\x94' -e $'\xe2\x80\x93'
git diff -U0 -- playwright/e2e/harness/spec-selection.test.ts playwright.e2e.config.ts | grep '^+' | grep -c -e $'\xe2\x80\x94' -e $'\xe2\x80\x93'
```

Expected: no prettier change, no eslint output, the harness ratchet passes, `1`, `0`, `0`.

- [ ] **Step 9: Commit spec commit 11**

```bash
git add playwright.usdcx.config.ts playwright.e2e.config.ts playwright/e2e/harness/spec-selection.test.ts \
  playwright/e2e/tests/usdcx/usdcx-roundtrip.spec.ts playwright/e2e/helpers/usdcx-run.ts \
  playwright/e2e/helpers/usdcx-run.test.ts playwright/e2e/helpers/usdcx-legs.ts
git status --short
git commit -m "test(e2e): extension Guardian USDCx round trip and funded-key bridge-in"
git show --stat --format=%B HEAD
```

Expected: `git status --short` shows exactly those seven paths staged (`A`/`M`) and nothing else staged; the commit body is the single line `test(e2e): extension Guardian USDCx round trip and funded-key bridge-in` with no trailer; `--stat` lists the seven files.

---

---

### Task 28: The USDCx burn spec onto the public faucet grant, moved to tests/usdcx (p5-burn-retarget)

Spec 15 Q3(a), spec 4 (Isolation: nothing USDCx under tests/bridge, which E2E Bridge collects on every push to main, playwright.bridge.config.ts:13) and interfaces section 5. The old spec (origin/main:playwright/e2e/tests/bridge/bridge-out-usdcx.spec.ts, 123 lines) needed a private test faucet (`USDCX_TESTNET_REPO`, `xusdc-testnet mint`, `USDCX_FAUCET_ACCOUNT_ID`), skipped without it, claimed with `claimAllNotes`, burned 1 USDCx to `0x1111...1111`, read the positional chain-evidence form p3 removed in commit 9, and checked the faucet's total supply. On the public USDCx faucet the supply moves with every other user's grant and burn, so the retargeted spec proves the faucet's consume through the burn note's nullifier (`burnEvidence(...).nullifierCommitted`) instead, and burns `BURN_UNITS` to a fresh key kept in the ledger so its payout can be recovered. Both variants stay (standard and Guardian).

Spike-dependent items: (spike-dependent: step budgets and the describe timeout 1_500_000, which is the budgets' 18 min plus about 2 min of fixture setup and slack) `BUDGET` and `test.describe.configure`; (spike-dependent: the service worker auto-consumes a standard wallet's native grant; the spike covered a Guardian wallet only) the standard variant's `fund` step.

**Files:**
- Move: `playwright/e2e/tests/bridge/bridge-out-usdcx.spec.ts` -> `playwright/e2e/tests/usdcx/usdcx-burn.spec.ts` (`git mv`, then the content is replaced)
- Modify: `playwright/e2e/harness/spec-selection.test.ts` (the USDCx constants)

**Interfaces:**
- Consumes: `newArcKey`, `recordArcKey` (p3 `helpers/arc-usdcx.ts`); `enText` (p3 `helpers/bridge.ts`); `BURN_UNITS` (p3 `helpers/usdcx-constants.ts`); `guardianIdentity`, `guardianFailureContext` (p3 `helpers/usdcx-guardian.ts`); `assertBurnDetails`, `attachEvidence`, `confirmBurn`, `createGuardianUsdcxWallet`, `fundFromPublicFaucet`, `pageWhere`, `resolveUsdcxIds`, `settleGuardian`, `submitBurn` (Task 26 (p5-roundtrip) `helpers/usdcx-legs.ts`); `anyOf`, `assertUsdcxLiveRun`, `namedSteps`, `newRunEvidence`, `StepContext` (Task 26 (p5-roundtrip) `helpers/usdcx-run.ts`); `createNewWallet(password?, options?)` (playwright/e2e/helpers/wallet-page.ts:812).
- Produces: describe `USDCx burn through the Send UI after a public faucet grant` with tests `standard wallet publishes a burn and the faucet consumes it` and `Guardian wallet publishes a burn and the faucet consumes it` (runner grep `USDCx burn through the Send UI`, interfaces section 5); each attaches `usdcx-burn-evidence.json`.

- [ ] **Step 1: Write the failing config-selection tests**

In `playwright/e2e/harness/spec-selection.test.ts` make three replacements.

Replace:

```ts
/** Every test `playwright.usdcx.config.ts` must list, and nothing else. */
const USDCX_LIVE_TESTS = [ROUND_TRIP_TEST, BRIDGE_IN_TEST];
```

with:

```ts
const BURN_TESTS = [
  'usdcx-burn.spec.ts › USDCx burn through the Send UI after a public faucet grant › ' +
    'standard wallet publishes a burn and the faucet consumes it',
  'usdcx-burn.spec.ts › USDCx burn through the Send UI after a public faucet grant › ' +
    'Guardian wallet publishes a burn and the faucet consumes it'
];
/** Every test `playwright.usdcx.config.ts` must list, and nothing else. */
const USDCX_LIVE_TESTS = [ROUND_TRIP_TEST, BRIDGE_IN_TEST, ...BURN_TESTS];
```

Replace:

```ts
  ['funded Arc key', [BRIDGE_IN_TEST]]
];
/** Each live spec file and how many describes it guards. */
const USDCX_LIVE_SPECS: Array<[file: string, describes: number]> = [['usdcx-roundtrip.spec.ts', 2]];
/** A live USDCx spec in another config's listing. */
const USDCX_LIVE_SPEC = /usdcx-roundtrip\.spec\.ts|usdcx-burn\.spec\.ts/;
```

with:

```ts
  ['funded Arc key', [BRIDGE_IN_TEST]],
  ['USDCx burn through the Send UI', BURN_TESTS]
];
/** Each live spec file and how many describes it guards. */
const USDCX_LIVE_SPECS: Array<[file: string, describes: number]> = [
  ['usdcx-roundtrip.spec.ts', 2],
  ['usdcx-burn.spec.ts', 1]
];
/** A live USDCx spec in another config's listing, the burn spec under its old tests/bridge name included. */
const USDCX_LIVE_SPEC = /usdcx-roundtrip\.spec\.ts|usdcx-burn\.spec\.ts|bridge-out-usdcx\.spec\.ts/;
```

Mutation notes:
- `playwright.bridge.config.ts lists no live USDCx spec`: undo the `git mv`; the bridge listing names `bridge-out-usdcx.spec.ts`.
- `playwright.usdcx.config.ts lists exactly the live USDCx tests` and `the runner grep "USDCx burn through the Send UI" selects only its own tests`: rename the describe back to `USDCx burn against the deployed testnet faucet`; both fail.
- `usdcx-burn.spec.ts throws instead of skipping outside the runner`: restore the old `test.skip(!helperRepo || ...)`; `not.toMatch(/test\.skip\(/)` fails and the guard count is 0.

- [ ] **Step 2: Run them and watch them fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
yarn jest playwright/e2e/harness/spec-selection.test.ts -t 'run under their own config only' --maxWorkers=2
```

Expected: 4 failed, 5 passed. `lists exactly the live USDCx tests` misses both `BURN_TESTS` entries; `the runner grep "USDCx burn through the Send UI"` receives `[]`; `playwright.bridge.config.ts lists no live USDCx spec` fails with `Expected pattern: not /usdcx-roundtrip\.spec\.ts|usdcx-burn\.spec\.ts|bridge-out-usdcx\.spec\.ts/` against a listing that names `bridge-out-usdcx.spec.ts`; `usdcx-burn.spec.ts throws instead of skipping` fails with `ENOENT ... playwright/e2e/tests/usdcx/usdcx-burn.spec.ts`.

- [ ] **Step 3: Move the spec**

```bash
git mv playwright/e2e/tests/bridge/bridge-out-usdcx.spec.ts playwright/e2e/tests/usdcx/usdcx-burn.spec.ts
```

- [ ] **Step 4: Retarget it onto the public faucet grant**

Replace the whole content of `playwright/e2e/tests/usdcx/usdcx-burn.spec.ts` (the 123 lines moved from tests/bridge) with:

```ts
import { expect, test } from '../../fixtures/two-wallets';
import { newArcKey, recordArcKey } from '../../helpers/arc-usdcx';
import { enText } from '../../helpers/bridge';
import { BURN_UNITS } from '../../helpers/usdcx-constants';
import { guardianFailureContext, guardianIdentity } from '../../helpers/usdcx-guardian';
import {
  assertBurnDetails,
  attachEvidence,
  confirmBurn,
  createGuardianUsdcxWallet,
  fundFromPublicFaucet,
  pageWhere,
  resolveUsdcxIds,
  settleGuardian,
  submitBurn
} from '../../helpers/usdcx-legs';
import { anyOf, assertUsdcxLiveRun, namedSteps, newRunEvidence, type StepContext } from '../../helpers/usdcx-run';

/** Step budgets of spec section 5, steps 1 and 3 to 7. */
const BUDGET = {
  wallet: 180_000,
  fund: 180_000,
  settle: 240_000,
  burnViaUi: 180_000,
  burnRowPoll: 180_000,
  burnConfirmed: 300_000
} as const;

/**
 * A burn through Send on a fresh standard wallet and a fresh Guardian wallet, each funded by one public faucet grant
 * (USDCx is the testnet fee asset). Run only through `yarn e2e:real --suite usdcx-burn`. Circle's payout is the `usdcx`
 * suite's gate; the burn's key is still kept in the ledger, so its USDC can be recovered.
 */
test.describe('USDCx burn through the Send UI after a public faucet grant', () => {
  // The injected fee faucet masks the wallet's own native-asset discovery (two-wallets.ts:840).
  test.use({ injectFeeFaucet: false });
  test.describe.configure({ timeout: 1_500_000 });
  test.beforeAll(() => assertUsdcxLiveRun(process.env, { needsArcKey: false }));

  for (const guardian of [false, true]) {
    test(`${guardian ? 'Guardian' : 'standard'} wallet publishes a burn and the faucet consumes it`, async ({
      walletA,
      envConfig,
      steps
    }) => {
      const step = namedSteps(steps);
      const where = pageWhere(walletA);
      const evidence = newRunEvidence(`usdcx-burn ${guardian ? 'guardian' : 'standard'}`);
      const secrets: string[] = [];
      let passed = false;
      try {
        const { ids, onGuardian } = await step(
          'wallet',
          BUDGET.wallet,
          async () => {
            const identity = guardian ? await guardianIdentity(envConfig.guardianUrl) : null;
            const address = guardian
              ? await createGuardianUsdcxWallet(walletA, envConfig.guardianUrl)
              : (await walletA.createNewWallet()).address;
            const context: StepContext | undefined = identity ? () => guardianFailureContext(identity) : undefined;
            return { ids: await resolveUsdcxIds(walletA.page, address), onGuardian: context };
          },
          async () => (guardian ? `GUARDIAN_URL=${envConfig.guardianUrl}` : '')
        );
        evidence.ids.address = ids.address;
        evidence.ids.native = ids.native;

        const funding = await step(
          'fund',
          BUDGET.fund,
          () => fundFromPublicFaucet(walletA.page, ids, envConfig.rpcUrl, where),
          onGuardian
        );
        evidence.fees.push(funding.f0);
        evidence.ids.grantNote = funding.grantNoteId;
        // A Guardian burn is not requeued on a pending-delta 409 (transaction/index.ts:196-202): the grant settles first.
        evidence.settleMs.grant = guardian
          ? await step('settle_grant', BUDGET.settle, () => settleGuardian(walletA, 120_000), onGuardian)
          : 0;

        const key = newArcKey();
        secrets.push(key.privateKey);
        evidence.ids.ledgerPath = recordArcKey(key, ids.address);
        evidence.ids.arcKey = key.address;

        const priorBurns = await step(
          'burn_via_ui',
          BUDGET.burnViaUi,
          () =>
            submitBurn(walletA, ids, {
              destination: key.address,
              units: BURN_UNITS,
              screenshotDir: test.info().outputDir
            }),
          onGuardian
        );
        const burn = await step(
          'burn_confirmed',
          BUDGET.burnConfirmed,
          async () => {
            const burn = await confirmBurn(walletA, ids, {
              priorRowIds: priorBurns,
              destination: key.address,
              units: BURN_UNITS,
              vaultBefore: funding.vault,
              rpcUrl: envConfig.rpcUrl,
              guardian,
              timeoutMs: BUDGET.burnRowPoll,
              where
            });
            await assertBurnDetails(walletA, burn.row.id, key.address);
            await walletA.page.screenshot({ path: test.info().outputPath('usdcx-burn-confirmed.png') });
            // The row, not page state, drives the pill, so a reload of the details page reads the same.
            await walletA.page.reload();
            await expect(walletA.page.getByTestId('history-status-pill')).toHaveText(
              anyOf([enText('usdcxBurnConfirmed'), enText('confirmed')])
            );
            await walletA.navigateHome();
            return burn;
          },
          onGuardian
        );
        evidence.ids.burnRow = burn.row.id;
        evidence.ids.burnNote = burn.burnNoteId;
        evidence.hashes.burnTransaction = burn.row.transactionId ?? 'none';
        evidence.fees.push(burn.fee, { name: 's', amount: burn.sponsorship, kind: 'exact' });
        evidence.phases.burn = burn.phases.samples();
        passed = true;
      } finally {
        await attachEvidence(test.info(), 'usdcx-burn-evidence.json', evidence, secrets).catch((error: unknown) => {
          if (passed) throw error;
        });
      }
    });
  }
});
```

- [ ] **Step 5: Run the config-selection tests and watch them pass**

```bash
yarn jest playwright/e2e/harness/spec-selection.test.ts -t 'run under their own config only|config of their own|base testIgnore' --maxWorkers=2
```

Expected: 14 passed, 0 failed.

- [ ] **Step 6: List the tests Playwright selects**

```bash
E2E_NETWORK=localhost node_modules/.bin/playwright test --list --reporter list --config playwright.usdcx.config.ts
for grep in 'USDCx round trip' 'funded Arc key' 'USDCx burn through the Send UI'; do
  E2E_NETWORK=localhost node_modules/.bin/playwright test --list --reporter list --config playwright.usdcx.config.ts --grep "$grep" | tail -1
done
E2E_NETWORK=localhost node_modules/.bin/playwright test --list --reporter list --config playwright.bridge.config.ts | grep -c usdcx
```

Expected (line and column numbers may differ):

```
Listing tests:
  usdcx-burn.spec.ts:<line>:<col> › USDCx burn through the Send UI after a public faucet grant › standard wallet publishes a burn and the faucet consumes it
  usdcx-burn.spec.ts:<line>:<col> › USDCx burn through the Send UI after a public faucet grant › Guardian wallet publishes a burn and the faucet consumes it
  usdcx-roundtrip.spec.ts:<line>:<col> › USDCx round trip: burn to a fresh Arc key, Circle payout, deposit back › Guardian wallet: public faucet grant, Send burn, payout and its confirmation, deposit back, receipt
  usdcx-roundtrip.spec.ts:<line>:<col> › USDCx bridge-in from a funded Arc key › Guardian wallet receives a Node-signed xReserve deposit
Total: 4 tests in 2 files
```

then `Total: 1 test in 1 file`, `Total: 1 test in 1 file`, `Total: 2 tests in 1 file`, and `0` for the bridge config.

- [ ] **Step 7: Confirm nothing still names the old spec's inputs**

```bash
git grep -n -e USDCX_TESTNET_REPO -e xusdc-testnet -- . ':!docs'
git grep -n bridge-out-usdcx -- . ':!CHANGELOG.md' ':!docs'
```

Expected: the first prints nothing; the second prints only the `USDCX_LIVE_SPEC` line of playwright/e2e/harness/spec-selection.test.ts. `docs/` is left out because the design spec and this plan name the old file on purpose.

- [ ] **Step 8: Run every suite in the harness and helpers directories**

```bash
yarn jest playwright/e2e/harness playwright/e2e/helpers --maxWorkers=2
```

Expected: 0 failed.

- [ ] **Step 9: Format, lint, run the harness ratchet and check for dashes**

```bash
FILES="playwright/e2e/tests/usdcx/usdcx-burn.spec.ts playwright/e2e/harness/spec-selection.test.ts"
npx prettier --write $FILES
npx eslint --max-warnings 0 $FILES
node scripts/lint-e2e-harness.mjs
printf 'a\xe2\x80\x94b\n' | grep -c -e $'\xe2\x80\x94'
grep -c -e $'\xe2\x80\x94' -e $'\xe2\x80\x93' playwright/e2e/tests/usdcx/usdcx-burn.spec.ts
git diff -U0 -- playwright/e2e/harness/spec-selection.test.ts | grep '^+' | grep -c -e $'\xe2\x80\x94' -e $'\xe2\x80\x93'
```

Expected: no prettier change, no eslint output; the ratchet passes (playwright/e2e/eslint-rules/known-violations.json has no entry for the old path, so the moved file must have zero hits, and it does); `1`, `0`, `0`.

- [ ] **Step 10: Commit spec commit 12**

```bash
git add playwright/e2e/tests/usdcx/usdcx-burn.spec.ts playwright/e2e/harness/spec-selection.test.ts
git status --short
git commit -m "test(e2e): retarget the USDCx burn spec onto the public faucet and move it to tests/usdcx"
git show --stat --format=%B HEAD
```

Expected: `git status --short` shows the rename `R  playwright/e2e/tests/bridge/bridge-out-usdcx.spec.ts -> playwright/e2e/tests/usdcx/usdcx-burn.spec.ts` (or a `D` plus an `A` when the rewrite drops rename detection) and `M  playwright/e2e/harness/spec-selection.test.ts`, nothing else staged; the body is the single line with no trailer.

---

---

### Task 29: The usdcx SUITES, --arc-rpc/--arc-key, the usdcx refusals and run() unset (p4-args-env)

Runs after Tasks 25-28: its listing tests read the describes that commits 11 and 12 add (`playwright.usdcx.config.ts` and `playwright/e2e/tests/usdcx/*.spec.ts`), so commit 10 lands after commit 12 in the history, and every red and green count below assumes those commits are in.

**Files:**
- Modify: `scripts/e2e-real.mjs`
- Modify: `scripts/e2e-real.test.ts`

**Interfaces:**
- Consumes:
  - `playwright.usdcx.config.ts` (p5-config-isolation, commit 11): `{ ...base, testDir: './playwright/e2e/tests/usdcx', testIgnore: undefined, timeout: 3_600_000 }`.
  - The describe and test titles of p5 (interfaces section 5) in `playwright/e2e/tests/usdcx/usdcx-roundtrip.spec.ts` and `playwright/e2e/tests/usdcx/usdcx-burn.spec.ts`: `USDCx round trip: burn to a fresh Arc key, Circle payout, deposit back` (one test), `USDCx bridge-in from a funded Arc key` (one test), `USDCx burn through the Send UI after a public faucet grant` (`standard wallet publishes a burn and the faucet consumes it`, `Guardian wallet publishes a burn and the faucet consumes it`). Each spec module must load with no env set (spec 4, Guards: env reads live in test bodies).
  - Playwright 1.61.0 `node node_modules/@playwright/test/cli.js test --list --reporter=json`: list mode only loads files and reports (no global setup, no output-dir cleanup, no `.last-run.json`; `runAllTestsWithConfig` and `LastRunReporter.onEnd` in node_modules/playwright/lib/runner/index.js), and its `--grep` compiles case-insensitive (`forceRegExp`, node_modules/playwright/lib/util.js:177-182).
  - Existing runner: `SUITES` (scripts/e2e-real.mjs:64-106), `parseArgs(argv)` (:148-224), `suiteRetries(suite)` (:231-233), `composeGrep(suiteGrep, userGrep)` (:250-256), `resolveOperatorInput(opts)` (:275-301), `run(command, args, env)` (:887-927).
  - Existing test helpers: `cleanEnv()` (scripts/e2e-real.test.ts:38-50), `runCli(first, ...rest)` (:53-64), `INDEXER` (:444), `PUBLISHED` (:445), `DOCUMENT` (:446-453), the stub helpers inside the describe at :455-475.
- Produces:
  - `SUITES.usdcx`, `SUITES['usdcx-in']`, `SUITES['usdcx-burn']`: `{ config: 'playwright.usdcx.config.ts', grep: string, probes: string[], networks: ['testnet'], usdcx: true, arcKey?: true, headlessByDefault: boolean, retries: 0, describe: string }`.
  - `parseArgs(argv)` options gain `arcRpc: string | undefined` (`--arc-rpc`, else `E2E_ARC_RPC_URL`), `arcKey: string | undefined` (`--arc-key`, else `E2E_ARC_PRIVATE_KEY`), `arcRpcFlag: boolean`, `arcKeyFlag: boolean`, `refusedExports: string[]` (names only).
  - `resolveOperatorInput(opts) => { error: string } | { suite, grep }`, refusing for a usdcx suite: a network outside `suite.networks`, `--skip-build`, an exported `E2E_EVM_RPC_URL`, `MIDEN_E2E_USDCX_CHAIN`, `MIDEN_FEE_FAUCET_ID` or `GUARDIAN_URL`, an empty or non-http(s) Arc RPC, and the key errors; and `--arc-rpc`/`--arc-key` on a suite that does not read them. No refusal prints a value.
  - `export function run(command: string, args: string[], env: Record<string, string>, opts?: { unset?: readonly string[] }): Promise<number>`.
  - Module-scope test helpers `stubbed(args: string[], served: unknown, env?: Record<string, string>, answers?: Record<string, unknown>)` and `preflight(suite: string, served?: unknown, env?: Record<string, string>, answers?: Record<string, unknown>)`, each returning `{ status, stdout, stderr, output, requests }` (Task 30 (p4-probes) and p4-suites use them).

Line numbers below are origin/main's; Task 29 (p4-args-env) is the first task to touch these files, so they hold until its own edits. Apply each edit by its quoted Before text.

- [ ] **Step 1: Run the runner test in the node environment and share the stub helpers (no behaviour change)**

The runner is a Node program, so its tests run where `fetch`, `AbortSignal` and `process` are Node's, not jsdom's (jest.config.ts:152 defaults to jsdom). The existing 120 tests pass under `--testEnvironment node` (checked on cfb228a48, whose test file equals origin/main's).

Before (`scripts/e2e-real.test.ts`:1-11):
```ts
/**
 * Unit cover for the two decisions in the real-endpoint runner that can spend
 * money unintentionally, plus the child-process contract.
 *
 * Both guards were added in review and neither was reachable from a test until
 * the runner exported them. `composeGrep`'s own docstring says getting it wrong
 * "would silently widen the run onto specs that spend real money", and
 * `suiteRetries` decides whether a spent, non-idempotent run repeats itself.
 * Those are exactly the things that should not rest on having read the code
 * carefully once.
 */
```
After:
```ts
/**
 * Unit cover for the two decisions in the real-endpoint runner that can spend
 * money unintentionally, plus the child-process contract.
 *
 * Both guards were added in review and neither was reachable from a test until
 * the runner exported them. `composeGrep`'s own docstring says getting it wrong
 * "would silently widen the run onto specs that spend real money", and
 * `suiteRetries` decides whether a spent, non-idempotent run repeats itself.
 * Those are exactly the things that should not rest on having read the code
 * carefully once.
 *
 * @jest-environment node
 */
```

The `.eslintrc` import/order groups external and builtin modules together, so the blank line before `viem` is the warning eslint reports on main today.

Before (`scripts/e2e-real.test.ts`:16-18):
```ts
import { pathToFileURL } from 'node:url';

import { getAddress } from 'viem';
```
After:
```ts
import { pathToFileURL } from 'node:url';
import { getAddress } from 'viem';
```

Before (`scripts/e2e-real.test.ts`:35-50):
```ts
// The caller's environment without any variable the runner reads: a key, an
// empty URL or a served config document there would add its own refusal, or its
// own document, ahead of the one under test.
function cleanEnv() {
  const env = { ...process.env };
  for (const name of [
    'E2E_SEPOLIA_PRIVATE_KEY',
    'EPOCH_ALLOCATOR_URL',
    'EPOCH_POSITIONS_URL',
    'E2E_SEPOLIA_RPC_URL',
    'MIDEN_REMOTE_CONFIG_URL'
  ]) {
    delete env[name];
  }
  return env;
}
```
After:
```ts
// The caller's environment without any variable the runner reads or a usdcx child carries: a key, an empty URL
// or a served config document there would add its own refusal, or its own document, ahead of the one under test.
function cleanEnv() {
  const env = { ...process.env };
  for (const name of [
    'E2E_SEPOLIA_PRIVATE_KEY',
    'EPOCH_ALLOCATOR_URL',
    'EPOCH_POSITIONS_URL',
    'E2E_SEPOLIA_RPC_URL',
    'MIDEN_REMOTE_CONFIG_URL',
    'E2E_ARC_RPC_URL',
    'E2E_ARC_PRIVATE_KEY',
    'E2E_EVM_RPC_URL',
    'MIDEN_E2E_USDCX_CHAIN',
    'MIDEN_FEE_FAUCET_ID',
    'GUARDIAN_URL',
    'MIDEN_CLIENT_BIN',
    'E2E_HEADLESS',
    'E2E_NETWORK',
    'E2E_REAL_EPOCH',
    'E2E_REAL_USDCX'
  ]) {
    delete env[name];
  }
  return env;
}
```

Before (`scripts/e2e-real.test.ts`:455-475):
```ts
describe('the preflight reads what it probes from the network config document', () => {
  const STUB = pathToFileURL(path.join(__dirname, 'e2e-real.fetch-stub.mjs')).href;
  // Any valid secp256k1 scalar: the stub answers every read, so nothing is ever signed or sent.
  const FUNDED_KEY = `0x${'11'.repeat(32)}`;

  // The whole command under --preflight-only, its every request answered by the stub and logged.
  function preflight(suite: string, served: unknown = DOCUMENT, env: Record<string, string> = {}) {
    return stubbed(['--suite', suite, '--preflight-only'], served, env);
  }

  function stubbed(args: string[], served: unknown, env: Record<string, string> = {}) {
    const log = path.join(mkdtempSync(path.join(os.tmpdir(), 'e2e-real-')), 'requests.log');
    writeFileSync(log, '');
    const res = spawnSync(process.execPath, ['--import', STUB, 'scripts/e2e-real.mjs', ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...cleanEnv(), ...env, E2E_REAL_FETCH_STUB: JSON.stringify({ document: served, log }) },
      timeout: 30_000
    });
    return { status: res.status, output: `${res.stdout}${res.stderr}`, requests: readFileSync(log, 'utf8') };
  }
```
After:
```ts
const STUB = pathToFileURL(path.join(__dirname, 'e2e-real.fetch-stub.mjs')).href;

// The whole command, its every request answered by the stub and logged. `answers` overrides the stub's defaults
// (ANSWERS in e2e-real.fetch-stub.mjs).
function stubbed(
  args: string[],
  served: unknown,
  env: Record<string, string> = {},
  answers: Record<string, unknown> = {}
) {
  const log = path.join(mkdtempSync(path.join(os.tmpdir(), 'e2e-real-')), 'requests.log');
  writeFileSync(log, '');
  const res = spawnSync(process.execPath, ['--import', STUB, 'scripts/e2e-real.mjs', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...cleanEnv(), ...env, E2E_REAL_FETCH_STUB: JSON.stringify({ document: served, log, answers }) },
    timeout: 30_000
  });
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    output: `${res.stdout}${res.stderr}`,
    requests: readFileSync(log, 'utf8')
  };
}

// The whole command under --preflight-only.
function preflight(
  suite: string,
  served: unknown = DOCUMENT,
  env: Record<string, string> = {},
  answers: Record<string, unknown> = {}
) {
  return stubbed(['--suite', suite, '--preflight-only'], served, env, answers);
}

describe('the preflight reads what it probes from the network config document', () => {
  // Any valid secp256k1 scalar: the stub answers every read, so nothing is ever signed or sent.
  const FUNDED_KEY = `0x${'11'.repeat(32)}`;
```

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; yarn jest scripts/e2e-real.test.ts --maxWorkers=2
```
Expected: `Tests:       120 passed, 120 total`.

- [ ] **Step 2: Write the failing tests**

Add the two Arc flags to the three existing per-flag lists.

Before (`scripts/e2e-real.test.ts`:246):
```ts
  it.each(['--suite', '--network', '--sepolia-rpc', '--sepolia-key', '--min-eth', '--grep'])(
```
After:
```ts
  it.each(['--suite', '--network', '--sepolia-rpc', '--sepolia-key', '--arc-rpc', '--arc-key', '--min-eth', '--grep'])(
```

Before (`scripts/e2e-real.test.ts`:264-265):
```ts
    ['--sepolia-key', `0x${'1'.repeat(64)}`, `0x${'2'.repeat(64)}`],
    ['--grep', 'aaa', 'bbb']
```
After:
```ts
    ['--sepolia-key', `0x${'1'.repeat(64)}`, `0x${'2'.repeat(64)}`],
    ['--arc-rpc', 'https://c.example', 'https://d.example'],
    ['--arc-key', `0x${'3'.repeat(64)}`, `0x${'4'.repeat(64)}`],
    ['--grep', 'aaa', 'bbb']
```

Before (`scripts/e2e-real.test.ts`:324-326):
```ts
    '--sepolia-key',
    '--min-eth',
    '--grep',
    '--preflight-only',
```
After:
```ts
    '--sepolia-key',
    '--arc-rpc',
    '--arc-key',
    '--min-eth',
    '--grep',
    '--preflight-only',
```

Before (`scripts/e2e-real.test.ts`:671-677):
```ts
describe('run', () => {
  it('resolves a non-zero code when the command cannot be spawned', async () => {
    // 'error' fires instead of 'close' on a spawn failure, so a listener on
    // 'close' alone left this pending forever and hung the whole script.
    await expect(run('this-command-does-not-exist-e2e-real', [], {})).resolves.not.toBe(0);
  }, 15_000);
});
```
After:
```ts
describe('run', () => {
  it('resolves a non-zero code when the command cannot be spawned', async () => {
    // 'error' fires instead of 'close' on a spawn failure, so a listener on
    // 'close' alone left this pending forever and hung the whole script.
    await expect(run('this-command-does-not-exist-e2e-real', [], {})).resolves.not.toBe(0);
  }, 15_000);

  // main() hands every child the operator's whole environment, so leaving a key out of `env` strips nothing.
  it('deletes each unset name from the inherited environment, and a value given in env still wins', async () => {
    const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'e2e-real-run-')), 'env.json');
    const dump = `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env))`;
    process.env.E2E_REAL_RUN_INHERITED = 'inherited';
    process.env.E2E_REAL_RUN_GIVEN = 'inherited';
    try {
      const code = await run(
        process.execPath,
        ['-e', dump],
        { E2E_REAL_RUN_ADDED: 'added', E2E_REAL_RUN_GIVEN: 'given' },
        { unset: ['E2E_REAL_RUN_INHERITED', 'E2E_REAL_RUN_GIVEN'] }
      );
      expect(code).toBe(0);
      const env = JSON.parse(readFileSync(out, 'utf8'));
      expect(env.E2E_REAL_RUN_INHERITED).toBeUndefined();
      expect(env.E2E_REAL_RUN_ADDED).toBe('added');
      expect(env.E2E_REAL_RUN_GIVEN).toBe('given');
    } finally {
      delete process.env.E2E_REAL_RUN_INHERITED;
      delete process.env.E2E_REAL_RUN_GIVEN;
    }
  }, 15_000);
});
```

Append to the end of `scripts/e2e-real.test.ts`:
```ts
// Every invocation here passes --preflight-only, so a refusal that regresses can reach the probes but never a build.
describe('the usdcx suites refuse what would not apply, before any probe or build', () => {
  const ARC_KEY = `0x${'5a'.repeat(32)}`;
  const MALFORMED = `0x${'5a'.repeat(31)}zz`;
  const printed = (res: { stdout: string; stderr: string }) => `${res.stdout}${res.stderr}`;

  it.each(['usdcx', 'usdcx-in', 'usdcx-burn'])(
    'refuses --network devnet for --suite %s',
    suite => {
      const res = runCli('--suite', suite, '--network', 'devnet', '--preflight-only');
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(`--suite ${suite} runs on testnet only`);
      expect(res.stdout).not.toContain('Preflight');
    },
    35_000
  );

  it.each(['usdcx', 'usdcx-in', 'usdcx-burn'])(
    'refuses --skip-build for --suite %s',
    suite => {
      const res = runCli({ E2E_ARC_PRIVATE_KEY: ARC_KEY }, '--suite', suite, '--skip-build', '--preflight-only');
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(`--skip-build is refused for --suite ${suite}`);
      expect(printed(res)).not.toContain(ARC_KEY.slice(2));
      expect(res.stdout).not.toContain('Preflight');
    },
    35_000
  );

  it.each([
    ['E2E_EVM_RPC_URL', 'https://refused-evm-rpc.example'],
    ['MIDEN_E2E_USDCX_CHAIN', 'refused-usdcx-chain'],
    ['MIDEN_FEE_FAUCET_ID', '0xrefusedfeefaucet'],
    ['GUARDIAN_URL', 'https://refused-guardian.example']
  ])(
    'refuses an exported %s by name, never by value',
    (name, value) => {
      const res = runCli({ [name]: value }, '--suite', 'usdcx-burn', '--preflight-only');
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(`${name} is set, and --suite usdcx-burn refuses it`);
      expect(printed(res)).not.toContain(value);
      expect(res.stdout).not.toContain('Preflight');
    },
    35_000
  );

  it('refuses usdcx-in with no key', () => {
    const res = runCli('--suite', 'usdcx-in', '--preflight-only');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--suite usdcx-in needs a funded Arc Testnet key');
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);

  it('refuses usdcx-in with E2E_ARC_PRIVATE_KEY set but empty', () => {
    const res = runCli({ E2E_ARC_PRIVATE_KEY: '' }, '--suite', 'usdcx-in', '--preflight-only');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('E2E_ARC_PRIVATE_KEY is set but empty');
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);

  it.each([
    ['--arc-key', {}, ['--arc-key', MALFORMED]],
    ['E2E_ARC_PRIVATE_KEY', { E2E_ARC_PRIVATE_KEY: MALFORMED }, []]
  ])(
    'refuses a malformed key from %s without printing it',
    (_source, env, args) => {
      const res = runCli(env, '--suite', 'usdcx-in', ...args, '--preflight-only');
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('the Arc key (--arc-key or E2E_ARC_PRIVATE_KEY) is not a valid private key');
      expect(printed(res)).not.toContain('5a'.repeat(31));
      expect(res.stdout).not.toContain('Preflight');
    },
    35_000
  );

  it.each(['usdcx', 'usdcx-burn', 'swap'])(
    'refuses --arc-key on --suite %s without printing it',
    suite => {
      const res = runCli('--suite', suite, '--arc-key', ARC_KEY, '--preflight-only');
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('--arc-key applies only to --suite usdcx-in');
      expect(printed(res)).not.toContain(ARC_KEY.slice(2));
      expect(res.stdout).not.toContain('Preflight');
    },
    35_000
  );

  it('refuses --arc-rpc on a suite that never reads Arc, without printing it', () => {
    const res = runCli('--suite', 'swap', '--arc-rpc', 'https://arc-rpc.example/token-in-path', '--preflight-only');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--arc-rpc applies only to the usdcx suites');
    expect(printed(res)).not.toContain('token-in-path');
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);

  it('refuses E2E_ARC_RPC_URL set but empty on a usdcx suite', () => {
    const res = runCli({ E2E_ARC_RPC_URL: '' }, '--suite', 'usdcx', '--preflight-only');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('E2E_ARC_RPC_URL is set but empty');
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);

  it('refuses an Arc RPC that is not an http(s) URL, without printing it', () => {
    const res = runCli('--suite', 'usdcx', '--arc-rpc', 'ftp://arc-rpc.example/token-in-path', '--preflight-only');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('the Arc RPC (--arc-rpc or E2E_ARC_RPC_URL) is not an http(s) URL');
    expect(printed(res)).not.toContain('token-in-path');
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);

  it('never echoes an --arc-key given with =', () => {
    const res = runCli(`--arc-key=${ARC_KEY}`, '--suite', 'usdcx-in', '--preflight-only');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('unknown argument: --arc-key=<value>');
    expect(printed(res)).not.toContain(ARC_KEY.slice(2));
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);

  it('refuses another option as the value of --arc-key', () => {
    const res = runCli('--suite', 'usdcx-in', '--arc-key', '--preflight-only');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--arc-key needs a value');
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);
});

describe('resolveOperatorInput on the usdcx suites', () => {
  const ARC_KEY = `0x${'ab'.repeat(32)}`;
  // What parseArgs returns for `--suite usdcx` with nothing exported; each case changes only what it names.
  const parsed = {
    suite: 'usdcx',
    network: 'testnet',
    sepoliaRpc: 'https://sepolia.invalid',
    sepoliaKey: undefined,
    arcRpc: undefined,
    arcKey: undefined,
    arcRpcFlag: false,
    arcKeyFlag: false,
    refusedExports: [],
    minEth: '0.02',
    preflightOnly: false,
    skipBuild: false,
    headed: false,
    grep: undefined
  };
  const resolve = (changed: Record<string, unknown> = {}) => resolveOperatorInput({ ...parsed, ...changed });

  it.each([
    ['usdcx', {}],
    ['usdcx-burn', {}],
    ['usdcx-in', { arcKey: ARC_KEY }],
    ['usdcx-in', { arcKey: 'ab'.repeat(32), arcKeyFlag: true }],
    ['usdcx', { arcRpc: 'https://arc-rpc.example', arcRpcFlag: true }]
  ])('accepts --suite %s with %o', (suite, changed) => {
    expect(resolve({ suite, ...changed })).toStrictEqual({ suite: SUITES[suite], grep: SUITES[suite].grep });
  });

  // run() unsets it for every usdcx child but usdcx-in's test, so no other usdcx suite reads it.
  it('lets an exported key that is malformed pass on usdcx, which never reads it', () => {
    expect(resolve({ arcKey: '0x01' }).error).toBeUndefined();
  });

  it('leaves the usdcx refusals off a suite that is not usdcx', () => {
    expect(
      resolve({ suite: 'swap-guardian', refusedExports: ['GUARDIAN_URL', 'E2E_EVM_RPC_URL'] }).error
    ).toBeUndefined();
  });
});

const PLAYWRIGHT_CLI = path.join(REPO_ROOT, 'node_modules', '@playwright', 'test', 'cli.js');

interface ListedSuite {
  title: string;
  specs?: { title: string }[];
  suites?: ListedSuite[];
}

// Playwright's own listing of playwright.usdcx.config.ts as `<describe> > <test>`, narrowed by `grep` the way the
// runner passes it. usdcx-burn builds its two titles in a loop, so no reading of the spec source can stand in for
// this. List mode loads the files and writes nothing: no global setup, no output-dir cleanup.
function listUsdcxTests(grep?: string) {
  const env = cleanEnv();
  // Playwright refuses to declare a test while JEST_WORKER_ID is set, and this child inherits it from the worker.
  delete env.JEST_WORKER_ID;
  delete env.PLAYWRIGHT_JSON_OUTPUT_NAME;
  delete env.PLAYWRIGHT_JSON_OUTPUT_FILE;
  const res = spawnSync(
    process.execPath,
    [
      PLAYWRIGHT_CLI,
      'test',
      '--list',
      '--config',
      'playwright.usdcx.config.ts',
      '--reporter=json',
      ...(grep === undefined ? [] : ['--grep', grep])
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', env, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }
  );
  let report: { suites: ListedSuite[]; errors: unknown[] };
  try {
    report = JSON.parse(res.stdout);
  } catch {
    // A config that throws at load prints its error to stderr and no report.
    throw new Error(
      `playwright --list printed no JSON report (exit ${res.status}): ${res.stderr}\n${res.stdout.slice(0, 200)}`
    );
  }
  const tests: string[] = [];
  const walk = (suite: ListedSuite, titles: string[]) => {
    for (const spec of suite.specs ?? []) tests.push([...titles, spec.title].join(' > '));
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  for (const file of report.suites) walk(file, []);
  return { tests: tests.sort(), errors: report.errors };
}

describe('the usdcx suites', () => {
  const OWN: Record<string, string> = {
    usdcx: 'USDCx round trip: burn to a fresh Arc key, Circle payout, deposit back',
    'usdcx-in': 'USDCx bridge-in from a funded Arc key',
    'usdcx-burn': 'USDCx burn through the Send UI after a public faucet grant'
  };
  let listed: ReturnType<typeof listUsdcxTests>;

  beforeAll(() => {
    listed = listUsdcxTests();
  }, 60_000);

  it('find the three describes and four tests the contract names under playwright.usdcx.config.ts', () => {
    expect(listed.errors).toEqual([]);
    expect([...new Set(listed.tests.map(test => test.split(' > ')[0]))].sort()).toEqual(Object.values(OWN).sort());
    expect(listed.tests).toHaveLength(4);
    expect(listed.tests.filter(test => test.startsWith(`${OWN['usdcx-burn']} > `))).toEqual([
      `${OWN['usdcx-burn']} > Guardian wallet publishes a burn and the faucet consumes it`,
      `${OWN['usdcx-burn']} > standard wallet publishes a burn and the faucet consumes it`
    ]);
  });

  it.each(Object.keys(OWN))(
    '--suite %s greps exactly the tests of its own describe',
    name => {
      const own = listed.tests.filter(test => test.startsWith(`${OWN[name]} > `));
      expect(listUsdcxTests(composeGrep(SUITES[name].grep, undefined))).toEqual({ tests: own, errors: [] });
    },
    60_000
  );

  // Each spends a faucet grant, a burn Circle pays out or a deposit Circle mints; a retry spends it again.
  it.each(Object.keys(OWN))('--suite %s runs playwright.usdcx.config.ts on testnet, with no retries', name => {
    expect(SUITES[name]).toMatchObject({ config: 'playwright.usdcx.config.ts', networks: ['testnet'], usdcx: true });
    expect(suiteRetries(SUITES[name])).toBe(0);
  });

  it('takes an Arc key on usdcx-in alone', () => {
    expect(Object.keys(SUITES).filter(name => SUITES[name].arcKey)).toEqual(['usdcx-in']);
  });
});

// Guards: both pass before this change and must after it.
describe('the usdcx refusals stay out of the other entry points', () => {
  it('swap-guardian still probes an exported GUARDIAN_URL override', () => {
    const res = preflight('swap-guardian', DOCUMENT, { GUARDIAN_URL: 'https://guardian-override.example' });
    expect(res.requests).toContain('https://guardian-override.example\n');
    expect(res.output).not.toContain('GUARDIAN_URL is set');
    expect(res.status).toBe(0);
  }, 35_000);

  it('--agglayer-indexer-only with every refused variable exported reads the document and asks only its indexer', () => {
    const res = stubbed(['--agglayer-indexer-only'], DOCUMENT, {
      E2E_EVM_RPC_URL: 'https://evm.example',
      MIDEN_E2E_USDCX_CHAIN: 'sepolia',
      MIDEN_FEE_FAUCET_ID: '0x01',
      GUARDIAN_URL: 'https://guardian.example',
      E2E_ARC_RPC_URL: '',
      E2E_ARC_PRIVATE_KEY: ''
    });
    expect(res.requests.trim().split('\n')).toEqual([
      PUBLISHED,
      `${INDEXER}/bridge?net_id=${AGGLAYER_MIDEN_NETWORK_ID}&deposit_cnt=0`
    ]);
    expect(res.status).toBe(0);
  }, 35_000);
});
```

- [ ] **Step 3: Run the new tests and watch them fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; yarn jest scripts/e2e-real.test.ts --maxWorkers=2
```
Expected: `Tests:       41 failed, 125 passed, 166 total`. The 120 existing tests pass, and so do four new guards that hold before the change and must after it: both tests of `the usdcx refusals stay out of the other entry points`, `never echoes an --arc-key given with =` (parseArgs already prints any `--name=` argument as `<value>`), `leaves the usdcx refusals off a suite that is not usdcx`, and `find the three describes and four tests ...` (it reads p5's spec files, not the runner). Every other new test fails:
- `refuses an empty value for --arc-rpc` (and `--arc-key`), `refuses --arc-rpc given twice` (and `--arc-key`), `refuses the documented option --arc-rpc as the value of --grep` (and `--arc-key`): `Expected substring: "--arc-rpc needs a value"` against `Received string: "✗ unknown argument: --arc-rpc"` (the documented-option cases instead show `--min-eth must be a plain non-negative decimal`, since `--arc-rpc` is not yet an option name).
- `deletes each unset name from the inherited environment, ...`: `expect(received).toBeUndefined()` `Received: "inherited"`.
- Every other case of `the usdcx suites refuse what would not apply, ...`: the stderr holds `unknown suite "usdcx"` (or `unknown argument: --arc-key`) instead of the expected refusal.
- `resolveOperatorInput on the usdcx suites`: `accepts --suite usdcx with {}` shows `Received: {"error": "unknown suite \"usdcx\". One of: ..."}`.
- `resolveOperatorInput on the usdcx suites`: `lets an exported key that is malformed pass on usdcx, ...` also shows the `unknown suite` error.
- `the usdcx suites`: `--suite usdcx greps exactly the tests of its own describe` fails with `TypeError: Cannot read properties of undefined (reading 'grep')`; `--suite usdcx runs playwright.usdcx.config.ts ...` with `Received: undefined`; `takes an Arc key on usdcx-in alone` with `Received: []`.

- [ ] **Step 4: Implement the suites, the flags, the refusals and run() unset**

Before (`scripts/e2e-real.mjs`:21-23):
```js
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
```
After:
```js
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
```

Before (`scripts/e2e-real.mjs`:100-106):
```js
  'swap-guardian': {
    config: 'playwright.swap.config.ts',
    grep: 'guardian maker',
    probes: ['dex', 'guardian'],
    describe: 'a guardian-co-signed PSWAP maker order against a hosted testnet guardian'
  }
};
```
After:
```js
  'swap-guardian': {
    config: 'playwright.swap.config.ts',
    grep: 'guardian maker',
    probes: ['dex', 'guardian'],
    describe: 'a guardian-co-signed PSWAP maker order against a hosted testnet guardian'
  },
  // The usdcx suites spend real value end to end: a public faucet grant, a burn Circle pays out, a deposit Circle's
  // relayer mints. A retry spends each again on a second fresh Guardian, so none gets one. Each grep selects exactly
  // one describe of playwright/e2e/tests/usdcx, which e2e-real.test.ts checks against Playwright's own listing.
  // `headlessByDefault`: the test run gets E2E_HEADLESS=1 unless --headed, because BridgeIntentWatcher, which moves
  // the burn and deposit phases, polls only while its page reads visible, and new-headless Chromium keeps it so.
  usdcx: {
    config: 'playwright.usdcx.config.ts',
    grep: 'USDCx round trip',
    probes: ['usdcx', 'usdcx-guardian', 'grant', 'arc-payout'],
    networks: ['testnet'],
    usdcx: true,
    headlessByDefault: true,
    retries: 0,
    describe: 'fresh Guardian: faucet grant, UI burn to a fresh Arc key, Circle payout, deposit back'
  },
  'usdcx-in': {
    config: 'playwright.usdcx.config.ts',
    grep: 'funded Arc key',
    probes: ['usdcx', 'usdcx-guardian', 'funded-key'],
    networks: ['testnet'],
    usdcx: true,
    arcKey: true,
    headlessByDefault: true,
    retries: 0,
    describe: 'fresh Guardian: deposit from a funded Arc key (--arc-key), attest, mint, receive'
  },
  'usdcx-burn': {
    config: 'playwright.usdcx.config.ts',
    grep: 'USDCx burn through the Send UI',
    probes: ['usdcx', 'usdcx-guardian', 'grant'],
    networks: ['testnet'],
    usdcx: true,
    headlessByDefault: true,
    retries: 0,
    describe: 'standard and Guardian wallets: faucet grant, UI burn, faucet consume'
  }
};
```
(spike-dependent: Q8 headless visibility. If the step 1 spike shows `document.visibilityState` leaving `visible` under `E2E_HEADLESS=1`, set `headlessByDefault: false` on all three, drop the comment's last sentence, and flip the `E2E_HEADLESS` expectations in Task 31 (p4-suites).)

Before (`scripts/e2e-real.mjs`:146-148):
```js
// ── args ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
```
After:
```js
// ── args ────────────────────────────────────────────────────────────────────

/**
 * Exported variables a usdcx run refuses, each with why. An E2E build bakes the first three in, and nothing a usdcx
 * spec runs reads GUARDIAN_URL, so each would move what the run checks, or seem to, without a word. Refused by name.
 */
const USDCX_REFUSED_EXPORTS = {
  E2E_EVM_RPC_URL: 'an E2E build reads Sepolia, Base Sepolia and Arbitrum Sepolia through it',
  MIDEN_E2E_USDCX_CHAIN: 'an E2E build then starts a bridge-in from Sepolia instead of Arc Testnet',
  MIDEN_FEE_FAUCET_ID: 'an E2E build then pins the fee asset instead of discovering it from the node',
  GUARDIAN_URL: 'the usdcx suites always use the hosted Guardian of --network, so it would silently not apply'
};
const ARC_KEY_PATTERN = /^(0x)?[0-9a-f]{64}$/i;

function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function parseArgs(argv) {
```

Before (`scripts/e2e-real.mjs`:149-154):
```js
  const opts = {
    suite: undefined,
    network: 'testnet',
    sepoliaRpc: process.env.E2E_SEPOLIA_RPC_URL ?? DEFAULT_SEPOLIA_RPC,
    sepoliaKey: process.env.E2E_SEPOLIA_PRIVATE_KEY,
    minEth: '0.02',
```
After:
```js
  const opts = {
    suite: undefined,
    network: 'testnet',
    sepoliaRpc: process.env.E2E_SEPOLIA_RPC_URL ?? DEFAULT_SEPOLIA_RPC,
    sepoliaKey: process.env.E2E_SEPOLIA_PRIVATE_KEY,
    arcRpc: process.env.E2E_ARC_RPC_URL,
    arcKey: process.env.E2E_ARC_PRIVATE_KEY,
    refusedExports: Object.keys(USDCX_REFUSED_EXPORTS).filter(name => process.env[name] !== undefined),
    minEth: '0.02',
```

Before (`scripts/e2e-real.mjs`:172-174):
```js
    '--sepolia-key': 'sepoliaKey',
    '--min-eth': 'minEth',
    '--grep': 'grep'
```
After:
```js
    '--sepolia-key': 'sepoliaKey',
    '--arc-rpc': 'arcRpc',
    '--arc-key': 'arcKey',
    '--min-eth': 'minEth',
    '--grep': 'grep'
```

Before (`scripts/e2e-real.mjs`:205-209):
```js
    } else if (arg.includes('=')) {
      fail(`unknown argument: ${arg.split('=', 1)[0]}=<value> (pass the value as its own argument)`);
    } else fail(`unknown argument: ${arg}`);
  }
  if (opts.agglayerIndexerOnly) {
```
After:
```js
    } else if (arg.includes('=')) {
      fail(`unknown argument: ${arg.split('=', 1)[0]}=<value> (pass the value as its own argument)`);
    } else fail(`unknown argument: ${arg}`);
  }
  // A flag is refused where it would not apply; the same value exported is left alone (run() unsets it).
  opts.arcRpcFlag = seen.has('--arc-rpc');
  opts.arcKeyFlag = seen.has('--arc-key');
  if (opts.agglayerIndexerOnly) {
```

Before (`scripts/e2e-real.mjs`:280-301):
```js
  const suite = SUITES[opts.suite];
  if (!Object.hasOwn(MIDEN_RPC, opts.network)) {
    return { error: `--network must be one of: ${Object.keys(MIDEN_RPC).join(', ')}` };
  }
  let grep;
  try {
    grep = composeGrep(suite.grep, opts.grep);
  } catch (error) {
    return { error: error.message };
  }
  if (!/^\d+(\.\d+)?$/.test(opts.minEth)) {
    return { error: `--min-eth must be a plain non-negative decimal amount of ether, got "${opts.minEth}"` };
  }
  // The key itself is never echoed.
  if (suite.probes?.includes('sepolia') && opts.sepoliaKey && !/^(0x)?[0-9a-fA-F]{64}$/.test(opts.sepoliaKey)) {
    return {
      error:
        'the Sepolia key (--sepolia-key or E2E_SEPOLIA_PRIVATE_KEY) is not a valid private key: expect 32 bytes of hex, with an optional 0x prefix'
    };
  }
  return { suite, grep };
}
```
After:
```js
  const suite = SUITES[opts.suite];
  if (!Object.hasOwn(MIDEN_RPC, opts.network)) {
    return { error: `--network must be one of: ${Object.keys(MIDEN_RPC).join(', ')}` };
  }
  if (suite.networks && !suite.networks.includes(opts.network)) {
    return { error: `--suite ${opts.suite} runs on ${suite.networks.join(', ')} only` };
  }
  let grep;
  try {
    grep = composeGrep(suite.grep, opts.grep);
  } catch (error) {
    return { error: error.message };
  }
  if (!/^\d+(\.\d+)?$/.test(opts.minEth)) {
    return { error: `--min-eth must be a plain non-negative decimal amount of ether, got "${opts.minEth}"` };
  }
  // The key itself is never echoed.
  if (suite.probes?.includes('sepolia') && opts.sepoliaKey && !/^(0x)?[0-9a-fA-F]{64}$/.test(opts.sepoliaKey)) {
    return {
      error:
        'the Sepolia key (--sepolia-key or E2E_SEPOLIA_PRIVATE_KEY) is not a valid private key: expect 32 bytes of hex, with an optional 0x prefix'
    };
  }
  const usdcxProblem = usdcxInputProblem(opts, suite);
  if (usdcxProblem !== undefined) return { error: usdcxProblem };
  return { suite, grep };
}

/**
 * Why the input cannot run `suite`, for what only the usdcx suites read: the Arc flags, the refused exports and
 * --skip-build. No message carries a value: a key, or a URL whose path may hold one.
 */
function usdcxInputProblem(opts, suite) {
  if (!suite.usdcx) {
    if (opts.arcRpcFlag) return '--arc-rpc applies only to the usdcx suites';
    if (opts.arcKeyFlag) return '--arc-key applies only to --suite usdcx-in';
    return undefined;
  }
  // The build bakes the network and the E2E flags these suites depend on, so a reused dist/ proves nothing.
  if (opts.skipBuild) return `--skip-build is refused for --suite ${opts.suite}: it always builds`;
  const exported = (opts.refusedExports ?? []).find(name => Object.hasOwn(USDCX_REFUSED_EXPORTS, name));
  if (exported !== undefined) {
    return `${exported} is set, and --suite ${opts.suite} refuses it: ${USDCX_REFUSED_EXPORTS[exported]}. Unset it.`;
  }
  if (opts.arcRpc === '') return 'E2E_ARC_RPC_URL is set but empty';
  if (opts.arcRpc !== undefined && !isHttpUrl(opts.arcRpc)) {
    return 'the Arc RPC (--arc-rpc or E2E_ARC_RPC_URL) is not an http(s) URL';
  }
  if (!suite.arcKey) return opts.arcKeyFlag ? '--arc-key applies only to --suite usdcx-in' : undefined;
  if (opts.arcKey === undefined) {
    return `--suite ${opts.suite} needs a funded Arc Testnet key: pass --arc-key or export E2E_ARC_PRIVATE_KEY (a paid usdcx run leaves one under ~/.miden-e2e/arc-keys)`;
  }
  if (opts.arcKey === '') return 'E2E_ARC_PRIVATE_KEY is set but empty';
  if (!ARC_KEY_PATTERN.test(opts.arcKey)) {
    return 'the Arc key (--arc-key or E2E_ARC_PRIVATE_KEY) is not a valid private key: expect 32 bytes of hex, with an optional 0x prefix';
  }
  return undefined;
}
```

Before (`scripts/e2e-real.mjs`:887-889):
```js
export function run(command, args, env) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
```
After:
```js
/**
 * Run `command` with `env` over this process's environment, less each name in `opts.unset`. A key a phase must not
 * see has to be deleted: the child inherits everything the operator exported. A name both unset and given in `env`
 * takes the given value.
 */
export function run(command, args, env, opts = {}) {
  return new Promise(resolve => {
    const inherited = { ...process.env };
    for (const name of opts.unset ?? []) delete inherited[name];
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: 'inherit', env: { ...inherited, ...env } });
```

- [ ] **Step 5: Run the file and see it pass**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; yarn jest scripts/e2e-real.test.ts --maxWorkers=2
```
Expected: `Tests:       166 passed, 166 total` (120 existing, 46 new).

- [ ] **Step 6: See what each grep selects in Playwright's own listing**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
yarn playwright test --list --config playwright.usdcx.config.ts --grep 'USDCx round trip'
yarn playwright test --list --config playwright.usdcx.config.ts --grep 'funded Arc key'
yarn playwright test --list --config playwright.usdcx.config.ts --grep 'USDCx burn through the Send UI'
```
Expected: the first lists one line under `USDCx round trip: burn to a fresh Arc key, Circle payout, deposit back` and ends `Total: 1 test in 1 file`; the second one line under `USDCx bridge-in from a funded Arc key` and `Total: 1 test in 1 file`; the third the `standard` and `Guardian` lines under `USDCx burn through the Send UI after a public faucet grant` and `Total: 2 tests in 1 file`.

- [ ] **Step 7: Format and lint**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
npx prettier --write scripts/e2e-real.mjs scripts/e2e-real.test.ts
npx eslint --max-warnings 0 scripts/e2e-real.mjs scripts/e2e-real.test.ts
```
Expected: eslint exits 0. On origin/main these two files carry two `import/order` warnings (`node:path` after `node:url`; a blank line inside the external/builtin group), which Steps 1 and 4 remove.

- [ ] **Step 8: Commit deferred to Task 31 (p4-suites).**

Mutation notes (revert one implementation line, the named test fails):
- `refuses an empty value for --arc-rpc`/`--arc-key`, `refuses --arc-rpc/--arc-key given twice`, `refuses the documented option --arc-rpc/--arc-key as the value of --grep`: drop the two `takesValue` entries; each reports `unknown argument` (or the `--min-eth` refusal) instead.
- `deletes each unset name from the inherited environment, ...`: drop `for (const name of opts.unset ?? []) delete inherited[name];`; `E2E_REAL_RUN_INHERITED` reads `"inherited"`.
- `refuses --network devnet for --suite %s`: drop the `suite.networks` check in resolveOperatorInput; stderr lacks `runs on testnet only` (the devnet probes run instead, never a build, under `--preflight-only`).
- `refuses --skip-build for --suite %s`: drop the `opts.skipBuild` line in usdcxInputProblem; stderr lacks the refusal.
- `refuses an exported %s by name, never by value`: make `refusedExports` filter return nothing; stderr lacks `is set, and --suite usdcx-burn refuses it`. Printing `process.env[name]` in the message fails `not.toContain(value)` instead.
- `refuses usdcx-in with no key` / `... set but empty` / `refuses a malformed key from %s ...`: drop the matching `opts.arcKey` check; the refusal text is missing.
- `refuses --arc-key on --suite %s ...`: drop `if (opts.arcKeyFlag) return ...` (swap) or the `!suite.arcKey` line (usdcx, usdcx-burn); no refusal.
- `refuses --arc-rpc on a suite that never reads Arc, ...`: drop `if (opts.arcRpcFlag) return ...`; no refusal.
- `refuses E2E_ARC_RPC_URL set but empty ...` / `refuses an Arc RPC that is not an http(s) URL, ...`: drop the matching `opts.arcRpc` check; no refusal.
- `never echoes an --arc-key given with =`: a guard that passes before the change; printing `arg` where parseArgs prints `arg.split('=', 1)[0]` fails it.
- `refuses another option as the value of --arc-key`: drop `'--arc-key'` from `takesValue`; it reports `unknown argument: --arc-key`.
- `accepts --suite %s with %o`: make `isHttpUrl` accept only `http:`, or drop the `(0x)?` from `ARC_KEY_PATTERN`; the https and unprefixed cases return `{ error }` instead of `{ suite, grep }`.
- `lets an exported key that is malformed pass on usdcx, ...`: move the key checks above `if (!suite.arcKey)`; usdcx is refused with the malformed-key message.
- `leaves the usdcx refusals off a suite that is not usdcx`: drop the `if (!suite.usdcx)` early return; swap-guardian is refused for GUARDIAN_URL.
- `--suite %s greps exactly the tests of its own describe`: set usdcx-in's grep to `Arc key`; its listing also holds the round trip test (`burn to a fresh Arc key`).
- `--suite %s runs playwright.usdcx.config.ts on testnet, with no retries`: drop `retries: 0` from any usdcx entry; `suiteRetries` returns 1.
- `takes an Arc key on usdcx-in alone`: add `arcKey: true` to usdcx; the list is `['usdcx', 'usdcx-in']`.
- `find the three describes and four tests ...`: a renamed describe or a third burn variant in p5's specs fails it (it pins p5's titles, not runner code).
- `swap-guardian still probes an exported GUARDIAN_URL override` and `--agglayer-indexer-only with every refused variable exported ...`: move the usdcx refusals into parseArgs ahead of the `agglayerIndexerOnly` return and make them suite-blind; both are refused.

---

### Task 30: Bounded 429/-32005 retry, the usdcx probes and the fetch stub (p4-probes)

**Files:**
- Modify: `scripts/e2e-real.mjs`
- Modify: `scripts/e2e-real.test.ts`
- Rewrite: `scripts/e2e-real.fetch-stub.mjs`

**Interfaces:**
- Consumes:
  - `faucetGrantAmount(metadata: unknown): bigint` (src/lib/miden-chain/faucet-protocol.ts:20; imports nothing): what `mintFromPublicFaucet` asks for (@main playwright/e2e/helpers/public-faucet.ts:224-230,260). Spec 9's probe table judges `base_amount` (>= 11 USDCx, balance >= `base_amount`); this probe judges the grant the harness actually requests and balance >= that grant, a deliberate and stricter reading (with the live `token_amounts [1,10,100]` both are 100 USDCx).
  - `discoverFeeFaucetId(rpcUrl: string, sdkRoot?: string): Promise<string>` (playwright/e2e/helpers/fee-faucet.ts:33) and `midenAccountHexToXReserveRecipient(hexId: string): Hex` (src/lib/usdcx/recipient.ts:19), both run in a ts-node child.
  - p3 `playwright/e2e/helpers/usdcx-constants.ts` (interfaces 3.1): `ARC_CHAIN_ID`, `ARC_XRESERVE`, `ARC_USDC`, `ARC_ATTESTATION_API`, `ARC_CIRCLE_DOMAIN`, `GATEWAY_MINTER`, `DEFAULT_ARC_RPCS`, `USDCX_REMOTE_DOMAIN`, `BURN_UNITS`, `GRANT_MARGIN_UNITS`, `DEPOSIT_UNITS`, `GAS_RESERVE_UNITS`.
  - Wallet constants: `XRESERVE_ADDRESS`, `CIRCLE_USDC_ADDRESS`, `CIRCLE_DOMAIN`, `XRESERVE_ATTESTATION_API_TESTNET`, `USDCX_REMOTE_DOMAIN`, `USDCX_DECIMALS` (src/lib/usdcx/constant.ts), `ARC_TESTNET` (src/lib/walletconnect/config.ts:12-19).
  - Existing runner: `GUARDIAN_URL` (scripts/e2e-real.mjs:55-58), `MIDEN_RPC` (:46-49), `MIDEN_FAUCET_API` (:59-62), `getJson` (:336-350), `rpc` (:352-372), `PARSE_SCRIPT` (:391-399), `parseLikeTheWallet` (:414-431), `probeMidenFaucet` (:513-525), `probeGuardian` (:722-735), `record` (:312-316), `formatUnits` (:875-883), `main` (:929-1039); and from Task 29 (p4-args-env) `SUITES.usdcx*`, `opts.arcRpc`, `opts.arcKey`, `stubbed`, `preflight`.
  - Live answers the stub's defaults copy (read 2026-10-10): `https://faucet-api.testnet.miden.io/get_metadata` (`decimals` 6, `base_amount` 100000000, `token_amounts` [1,10,100], `balance`), Guardian `/status` and `/pubkey?scheme=ecdsa`, Circle `/v1/info` (domain 10007 `remoteTokenIdentifier` `0x...4cbdcaffe75f0a317482224dae643600`, source domain 26 at the xReserve), and `eth_sendRawTransaction('0x00')` answering `{"code":-32602,"message":"failed to decode signed transaction"}` on drpc, QuickNode and arc.io.
- Produces (all in `scripts/e2e-real.mjs`):
  - `export const ARC_TESTNET_CHAIN_ID = 5042002`, `ARC_XRESERVE = '0x008888878f94C0d87defdf0B07f46B93C1934442'`, `ARC_USDC = '0x3600000000000000000000000000000000000000'`, `ARC_CIRCLE_DOMAIN = 26`, `USDCX_REMOTE_DOMAIN = 10007`, `USDCX_DECIMALS = 6`, `XRESERVE_API_TESTNET = 'https://xreserve-api-testnet.circle.com'`, `GATEWAY_MINTER = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B'`, `DEFAULT_ARC_RPCS` (drpc, QuickNode, arc.io), `USDCX_GRANT_FLOOR_UNITS = 11_000_000n`, `USDCX_FUNDED_KEY_FLOOR_UNITS = 1_050_000n`.
  - `export function arcRpc(url: string, method: string, params: unknown[], deps?: { fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, timeoutMs?: number }): Promise<unknown>` and `export function circleGet(url: string, deps?): Promise<{ status: number, body: unknown, headers: Headers }>`: each retries at most 3 times on HTTP 429 or JSON-RPC -32005, waiting Retry-After seconds capped at 10 s, else 1 s.
  - `export function arcRpcEndpoints(override?: string): string[]`.
  - `export function usdcxGrantProblem(metadata: unknown, grantAmount: bigint): string | undefined`.
  - Preflight records, by label: `Arc RPC`, `Arc write endpoint`, `xReserve`, `xReserve pause`, `Circle xReserve API`, `USDCx native asset` (probe `usdcx`); `Guardian identity` (`usdcx-guardian`); `USDCx faucet grant` (`grant`); `Gateway minter` and `domainWithdrawalsPaused` in `xReserve pause` (`arc-payout`); `Arc funded key` (`funded-key`).
  - `scripts/e2e-real.fetch-stub.mjs`: `E2E_REAL_FETCH_STUB` = `{ document, log, answers }`; `answers` overrides `ANSWERS` (live testnet values). It also answers the CLI install and the native-asset discovery and logs run()'s children as `SPAWN <json>` (Task 31 (p4-suites) reads those).

Line numbers are origin/main's; Task 29 (p4-args-env) moved most of `scripts/e2e-real.mjs` down by about 70 lines, so apply each edit by its quoted Before text.

- [ ] **Step 1: Rewrite the fetch stub with live defaults and child-process answers**

The stub keeps every answer the existing tests rely on (Sepolia JSON-RPC, the config document, Epoch, the indexer) and fixes the `'globalThis' is not defined` (no-undef) error eslint reports on main by writing `global.fetch`.

Full content of `scripts/e2e-real.fetch-stub.mjs`:
```js
/**
 * Test-only: e2e-real.test.ts preloads this with `node --import`, so a run meets canned answers and never reaches the
 * network, a cargo install, a build or Playwright. E2E_REAL_FETCH_STUB carries `{ document, log, answers }`: the config
 * document to serve as `<network>.json`; a file each request is appended to (`<url>`, `<url> <body>` for any other
 * request with a body, `<url> <method> <params>` for JSON-RPC, `native asset <rpc>` for the native-asset discovery and
 * `SPAWN <json>` for the CLI install and each child run() starts); and overrides of ANSWERS, which hold what live
 * testnet answered, so a usdcx preflight passes on the defaults.
 */
import { EventEmitter } from 'node:events';
import { appendFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const { document, log, answers: overrides = {} } = JSON.parse(process.env.E2E_REAL_FETCH_STUB ?? '{}');

const REMOTE_TOKEN = '0x000000000000000000000000000000004cbdcaffe75f0a317482224dae643600';
const ANSWERS = {
  arcChainId: '0x4cef52',
  // Arc hosts whose every request fails as a network error.
  arcDown: [],
  // `{ <method>: n }`: the first n Arc calls of that method answer HTTP 429 with Retry-After 0.
  rateLimited: {},
  rawTransaction: { code: -32602, message: 'failed to decode signed transaction' },
  registered: true,
  paused: false,
  depositsPaused: false,
  withdrawalsPaused: false,
  remoteToken: REMOTE_TOKEN,
  gatewayMinter: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
  usdcBalance: '10000000',
  circleInfo: {
    sourceDomains: [{ chain: 'Arc', domain: 26, contractAddress: '0x008888878f94c0d87defdf0b07f46b93c1934442' }],
    remoteDomains: [
      { chain: 'Miden', domain: 10007, tokens: [{ remoteToken: 'USDCx', remoteTokenIdentifier: REMOTE_TOKEN }] }
    ]
  },
  faucet: {
    version: 'stub',
    decimals: 6,
    base_amount: 100000000,
    token_amounts: [1, 10, 100],
    balance: 999444411348973
  },
  guardianStatus: { status: 'ok', version: '0.18.0', git_commit: 'fab5f5cb2c3f', environment: 'testnet' },
  guardianPubkey: {
    commitment: '0x6b3e7eda3e144c8f58980385492da4cc1e474a691771704b8f99da441609990f',
    pubkey: '0x02d2190fce12065f8e0d4933cd84687e68a644a5e5d39e497a65b7b1a769f5c11e'
  },
  // `{ error: '<stderr>' }` makes the discovery fail.
  nativeAsset: { id: '0x4cbdcaffe75f0a317482224dae6436', bytes32: REMOTE_TOKEN },
  cliInstall: { status: 0, stdout: 'Installed package `miden-client-cli`\n/stub/cli/bin/miden-client\n' },
  exitCodes: { build: 0, test: 0 }
};
const answers = { ...ANSWERS, ...overrides };

const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const RPC_RESULTS = {
  eth_chainId: '0xaa36a7',
  eth_blockNumber: '0x1',
  eth_getCode: '0x6080',
  eth_getBalance: '0xde0b6b3a7640000',
  eth_call: '0x0'
};

const word = hex => `0x${hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')}`;
const flag = value => word(value ? '1' : '0');
const servedArcCalls = {};

function arcAnswer({ method, params }) {
  switch (method) {
    case 'eth_chainId':
      return { result: answers.arcChainId };
    case 'eth_blockNumber':
      return { result: '0x1' };
    case 'eth_getCode':
      return { result: '0x6080' };
    case 'eth_sendRawTransaction':
      return { error: answers.rawTransaction };
    case 'eth_call': {
      const views = {
        '0xf54a69c3': flag(answers.registered),
        '0x5c975abb': flag(answers.paused),
        '0x4a1b13ea': flag(answers.depositsPaused),
        '0xe9cafc83': flag(answers.withdrawalsPaused),
        '0xb3467549': word(answers.remoteToken),
        '0x0f41efea': word(answers.gatewayMinter),
        '0x70a08231': word(BigInt(answers.usdcBalance).toString(16))
      };
      const selector = params[0].data.slice(0, 10);
      return Object.hasOwn(views, selector) ? { result: views[selector] } : { error: { code: 3, message: 'reverted' } };
    }
    default:
      return { error: { code: -32601, message: `the method ${method} does not exist/is not available` } };
  }
}

const isArc = host => host.endsWith('.arc.io') || host.startsWith('arc-rpc.');

global.fetch = async (input, init = {}) => {
  const url = String(input);
  const call = typeof init.body === 'string' && init.body.includes('"jsonrpc"') ? JSON.parse(init.body) : null;
  const body = typeof init.body === 'string' ? ` ${init.body}` : '';
  appendFileSync(log, call ? `${url} ${call.method} ${JSON.stringify(call.params)}\n` : `${url}${body}\n`);
  const { host } = new URL(url);
  if (call && isArc(host)) {
    if (answers.arcDown.includes(host)) throw new TypeError('fetch failed');
    servedArcCalls[call.method] = (servedArcCalls[call.method] ?? 0) + 1;
    if (servedArcCalls[call.method] <= (answers.rateLimited[call.method] ?? 0)) {
      return new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '0' } });
    }
    return json({ jsonrpc: '2.0', id: call.id, ...arcAnswer(call) });
  }
  if (call) return json({ jsonrpc: '2.0', id: call.id, result: RPC_RESULTS[call.method] });
  if (url.endsWith('.json')) return json(document);
  if (url.endsWith('/health')) return json({ status: 'healthy', allocatorAddresses: { 999999999: '0xa110c' } });
  if (url.endsWith('/checkIfDepositNeeded')) {
    return json({ success: true, path: [[[{}, [{ name: 'stub solver' }], [{}, { token: { amount: '1' } }]]]] });
  }
  if (url.endsWith('/gasless-status')) return json({ enabled: false });
  if (url.endsWith('/get_metadata')) return json(answers.faucet);
  if (url.endsWith('/v1/info')) return json(answers.circleInfo);
  if (url.endsWith('/status')) return json(answers.guardianStatus);
  if (url.endsWith('/pubkey?scheme=ecdsa')) return json(answers.guardianPubkey);
  // Miden exit 0 as the live AggLayer indexer files it.
  if (url.includes('/bridge?')) return json({ deposit: { deposit_cnt: 0, network_id: 73, dest_net: 0 } });
  return new Response('ok');
};

// The CLI install and the native-asset discovery answer from ANSWERS. run()'s children log their command and the
// environment names a usdcx phase sets or unsets, then close. Every other child (the ts-node readers of the config
// document and the faucet grant) runs for real. syncBuiltinESMExports carries the swap into the runner's named imports.
const childProcess = createRequire(import.meta.url)('node:child_process');
const realSpawnSync = childProcess.spawnSync;
const WATCHED_ENV = [
  'E2E_NETWORK',
  'E2E_REAL_USDCX',
  'E2E_REAL_EPOCH',
  'E2E_SEPOLIA_RPC_URL',
  'E2E_SEPOLIA_PRIVATE_KEY',
  'E2E_ARC_RPC_URL',
  'E2E_ARC_PRIVATE_KEY',
  'E2E_HEADLESS',
  'MIDEN_CLIENT_BIN'
];
childProcess.spawnSync = (command, args = [], options = {}) => {
  const line = args.join(' ');
  if (line.includes('install-pinned-miden-cli.cjs')) {
    appendFileSync(log, `SPAWN ${JSON.stringify({ command: 'install-pinned-miden-cli', args })}\n`);
    return { status: answers.cliInstall.status, stdout: answers.cliInstall.stdout, stderr: '' };
  }
  if (line.includes('discoverFeeFaucetId')) {
    appendFileSync(log, `native asset ${args[args.length - 1]}\n`);
    const { error } = answers.nativeAsset;
    return error === undefined
      ? { status: 0, stdout: JSON.stringify(answers.nativeAsset), stderr: '' }
      : { status: 1, stdout: '', stderr: error };
  }
  return realSpawnSync(command, args, options);
};
childProcess.spawn = (command, args = [], options = {}) => {
  const env = options.env ?? {};
  const watched = Object.fromEntries(
    WATCHED_ENV.filter(name => env[name] !== undefined).map(name => [name, env[name]])
  );
  appendFileSync(log, `SPAWN ${JSON.stringify({ command, args, env: watched })}\n`);
  const child = new EventEmitter();
  setImmediate(() => child.emit('close', answers.exitCodes[args[0] === 'playwright' ? 'test' : 'build']));
  return child;
};
syncBuiltinESMExports();
// A swap that did not reach the named exports would let a test start a real build, so it stops the run here.
const linked = await import('node:child_process');
if (linked.spawn !== childProcess.spawn || linked.spawnSync !== childProcess.spawnSync) {
  throw new Error('e2e-real.fetch-stub: the node:child_process named exports kept the real spawn');
}
```

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; yarn jest scripts/e2e-real.test.ts --maxWorkers=2
```
Expected: `Tests:       166 passed, 166 total` (the stub's new defaults change nothing the existing tests read).

- [ ] **Step 2: Write the failing tests**

Before (`scripts/e2e-real.test.ts`, the imports Task 29 (p4-args-env) left):
```ts
import { pathToFileURL } from 'node:url';
import { getAddress } from 'viem';

import {
  AGGLAYER_MIDEN_NETWORK_ID,
  SUITES,
  agglayerExitFilingProblem,
  composeGrep,
  pricedAmountFrom,
  probeAgglayerIndexer,
  probeConfigDocument,
  resolveOperatorInput,
  run,
  suiteRetries
} from './e2e-real.mjs';
```
After:
```ts
import { pathToFileURL } from 'node:url';
import { encodeFunctionData, getAddress, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  AGGLAYER_MIDEN_NETWORK_ID,
  ARC_CIRCLE_DOMAIN,
  ARC_TESTNET_CHAIN_ID,
  ARC_USDC,
  ARC_XRESERVE,
  DEFAULT_ARC_RPCS,
  GATEWAY_MINTER,
  SUITES,
  USDCX_DECIMALS,
  USDCX_FUNDED_KEY_FLOOR_UNITS,
  USDCX_GRANT_FLOOR_UNITS,
  USDCX_REMOTE_DOMAIN,
  XRESERVE_API_TESTNET,
  agglayerExitFilingProblem,
  arcRpc,
  arcRpcEndpoints,
  circleGet,
  composeGrep,
  pricedAmountFrom,
  probeAgglayerIndexer,
  probeConfigDocument,
  resolveOperatorInput,
  run,
  suiteRetries,
  usdcxGrantProblem
} from './e2e-real.mjs';
import * as harness from '../playwright/e2e/helpers/usdcx-constants';
import * as wallet from '../src/lib/usdcx/constant';
import { ARC_TESTNET } from '../src/lib/walletconnect/config';
```

Append to the end of `scripts/e2e-real.test.ts`:
```ts
describe('the bounded rate-limit retry on Arc and Circle calls', () => {
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body)
  });
  const answer = (result: string) => reply(200, { jsonrpc: '2.0', id: 1, result });
  const refusal = (code: number, message: string) => reply(200, { jsonrpc: '2.0', id: 1, error: { code, message } });
  const ARC = 'https://arc-rpc.example';

  it('asks again after 429 and 429, waiting what each Retry-After named up to 10 s, and takes the third answer', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(reply(429, 'Too Many Requests', { 'retry-after': '2' }))
      .mockResolvedValueOnce(reply(429, 'Too Many Requests', { 'retry-after': '30' }))
      .mockResolvedValueOnce(answer('0x4cef52'));
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(arcRpc(ARC, 'eth_chainId', [], { fetchImpl, sleep })).resolves.toBe('0x4cef52');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[2_000], [10_000]]);
  });

  it('asks again after a JSON-RPC -32005, waiting 1 s when nothing names a wait', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(refusal(-32005, 'limit exceeded'))
      .mockResolvedValueOnce(answer('0x1'));
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(arcRpc(ARC, 'eth_blockNumber', [], { fetchImpl, sleep })).resolves.toBe('0x1');
    expect(sleep.mock.calls).toEqual([[1_000]]);
  });

  it('fails a -32012 at once: only a rate limit is asked again', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(refusal(-32012, 'credits exhausted'));
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(arcRpc(ARC, 'eth_call', [], { fetchImpl, sleep })).rejects.toMatchObject({
      code: -32012,
      message: 'eth_call: credits exhausted'
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after the third retry', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(429, 'Too Many Requests', { 'retry-after': '1' }));
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(arcRpc(ARC, 'eth_chainId', [], { fetchImpl, sleep })).rejects.toMatchObject({ status: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('asks Circle again after a 429', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(reply(429, 'slow down'))
      .mockResolvedValueOnce(reply(200, { remoteDomains: [] }));
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(circleGet('https://circle.example/v1/info', { fetchImpl, sleep })).resolves.toMatchObject({
      status: 200,
      body: { remoteDomains: [] }
    });
    expect(sleep.mock.calls).toEqual([[1_000]]);
  });
});

describe('arcRpcEndpoints', () => {
  it("asks drpc, then QuickNode, then arc.io, the wallet's own Arc RPC, last", () => {
    expect(arcRpcEndpoints(undefined)).toEqual([
      'https://rpc.drpc.testnet.arc.io',
      'https://rpc.quicknode.testnet.arc.io',
      'https://rpc.testnet.arc.io'
    ]);
  });

  it('asks an operator endpoint first', () => {
    expect(arcRpcEndpoints('https://arc-rpc.example')).toEqual(['https://arc-rpc.example', ...DEFAULT_ARC_RPCS]);
  });

  it('asks a default the operator named once, first', () => {
    expect(arcRpcEndpoints('https://rpc.testnet.arc.io')).toEqual([
      'https://rpc.testnet.arc.io',
      'https://rpc.drpc.testnet.arc.io',
      'https://rpc.quicknode.testnet.arc.io'
    ]);
  });
});

describe('usdcxGrantProblem', () => {
  // The live testnet faucet's get_metadata, 2026-10-10.
  const LIVE = {
    version: '0.17.1',
    decimals: 6,
    base_amount: 100000000,
    token_amounts: [1, 10, 100],
    balance: 999444411348973
  };

  it('passes the live faucet, whose grant is 100 USDCx', () => {
    expect(usdcxGrantProblem(LIVE, 100_000_000n)).toBeUndefined();
  });

  it('passes a grant of exactly 11 USDCx: a 10 USDCx burn and the 1 USDCx its fees may take', () => {
    expect(usdcxGrantProblem(LIVE, 11_000_000n)).toBeUndefined();
  });

  it('fails a grant below 11 USDCx', () => {
    expect(usdcxGrantProblem(LIVE, 10_999_999n)).toContain('below the 11 USDCx');
  });

  it('fails a faucet that is not on six decimals', () => {
    expect(usdcxGrantProblem({ ...LIVE, decimals: 18 }, 100_000_000n)).toContain("serves 18 decimals, not USDCx's 6");
  });

  it('fails a faucet holding less than one grant', () => {
    expect(usdcxGrantProblem({ ...LIVE, balance: 50_000_000 }, 100_000_000n)).toContain('less than one grant');
  });

  it('fails a faucet that reports no balance', () => {
    const { balance: _dropped, ...unreported } = LIVE;
    expect(usdcxGrantProblem(unreported, 100_000_000n)).toBe('reports no readable balance');
  });
});

// The runner reads no TypeScript at import, so it keeps copies; each must equal what the specs and the wallet use.
// The wallet holds no GatewayMinter and no harness floors, so the harness stands in twice for those rows.
describe('the usdcx constants are the ones the harness and the wallet use', () => {
  it.each([
    ['ARC_TESTNET_CHAIN_ID', ARC_TESTNET_CHAIN_ID, harness.ARC_CHAIN_ID, ARC_TESTNET.id],
    ['ARC_XRESERVE', ARC_XRESERVE, harness.ARC_XRESERVE, wallet.XRESERVE_ADDRESS.get(ARC_TESTNET.id)],
    ['ARC_USDC', ARC_USDC, harness.ARC_USDC, wallet.CIRCLE_USDC_ADDRESS.get(ARC_TESTNET.id)],
    ['ARC_CIRCLE_DOMAIN', ARC_CIRCLE_DOMAIN, harness.ARC_CIRCLE_DOMAIN, wallet.CIRCLE_DOMAIN.get(ARC_TESTNET.id)],
    ['USDCX_REMOTE_DOMAIN', USDCX_REMOTE_DOMAIN, harness.USDCX_REMOTE_DOMAIN, wallet.USDCX_REMOTE_DOMAIN],
    [
      'XRESERVE_API_TESTNET',
      XRESERVE_API_TESTNET,
      harness.ARC_ATTESTATION_API,
      wallet.XRESERVE_ATTESTATION_API_TESTNET
    ],
    ['USDCX_DECIMALS', USDCX_DECIMALS, wallet.USDCX_DECIMALS, wallet.USDCX_DECIMALS],
    ['GATEWAY_MINTER', GATEWAY_MINTER, harness.GATEWAY_MINTER, harness.GATEWAY_MINTER],
    [
      'USDCX_GRANT_FLOOR_UNITS',
      USDCX_GRANT_FLOOR_UNITS,
      harness.BURN_UNITS + harness.GRANT_MARGIN_UNITS,
      harness.BURN_UNITS + harness.GRANT_MARGIN_UNITS
    ],
    [
      'USDCX_FUNDED_KEY_FLOOR_UNITS',
      USDCX_FUNDED_KEY_FLOOR_UNITS,
      harness.DEPOSIT_UNITS + harness.GAS_RESERVE_UNITS,
      harness.DEPOSIT_UNITS + harness.GAS_RESERVE_UNITS
    ]
  ])('%s matches', (_name, runner, harnessValue, walletValue) => {
    expect([harnessValue, walletValue]).toEqual([runner, runner]);
  });

  it('tries the same Arc RPCs in the same order as the harness', () => {
    expect(DEFAULT_ARC_RPCS).toEqual([...harness.DEFAULT_ARC_RPCS]);
  });
});

describe('the usdcx preflight', () => {
  // Any valid secp256k1 scalar: the stub answers every read, so nothing is ever signed or sent.
  const ARC_KEY: `0x${string}` = `0x${'11'.repeat(32)}`;
  const KEYED = { E2E_ARC_PRIVATE_KEY: ARC_KEY };
  const VIEWS = parseAbi([
    'function paused() view returns (bool)',
    'function domainDepositsPaused(uint32) view returns (bool)',
    'function domainWithdrawalsPaused(uint32) view returns (bool)',
    'function getRemoteToken(uint32, address) view returns (bytes32)',
    'function gatewayMinter() view returns (address)',
    'function isRemoteDomainRegistered(uint32) view returns (bool)',
    'function balanceOf(address) view returns (uint256)'
  ]);
  // How the stub logs an eth_call, so the runner's calldata is checked against viem's ABI encoding.
  const call = (to: string, data: string) => `{"to":"${to}","data":"${data}"}`;
  const XRESERVE_CALLS = {
    registered: call(
      ARC_XRESERVE,
      encodeFunctionData({ abi: VIEWS, functionName: 'isRemoteDomainRegistered', args: [10007] })
    ),
    remoteToken: call(
      ARC_XRESERVE,
      encodeFunctionData({
        abi: VIEWS,
        functionName: 'getRemoteToken',
        args: [10007, '0x3600000000000000000000000000000000000000']
      })
    ),
    paused: call(ARC_XRESERVE, encodeFunctionData({ abi: VIEWS, functionName: 'paused' })),
    depositsPaused: call(
      ARC_XRESERVE,
      encodeFunctionData({ abi: VIEWS, functionName: 'domainDepositsPaused', args: [10007] })
    ),
    withdrawalsPaused: call(
      ARC_XRESERVE,
      encodeFunctionData({ abi: VIEWS, functionName: 'domainWithdrawalsPaused', args: [10007] })
    ),
    gatewayMinter: call(ARC_XRESERVE, encodeFunctionData({ abi: VIEWS, functionName: 'gatewayMinter' }))
  };
  const BALANCE_OF = '"data":"0x70a08231';
  const missing = (requests: string, expected: string[]) => expected.filter(request => !requests.includes(request));
  const failedChecks = (output: string) =>
    /✗ preflight failed \(\d+\/\d+\): ([^\n]*)/.exec(output)?.[1].split(', ') ?? [];

  it('asks usdcx every Arc, Circle, Guardian and faucet question, the payout ones included', () => {
    const res = preflight('usdcx');
    expect(res.output).toContain('✓ preflight passed (11 checks)');
    expect(res.status).toBe(0);
    expect(
      missing(res.requests, [
        'https://rpc.drpc.testnet.arc.io eth_chainId []',
        'https://rpc.drpc.testnet.arc.io eth_sendRawTransaction ["0x00"]',
        `eth_getCode ["${ARC_XRESERVE}","latest"]`,
        ...Object.values(XRESERVE_CALLS),
        `eth_getCode ["${GATEWAY_MINTER}","latest"]`,
        `${XRESERVE_API_TESTNET}/v1/info`,
        'https://guardian.openzeppelin.com/status',
        'https://guardian.openzeppelin.com/pubkey?scheme=ecdsa',
        'https://faucet-api.testnet.miden.io/get_metadata',
        'native asset https://rpc.testnet.miden.io'
      ])
    ).toEqual([]);
    expect(res.requests).not.toContain(BALANCE_OF);
    expect(res.requests).not.toContain('SPAWN');
  }, 35_000);

  it('asks usdcx-in for the funded key and no payout question, printing its address and never the key', () => {
    const { address } = privateKeyToAccount(ARC_KEY);
    const res = preflight('usdcx-in', DOCUMENT, KEYED);
    expect(res.output).toContain('✓ preflight passed (10 checks)');
    expect(res.status).toBe(0);
    expect(res.requests).toContain(
      call(ARC_USDC, encodeFunctionData({ abi: VIEWS, functionName: 'balanceOf', args: [address] }))
    );
    expect(res.requests).not.toContain(XRESERVE_CALLS.gatewayMinter);
    expect(res.requests).not.toContain(XRESERVE_CALLS.withdrawalsPaused);
    expect(res.output).toContain(address);
    expect(res.output).not.toContain(ARC_KEY.slice(2));
  }, 35_000);

  it('asks usdcx-burn neither a payout nor a funded-key question', () => {
    const res = preflight('usdcx-burn');
    expect(res.output).toContain('✓ preflight passed (10 checks)');
    expect(res.status).toBe(0);
    expect(res.requests).toContain('https://faucet-api.testnet.miden.io/get_metadata');
    expect(res.requests).not.toContain(XRESERVE_CALLS.gatewayMinter);
    expect(res.requests).not.toContain(XRESERVE_CALLS.withdrawalsPaused);
    expect(res.requests).not.toContain(BALANCE_OF);
  }, 35_000);

  it.each([
    ['Arc RPC', 'usdcx', { arcChainId: '0xaa36a7' }],
    [
      'Arc write endpoint',
      'usdcx',
      { rawTransaction: { code: -32601, message: 'the method eth_sendRawTransaction does not exist/is not available' } }
    ],
    ['xReserve', 'usdcx', { registered: false }],
    ['xReserve pause', 'usdcx', { depositsPaused: true }],
    ['Circle xReserve API', 'usdcx', { circleInfo: { sourceDomains: [], remoteDomains: [] } }],
    ['USDCx native asset', 'usdcx', { nativeAsset: { id: '0x01', bytes32: `0x${'0'.repeat(64)}` } }],
    [
      'Guardian identity',
      'usdcx',
      { guardianStatus: { status: 'ok', version: '0.18.0', git_commit: 'fab5f5cb2c3f', environment: 'devnet' } }
    ],
    // base_amount stays 100 USDCx: the probe judges what the harness asks for, the largest token_amounts entry.
    [
      'USDCx faucet grant',
      'usdcx-burn',
      {
        faucet: {
          version: 'stub',
          decimals: 6,
          base_amount: 100000000,
          token_amounts: [1, 10],
          balance: 999444411348973
        }
      }
    ],
    ['Gateway minter', 'usdcx', { gatewayMinter: `0x${'22'.repeat(20)}` }],
    ['Arc funded key', 'usdcx-in', { usdcBalance: '1049999' }]
  ])(
    'fails %s alone on --suite %s when its answer is wrong',
    (label, suite, answers) => {
      const res = preflight(suite, DOCUMENT, KEYED, answers);
      expect(failedChecks(res.output)).toEqual([label]);
      expect(res.status).toBe(1);
      expect(res.requests).not.toContain('SPAWN');
    },
    35_000
  );

  it.each([
    ['usdcx', ['xReserve pause']],
    ['usdcx-in', []],
    ['usdcx-burn', []]
  ])(
    'on paused withdrawals --suite %s fails %j: only the payout leg withdraws',
    (suite, failed) => {
      const res = preflight(suite, DOCUMENT, KEYED, { withdrawalsPaused: true });
      expect(failedChecks(res.output)).toEqual(failed);
      expect(res.status).toBe(failed.length === 0 ? 0 : 1);
    },
    35_000
  );

  it('passes with drpc down, asking QuickNode everything after the chain checks', () => {
    const res = preflight('usdcx', DOCUMENT, {}, { arcDown: ['rpc.drpc.testnet.arc.io'] });
    expect(res.status).toBe(0);
    expect(res.requests).toContain('https://rpc.quicknode.testnet.arc.io eth_sendRawTransaction ["0x00"]');
    expect(res.requests).not.toContain('https://rpc.drpc.testnet.arc.io eth_sendRawTransaction');
  }, 35_000);

  it('asks a rate-limited endpoint again: 429, 429, then the answer', () => {
    const res = preflight('usdcx', DOCUMENT, {}, { rateLimited: { eth_chainId: 2 } });
    const asked = res.requests.split('\n').filter(line => line === 'https://rpc.drpc.testnet.arc.io eth_chainId []');
    expect(asked).toHaveLength(3);
    expect(res.status).toBe(0);
  }, 35_000);

  it('tries --arc-rpc first and never prints its path', () => {
    const res = stubbed(
      ['--suite', 'usdcx', '--arc-rpc', 'https://arc-rpc.example/secret-token', '--preflight-only'],
      DOCUMENT
    );
    const arcCalls = res.requests.split('\n').filter(line => line.includes(' eth_'));
    expect(arcCalls[0]).toBe('https://arc-rpc.example/secret-token eth_chainId []');
    expect(res.requests).toContain('https://arc-rpc.example/secret-token eth_sendRawTransaction ["0x00"]');
    expect(res.output).toContain(
      'Arc RPC  arc-rpc.example, rpc.drpc.testnet.arc.io, rpc.quicknode.testnet.arc.io, rpc.testnet.arc.io'
    );
    expect(res.output).not.toContain('secret-token');
    expect(res.status).toBe(0);
  }, 35_000);

  // run() unsets it for every usdcx child but usdcx-in's test, so nothing on usdcx reads it.
  it('lets usdcx run with a malformed E2E_ARC_PRIVATE_KEY exported', () => {
    const res = preflight('usdcx', DOCUMENT, { E2E_ARC_PRIVATE_KEY: '0x01' });
    expect(res.status).toBe(0);
  }, 35_000);
});
```

- [ ] **Step 3: Run the new tests and watch them fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; yarn jest scripts/e2e-real.test.ts --maxWorkers=2
```
Expected: `Tests:       42 failed, 169 passed, 211 total`. The 166 tests of Task 29 (p4-args-env) pass, and so do three new guards that hold before and after: `lets usdcx run with a malformed E2E_ARC_PRIVATE_KEY exported` and the usdcx-in and usdcx-burn cases of `on paused withdrawals ...`. Every other new test fails:
- `the bounded rate-limit retry ...`, `arcRpcEndpoints`, `usdcxGrantProblem`: `TypeError: (0 , _e2ereal.arcRpc) is not a function` (and likewise `circleGet`, `arcRpcEndpoints`, `usdcxGrantProblem`).
- `the usdcx constants ... %s matches`: `expect(received).toEqual(expected)` with `Expected: [undefined, undefined]` against `Received: [5042002, 5042002]` (and so on per row); `tries the same Arc RPCs ...` with `Received: undefined`.
- `asks usdcx every ...`: `Expected substring: "✓ preflight passed (11 checks)"` against `✓ preflight passed (2 checks)`; the usdcx-in and usdcx-burn cases likewise against `(2 checks)`.
- `fails %s alone on --suite %s ...`: `Expected: ["Arc RPC"]`, `Received: []`.
- `on paused withdrawals --suite usdcx fails ["xReserve pause"]`: `Received: []`.
- `passes with drpc down ...`, `asks a rate-limited endpoint again ...`, `tries --arc-rpc first ...`: the requests hold only the Miden RPC and faucet lines, no Arc call (`Received length: 0`, `Received: undefined`).

- [ ] **Step 4: Implement the probes**

Before (`scripts/e2e-real.mjs`:59-64):
```js
const MIDEN_FAUCET_API = {
  testnet: 'https://faucet-api.testnet.miden.io',
  devnet: 'https://faucet-api.devnet.miden.io'
};

export const SUITES = {
```
After:
```js
const MIDEN_FAUCET_API = {
  testnet: 'https://faucet-api.testnet.miden.io',
  devnet: 'https://faucet-api.devnet.miden.io'
};

/**
 * Arc Testnet and Circle's xReserve as the usdcx suites use them. The runner reads no TypeScript at import time, so
 * these copy src/lib/usdcx/constant.ts and playwright/e2e/helpers/usdcx-constants.ts; e2e-real.test.ts pins each copy
 * to both.
 */
export const ARC_TESTNET_CHAIN_ID = 5042002;
export const ARC_XRESERVE = '0x008888878f94C0d87defdf0B07f46B93C1934442';
export const ARC_USDC = '0x3600000000000000000000000000000000000000';
export const ARC_CIRCLE_DOMAIN = 26;
export const USDCX_REMOTE_DOMAIN = 10007;
export const USDCX_DECIMALS = 6;
export const XRESERVE_API_TESTNET = 'https://xreserve-api-testnet.circle.com';
/** Emits the AttestationUsed log the round trip's payout gate reads. */
export const GATEWAY_MINTER = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B';
/** arc.io last: it is the wallet's own Arc RPC (the burn snapshot and the payout confirmation), so the harness spares it. */
export const DEFAULT_ARC_RPCS = [
  'https://rpc.drpc.testnet.arc.io',
  'https://rpc.quicknode.testnet.arc.io',
  'https://rpc.testnet.arc.io'
];
/** A 10 USDCx burn plus the 1 USDCx its fees may take: BURN_UNITS + GRANT_MARGIN_UNITS. */
export const USDCX_GRANT_FLOOR_UNITS = 11_000_000n;
/** One 1 USDC deposit plus its Arc gas: DEPOSIT_UNITS + GAS_RESERVE_UNITS. */
export const USDCX_FUNDED_KEY_FLOOR_UNITS = 1_050_000n;
const ARC_SELECTORS = {
  paused: '0x5c975abb',
  domainDepositsPaused: '0x4a1b13ea',
  domainWithdrawalsPaused: '0xe9cafc83',
  getRemoteToken: '0xb3467549',
  gatewayMinter: '0x0f41efea',
  isRemoteDomainRegistered: '0xf54a69c3',
  balanceOf: '0x70a08231'
};

export const SUITES = {
```

Before (`scripts/e2e-real.mjs`:336-363):
```js
async function getJson(url, init = {}, timeoutMs = 20_000) {
  const res = await fetch(url, {
    ...init,
    headers: { 'user-agent': UA, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 200);
  }
  return { status: res.status, body };
}

async function rpc(url, method, params, timeoutMs = 20_000) {
  const { status, body } = await getJson(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    },
    timeoutMs
  );
  if (status !== 200) throw new Error(`${method}: HTTP ${status}`);
  if (body?.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
```
After:
```js
async function getJson(url, init = {}, timeoutMs = 20_000, fetchImpl = fetch) {
  const res = await fetchImpl(url, {
    ...init,
    headers: { 'user-agent': UA, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 200);
  }
  return { status: res.status, body, headers: res.headers };
}

/** Retry-After in milliseconds when it is a whole number of seconds; a date, or none, is undefined. */
function retryAfterMs(headers) {
  const value = headers?.get?.('retry-after')?.trim();
  return value !== undefined && /^\d+$/.test(value) ? Number(value) * 1_000 : undefined;
}

async function rpc(url, method, params, { timeoutMs = 20_000, fetchImpl } = {}) {
  const { status, body, headers } = await getJson(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    },
    timeoutMs,
    fetchImpl
  );
  // The status, the JSON-RPC code and Retry-After ride on the error, so withRateLimitRetry can tell a rate limit
  // from a refusal.
  if (status !== 200) {
    throw Object.assign(new Error(`${method}: HTTP ${status}`), { status, retryAfterMs: retryAfterMs(headers) });
  }
  if (body?.error) {
    throw Object.assign(new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`), {
      code: body.error.code
    });
  }
```

Before (`scripts/e2e-real.mjs`:368-374):
```js
  if (body === null || typeof body !== 'object' || !('result' in body)) {
    throw new Error(`${method}: reply carried no result`);
  }
  return body.result;
}

// ── config document ─────────────────────────────────────────────────────────
```
After:
```js
  if (body === null || typeof body !== 'object' || !('result' in body)) {
    throw new Error(`${method}: reply carried no result`);
  }
  return body.result;
}

const RATE_LIMIT_RETRIES = 3;
const RETRY_AFTER_CAP_MS = 10_000;
const sleepFor = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * `call`, asked again at most three times when it fails on a rate limit (HTTP 429 or JSON-RPC -32005), each time
 * after the wait the limit named, capped at 10 s, else 1 s. arc.io and Circle answer intermittent 429s a preflight
 * must not read as an outage; any other failure is thrown at once, so a real refusal costs no wait.
 */
async function withRateLimitRetry(call, { sleep = sleepFor } = {}) {
  for (let retry = 0; ; retry++) {
    try {
      return await call();
    } catch (err) {
      const limited = err?.status === 429 || err?.code === -32005;
      if (!limited || retry >= RATE_LIMIT_RETRIES) throw err;
      await sleep(Math.min(err.retryAfterMs ?? 1_000, RETRY_AFTER_CAP_MS));
    }
  }
}

/** One Arc JSON-RPC call through the bounded rate-limit retry. Exported for test. */
export function arcRpc(url, method, params, deps = {}) {
  return withRateLimitRetry(() => rpc(url, method, params, deps), deps);
}

/** A Circle GET through the bounded rate-limit retry; a 429 is thrown so the retry sees it. Exported for test. */
export function circleGet(url, deps = {}) {
  return withRateLimitRetry(async () => {
    const reply = await getJson(url, {}, 20_000, deps.fetchImpl);
    if (reply.status === 429) {
      throw Object.assign(new Error(`${url} answered HTTP 429`), {
        status: 429,
        retryAfterMs: retryAfterMs(reply.headers)
      });
    }
    return reply;
  }, deps);
}

// ── config document ─────────────────────────────────────────────────────────
```

Before (`scripts/e2e-real.mjs`:409-431):
```js
/**
 * The document as the wallet's own parser reads it (src/lib/remote-config/schema.ts), or null where the wallet refuses
 * it, so the preflight never judges a document by rules of its own. The parser is TypeScript, so a child process runs
 * it through ts-node, transpiling only.
 */
function parseLikeTheWallet(body, network, allowLocalHttp) {
  const res = spawnSync(process.execPath, ['-r', 'ts-node/register', '-e', PARSE_SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input: JSON.stringify({ body, network, allowLocalHttp }),
    env: {
      ...process.env,
      NODE_PATH: 'src',
      TS_NODE_TRANSPILE_ONLY: '1',
      TS_NODE_COMPILER_OPTIONS: '{"module":"commonjs","moduleResolution":"node"}'
    },
    timeout: 60_000
  });
  if (res.status !== 0) {
    throw new Error(`could not be parsed: ${res.error?.message ?? res.stderr.trim().split('\n')[0]}`);
  }
  return JSON.parse(res.stdout);
}
```
After:
```js
/**
 * Run `script` in a child under ts-node, transpiling only, so the preflight reads the TypeScript the wallet and the
 * harness ship rather than a copy kept here. Returns its stdout; throws with the first line it wrote to stderr.
 */
function tsNodeChild(script, { input, args = [], timeoutMs = 60_000 } = {}) {
  const res = spawnSync(process.execPath, ['-r', 'ts-node/register', '-e', script, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      NODE_PATH: 'src',
      TS_NODE_TRANSPILE_ONLY: '1',
      TS_NODE_COMPILER_OPTIONS: '{"module":"commonjs","moduleResolution":"node"}'
    },
    timeout: timeoutMs
  });
  if (res.status !== 0) throw new Error(res.error?.message ?? res.stderr.trim().split('\n')[0]);
  return res.stdout;
}

/**
 * The document as the wallet's own parser reads it (src/lib/remote-config/schema.ts), or null where the wallet refuses
 * it, so the preflight never judges a document by rules of its own.
 */
function parseLikeTheWallet(body, network, allowLocalHttp) {
  let stdout;
  try {
    stdout = tsNodeChild(PARSE_SCRIPT, { input: JSON.stringify({ body, network, allowLocalHttp }) });
  } catch (err) {
    throw new Error(`could not be parsed: ${err.message}`);
  }
  return JSON.parse(stdout);
}
```

Before (`scripts/e2e-real.mjs`:513-525):
```js
async function probeMidenFaucet(network) {
  const base = MIDEN_FAUCET_API[network];
  if (!base) return record(false, 'Miden faucet API', `no endpoint known for network "${network}"`);
  try {
    const { status, body } = await getJson(`${base}/get_metadata`);
    if (status !== 200) return record(false, 'Miden faucet API', `${base} answered HTTP ${status}`);
    // Every fresh E2E account needs a native-MIDEN grant before its first fee-charged
    // transaction, so a dead faucet fails the run at funding, not at the assertion.
    return record(true, 'Miden faucet API', `node ${body.version}, base_amount ${body.base_amount}`);
  } catch (err) {
    return record(false, 'Miden faucet API', `${base} unreachable: ${err.message}`);
  }
}
```
After:
```js
async function probeMidenFaucet(network, { grant = false } = {}) {
  const base = MIDEN_FAUCET_API[network];
  if (!base) return record(false, 'Miden faucet API', `no endpoint known for network "${network}"`);
  let metadata;
  try {
    const { status, body } = await getJson(`${base}/get_metadata`);
    if (status !== 200) return record(false, 'Miden faucet API', `${base} answered HTTP ${status}`);
    metadata = body;
  } catch (err) {
    return record(false, 'Miden faucet API', `${base} unreachable: ${err.message}`);
  }
  // Every fresh E2E account takes a grant of the chain's native asset (USDCx on testnet) before its first
  // fee-charged transaction, so a dead faucet fails the run at funding, not at the assertion.
  record(true, 'Miden faucet API', `node ${metadata.version}, base_amount ${metadata.base_amount}`);
  return grant ? probeUsdcxGrant(metadata) : true;
}
```

Before (`scripts/e2e-real.mjs`:729-737):
```js
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) });
    return record(res.status < 500, 'Guardian', `${url} answered HTTP ${res.status}`);
  } catch (err) {
    return record(false, 'Guardian', `${url} unreachable: ${err.message}`);
  }
}

async function probeSepolia(sepoliaRpc) {
```
After:
```js
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) });
    return record(res.status < 500, 'Guardian', `${url} answered HTTP ${res.status}`);
  } catch (err) {
    return record(false, 'Guardian', `${url} unreachable: ${err.message}`);
  }
}

// ── usdcx ───────────────────────────────────────────────────────────────────

const endpointHost = url => new URL(url).host;

/** The Arc RPCs a usdcx spec reads and writes through, in order, an operator's first. Exported for test. */
export function arcRpcEndpoints(override) {
  return override ? [override, ...DEFAULT_ARC_RPCS.filter(url => url !== override)] : [...DEFAULT_ARC_RPCS];
}

/** Calldata of `selector` over static arguments: a number as a uint, a 0x address, each left-padded to a word. */
function calldata(selector, ...args) {
  const words = args.map(arg => (typeof arg === 'number' ? arg.toString(16) : arg.slice(2).toLowerCase()));
  return selector + words.map(word => word.padStart(64, '0')).join('');
}

/** The one word an Arc view returns, lowercase. A revert's `0x` or a short answer throws, naming the view. */
async function arcView(url, to, data, name) {
  const word = await arcRpc(url, 'eth_call', [{ to, data }, 'latest']);
  if (typeof word !== 'string' || !/^0x[0-9a-f]{64}$/i.test(word)) {
    throw new Error(`${name} answered ${String(word).slice(0, 20)}, not one word`);
  }
  return word.toLowerCase();
}

const codeBytes = code => Math.max(0, (String(code).length - 2) / 2);

/**
 * Every Arc RPC a spec may use, by chain id and head. The specs fail over between them, so one healthy endpoint
 * passes; the first is returned, and every later Arc probe asks it alone, as one spec read cycle does.
 */
async function probeArcRpc(endpoints) {
  const states = [];
  let healthy;
  for (const url of endpoints) {
    const host = endpointHost(url);
    try {
      const chainId = Number(await arcRpc(url, 'eth_chainId', []));
      if (chainId !== ARC_TESTNET_CHAIN_ID) {
        states.push(`${host} reports chain ${chainId}`);
        continue;
      }
      states.push(`${host} #${Number(await arcRpc(url, 'eth_blockNumber', []))}`);
      if (healthy === undefined) healthy = url;
    } catch (err) {
      states.push(`${host} ${err.message}`);
    }
  }
  const detail =
    healthy === undefined
      ? `no endpoint serves chain ${ARC_TESTNET_CHAIN_ID}: ${states.join('; ')}`
      : states.join('; ');
  record(healthy !== undefined, 'Arc RPC', detail);
  return healthy;
}

/**
 * The deposit leg signs through the first healthy endpoint. An empty raw transaction costs nothing and tells an
 * endpoint that would relay a real one (it fails to decode `0x00`) from one that refuses the method or the plan,
 * which no read can show.
 */
async function probeArcWriteEndpoint(url) {
  const host = endpointHost(url);
  try {
    await arcRpc(url, 'eth_sendRawTransaction', ['0x00']);
    return record(false, 'Arc write endpoint', `${host} accepted an empty raw transaction`);
  } catch (err) {
    if (err.code !== undefined && /decod/i.test(err.message)) {
      return record(true, 'Arc write endpoint', `${host} takes raw transactions (it failed to decode 0x00)`);
    }
    return record(false, 'Arc write endpoint', `${host} refused eth_sendRawTransaction: ${err.message}`);
  }
}

/** The remote token xReserve names for USDCx, lowercase, or undefined after recording why there is none. */
async function probeXReserve(url) {
  const fail = detail => {
    record(false, 'xReserve', detail);
    return undefined;
  };
  try {
    if (codeBytes(await arcRpc(url, 'eth_getCode', [ARC_XRESERVE, 'latest'])) === 0) {
      return fail(`${ARC_XRESERVE} has no code on Arc Testnet`);
    }
    const registeredData = calldata(ARC_SELECTORS.isRemoteDomainRegistered, USDCX_REMOTE_DOMAIN);
    if (BigInt(await arcView(url, ARC_XRESERVE, registeredData, 'isRemoteDomainRegistered')) !== 1n) {
      return fail(`domain ${USDCX_REMOTE_DOMAIN} is not registered`);
    }
    const tokenData = calldata(ARC_SELECTORS.getRemoteToken, USDCX_REMOTE_DOMAIN, ARC_USDC);
    const remoteToken = await arcView(url, ARC_XRESERVE, tokenData, 'getRemoteToken');
    if (BigInt(remoteToken) === 0n) return fail(`getRemoteToken(${USDCX_REMOTE_DOMAIN}, USDC) is zero`);
    record(
      true,
      'xReserve',
      `domain ${USDCX_REMOTE_DOMAIN} registered at ${ARC_XRESERVE}, remote token ${remoteToken}`
    );
    return remoteToken;
  } catch (err) {
    return fail(`${endpointHost(url)}: ${err.message}`);
  }
}

async function probeXReservePause(url, withWithdrawals) {
  const views = [
    ['paused', calldata(ARC_SELECTORS.paused)],
    ['domainDepositsPaused', calldata(ARC_SELECTORS.domainDepositsPaused, USDCX_REMOTE_DOMAIN)],
    ...(withWithdrawals
      ? [['domainWithdrawalsPaused', calldata(ARC_SELECTORS.domainWithdrawalsPaused, USDCX_REMOTE_DOMAIN)]]
      : [])
  ];
  try {
    const set = [];
    for (const [name, data] of views) {
      if (BigInt(await arcView(url, ARC_XRESERVE, data, name)) !== 0n) set.push(name);
    }
    const names = views.map(([name]) => name).join(', ');
    return record(set.length === 0, 'xReserve pause', set.length === 0 ? `${names} false` : `${set.join(', ')} true`);
  } catch (err) {
    return record(false, 'xReserve pause', `${endpointHost(url)}: ${err.message}`);
  }
}

async function probeGatewayMinter(url) {
  try {
    const word = await arcView(url, ARC_XRESERVE, calldata(ARC_SELECTORS.gatewayMinter), 'gatewayMinter');
    const minter = `0x${word.slice(26)}`;
    if (minter !== GATEWAY_MINTER.toLowerCase()) {
      return record(false, 'Gateway minter', `xReserve names ${minter}, not ${GATEWAY_MINTER}`);
    }
    if (codeBytes(await arcRpc(url, 'eth_getCode', [GATEWAY_MINTER, 'latest'])) === 0) {
      return record(false, 'Gateway minter', `${GATEWAY_MINTER} has no code`);
    }
    return record(true, 'Gateway minter', `${GATEWAY_MINTER}, the emitter of the payout's AttestationUsed log`);
  } catch (err) {
    return record(false, 'Gateway minter', `${endpointHost(url)}: ${err.message}`);
  }
}

/** usdcx-in deposits from this key, so it must hold one deposit and its gas. Only the address is printed. */
async function probeArcFundedKey(url, privateKey) {
  let address;
  try {
    const { privateKeyToAccount } = await import('viem/accounts');
    ({ address } = privateKeyToAccount(`0x${privateKey.replace(/^0x/i, '')}`));
  } catch {
    return record(false, 'Arc funded key', 'not a valid private key (expect 32 bytes hex)');
  }
  try {
    const word = await arcView(url, ARC_USDC, calldata(ARC_SELECTORS.balanceOf, address), 'balanceOf');
    const balance = BigInt(word);
    const held = `${address} holds ${formatUnits(balance, USDCX_DECIMALS)} USDC`;
    if (balance < USDCX_FUNDED_KEY_FLOOR_UNITS) {
      const floor = formatUnits(USDCX_FUNDED_KEY_FLOOR_UNITS, USDCX_DECIMALS);
      return record(false, 'Arc funded key', `${held}, below the ${floor} USDC one deposit and its gas need`);
    }
    return record(true, 'Arc funded key', held);
  } catch (err) {
    return record(false, 'Arc funded key', `could not read ${address}: ${err.message}`);
  }
}

/** Circle must attest deposits to Miden at the token xReserve names, from Arc's xReserve. */
async function probeCircleXReserveApi(remoteToken) {
  const url = `${XRESERVE_API_TESTNET}/v1/info`;
  try {
    const { status, body } = await circleGet(url);
    if (status !== 200) return record(false, 'Circle xReserve API', `${url} answered HTTP ${status}`);
    const remote = body?.remoteDomains?.find(domain => domain?.domain === USDCX_REMOTE_DOMAIN);
    const listed = (remote?.tokens ?? []).map(token => String(token?.remoteTokenIdentifier).toLowerCase());
    if (!listed.includes(remoteToken)) {
      const found = remote ? `domain ${USDCX_REMOTE_DOMAIN} with ${listed.join(', ') || 'no token'}` : 'no domain';
      return record(false, 'Circle xReserve API', `lists ${found}, not ${USDCX_REMOTE_DOMAIN} at ${remoteToken}`);
    }
    const source = body?.sourceDomains?.find(domain => domain?.domain === ARC_CIRCLE_DOMAIN);
    if (String(source?.contractAddress).toLowerCase() !== ARC_XRESERVE.toLowerCase()) {
      const at = source?.contractAddress ?? 'nothing';
      return record(false, 'Circle xReserve API', `names source ${ARC_CIRCLE_DOMAIN} at ${at}, not ${ARC_XRESERVE}`);
    }
    return record(
      true,
      'Circle xReserve API',
      `attests ${USDCX_REMOTE_DOMAIN} at the on-chain remote token, source ${ARC_CIRCLE_DOMAIN} at ${ARC_XRESERVE}`
    );
  } catch (err) {
    return record(false, 'Circle xReserve API', `${url} unreachable: ${err.message}`);
  }
}

// Discovers the node's native asset as the harness does, and encodes it as xReserve's remote token.
const NATIVE_ASSET_SCRIPT = `
const { discoverFeeFaucetId } = require('./playwright/e2e/helpers/fee-faucet.ts');
const { midenAccountHexToXReserveRecipient } = require('./src/lib/usdcx/recipient.ts');
discoverFeeFaucetId(process.argv[1]).then(
  id => process.stdout.write(JSON.stringify({ id, bytes32: midenAccountHexToXReserveRecipient(id) })),
  error => {
    process.stderr.write(error.message);
    process.exitCode = 1;
  }
);
`;

/** A grant pays the wallet's fees only when the faucet xReserve mints for is the chain's native asset. */
async function probeUsdcxNativeAsset(network, remoteToken) {
  try {
    const stdout = tsNodeChild(NATIVE_ASSET_SCRIPT, { args: [MIDEN_RPC[network]], timeoutMs: 90_000 });
    const { id, bytes32 } = JSON.parse(stdout);
    if (String(bytes32).toLowerCase() !== remoteToken) {
      return record(false, 'USDCx native asset', `${id} encodes as ${bytes32}, not the remote token ${remoteToken}`);
    }
    return record(true, 'USDCx native asset', `${id}, the remote token xReserve mints`);
  } catch (err) {
    return record(false, 'USDCx native asset', `not discovered: ${err.message}`);
  }
}

/**
 * The hosted Guardian a usdcx spec co-signs with, as the spec records it: `/status` ok for --network, and the ECDSA
 * commitment the spec checks the account's auth against. GUARDIAN_URL is refused for these suites, so the table
 * alone names it.
 */
async function probeUsdcxGuardian(network) {
  const url = GUARDIAN_URL[network];
  try {
    const status = await getJson(`${url}/status`);
    if (status.status !== 200 || status.body?.status !== 'ok') {
      const reported = status.body?.status ?? 'none';
      return record(false, 'Guardian identity', `${url}/status answered HTTP ${status.status}, status ${reported}`);
    }
    if (status.body.environment !== network) {
      return record(false, 'Guardian identity', `${url} serves ${status.body.environment}, not ${network}`);
    }
    const key = await getJson(`${url}/pubkey?scheme=ecdsa`);
    const commitment = String(key.body?.commitment);
    if (
      key.status !== 200 ||
      !/^0x[0-9a-f]{64}$/i.test(commitment) ||
      !/^0x[0-9a-f]+$/i.test(String(key.body?.pubkey))
    ) {
      return record(false, 'Guardian identity', `${url}/pubkey?scheme=ecdsa carried no ECDSA commitment and pubkey`);
    }
    const { version, git_commit: gitCommit } = status.body;
    return record(true, 'Guardian identity', `${url} ${version} (${gitCommit}), ECDSA commitment ${commitment}`);
  } catch (err) {
    return record(false, 'Guardian identity', `${url} unreachable: ${err.message}`);
  }
}

// What the harness's mintFromPublicFaucet asks for, from the metadata on stdin.
const GRANT_SCRIPT = `
const { faucetGrantAmount } = require('./src/lib/miden-chain/faucet-protocol.ts');
let input = '';
process.stdin.on('data', chunk => (input += chunk));
process.stdin.on('end', () => {
  try {
    process.stdout.write(String(faucetGrantAmount(JSON.parse(input))));
  } catch (error) {
    process.stderr.write(error.message);
    process.exitCode = 1;
  }
});
`;

/**
 * Why the public faucet cannot fund a usdcx run, or undefined. `grantAmount` is what the harness asks for: the
 * largest `token_amounts` entry when the faucet lists any, which is not `base_amount`.
 *
 * Exported for test.
 */
export function usdcxGrantProblem(metadata, grantAmount) {
  const usdcx = units => formatUnits(units, USDCX_DECIMALS);
  if (metadata?.decimals !== USDCX_DECIMALS) {
    return `serves ${metadata?.decimals} decimals, not USDCx's ${USDCX_DECIMALS}`;
  }
  if (grantAmount < USDCX_GRANT_FLOOR_UNITS) {
    return `grants ${usdcx(grantAmount)} USDCx, below the ${usdcx(USDCX_GRANT_FLOOR_UNITS)} USDCx a 10 USDCx burn and its fees need`;
  }
  let balance;
  try {
    balance = BigInt(metadata.balance);
  } catch {
    return 'reports no readable balance';
  }
  if (balance < grantAmount) return `holds ${usdcx(balance)} USDCx, less than one grant of ${usdcx(grantAmount)}`;
  return undefined;
}

function probeUsdcxGrant(metadata) {
  let amount;
  try {
    amount = BigInt(tsNodeChild(GRANT_SCRIPT, { input: JSON.stringify(metadata) }).trim());
  } catch (err) {
    return record(false, 'USDCx faucet grant', `could not read the grant amount: ${err.message}`);
  }
  const problem = usdcxGrantProblem(metadata, amount);
  const held = problem ?? `grants ${formatUnits(amount, USDCX_DECIMALS)} USDCx`;
  return record(problem === undefined, 'USDCx faucet grant', held);
}

/**
 * The Arc, Circle and Miden facts a usdcx run depends on, read as its specs read them. Nothing on Arc can be checked
 * without a healthy endpoint, and the Circle and native-asset checks compare with the remote token xReserve names on
 * chain, so each stage needs the one before it.
 */
async function probeUsdcx(opts, needs) {
  const endpoint = await probeArcRpc(arcRpcEndpoints(opts.arcRpc));
  if (endpoint === undefined) return;
  await probeArcWriteEndpoint(endpoint);
  const remoteToken = await probeXReserve(endpoint);
  await probeXReservePause(endpoint, needs.includes('arc-payout'));
  if (needs.includes('arc-payout')) await probeGatewayMinter(endpoint);
  if (needs.includes('funded-key')) await probeArcFundedKey(endpoint, opts.arcKey);
  if (remoteToken === undefined) return;
  await probeCircleXReserveApi(remoteToken);
  await probeUsdcxNativeAsset(opts.network, remoteToken);
}

async function probeSepolia(sepoliaRpc) {
```
(spike-dependent: deposit-back leg. The write probe judges the first healthy endpoint because p3's `submitDepositToMiden` writes through it; if the spike moves the write to another endpoint, the probe follows.)

Before (`scripts/e2e-real.mjs`:953-961):
```js
  if (needs.includes('sepolia')) console.log(`Sepolia  ${opts.sepoliaRpc}`);
  console.log('');
  console.log('Preflight');

  // The Miden chain and its faucet are common to every suite: the faucet grant is
  // what pays fees for each fresh account, so a dead faucet fails the run at
  // funding rather than at the assertion.
  await probeMidenNode(opts.network);
  await probeMidenFaucet(opts.network);
```
After:
```js
  if (needs.includes('sepolia')) console.log(`Sepolia  ${opts.sepoliaRpc}`);
  // Hosts only: an operator's endpoint may carry its API key in the path.
  if (needs.includes('usdcx')) console.log(`Arc RPC  ${arcRpcEndpoints(opts.arcRpc).map(endpointHost).join(', ')}`);
  console.log('');
  console.log('Preflight');

  // The Miden chain and its faucet are common to every suite: the faucet grant is
  // what pays fees for each fresh account, so a dead faucet fails the run at
  // funding rather than at the assertion.
  await probeMidenNode(opts.network);
  await probeMidenFaucet(opts.network, { grant: needs.includes('grant') });
```

Before (`scripts/e2e-real.mjs`:981):
```js
  if (needs.includes('guardian')) await probeGuardian(opts.network);
```
After:
```js
  if (needs.includes('guardian')) await probeGuardian(opts.network);
  if (needs.includes('usdcx-guardian')) await probeUsdcxGuardian(opts.network);
  if (needs.includes('usdcx')) await probeUsdcx(opts, needs);
```

- [ ] **Step 5: Run the file and see it pass**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; yarn jest scripts/e2e-real.test.ts --maxWorkers=2
```
Expected: `Tests:       211 passed, 211 total` (45 new).

- [ ] **Step 6: Format and lint the three files**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
npx prettier --write scripts/e2e-real.mjs scripts/e2e-real.test.ts scripts/e2e-real.fetch-stub.mjs
npx eslint --max-warnings 0 scripts/e2e-real.mjs scripts/e2e-real.test.ts scripts/e2e-real.fetch-stub.mjs
```
Expected: eslint exits 0 (on origin/main the stub's `globalThis` was a no-undef error; Step 1 writes `global.fetch`).

- [ ] **Step 7: Commit deferred to Task 31 (p4-suites).**

Mutation notes (revert one implementation line, the named test fails):
- `asks again after 429 and 429, ...`: drop `Math.min(..., RETRY_AFTER_CAP_MS)`; the sleeps are `[[2000], [30000]]`.
- `asks again after a JSON-RPC -32005, ...`: drop `|| err?.code === -32005`; the call rejects with `limit exceeded`.
- `fails a -32012 at once: ...`: make `limited` true for every error; fetch is called 4 times.
- `gives up after the third retry`: change `retry >= RATE_LIMIT_RETRIES` to `retry > RATE_LIMIT_RETRIES`; fetch is called 5 times.
- `asks Circle again after a 429`: drop the 429 throw in circleGet; it resolves `{ status: 429 }`.
- `arcRpcEndpoints` cases: drop the `filter(url => url !== override)`; the third case lists arc.io twice. Return `DEFAULT_ARC_RPCS` itself and the second case still passes, so the spread copy has no test of its own (it only guards callers from mutating the export).
- `usdcxGrantProblem` cases: each branch, removed or with `<` turned into `<=` at the floor, fails its own case (`exactly 11 USDCx` catches `<=`).
- `the usdcx constants ... %s matches` and `tries the same Arc RPCs ...`: change any copied constant by one character; its row fails.
- `asks usdcx every ...`: drop any probe call in probeUsdcx or main (the check count leaves 11, or a request goes missing); pad a word to 62 instead of 64 and the viem-encoded calldata is missing.
- `asks usdcx-in for the funded key ...`: drop the `funded-key` branch (count 9, no balanceOf); print `privateKey` in the record and `not.toContain(ARC_KEY.slice(2))` fails.
- `asks usdcx-burn neither ...`: drop the `arc-payout` guard on probeGatewayMinter; the gatewayMinter call appears.
- `fails %s alone ...`: invert or drop the failing condition of that probe (for example `!== 1n` in probeXReserve, `/decod/i` in the write probe, `environment !== network`, `listed.includes`, the bytes32 comparison, `minter !==`, `balance <`); the probe passes and `failedChecks` is `[]`. Reading `base_amount` instead of `faucetGrantAmount` lets the grant case pass.
- `on paused withdrawals ...`: pass `true` for `withWithdrawals` on every suite; usdcx-in and usdcx-burn fail `xReserve pause`.
- `passes with drpc down, ...`: return from probeArcRpc on the first failed endpoint; `Arc RPC` fails.
- `asks a rate-limited endpoint again: ...`: call `rpc` instead of `arcRpc` in probeArcRpc; drpc is asked once and QuickNode serves the run.
- `tries --arc-rpc first ...`: ignore `opts.arcRpc` in probeUsdcx; the first Arc call goes to drpc. Print `opts.arcRpc` in the banner and `secret-token` shows.
- `lets usdcx run with a malformed E2E_ARC_PRIVATE_KEY exported`: a guard; moving the key checks above `if (!suite.arcKey)` in usdcxInputProblem refuses it.

---

### Task 31: Per-phase child env, the pinned CLI before the build, headless by default, USAGE (p4-suites)

**Files:**
- Modify: `scripts/e2e-real.mjs`
- Modify: `scripts/e2e-real.test.ts`
- Commit: `scripts/e2e-real.mjs`, `scripts/e2e-real.test.ts`, `scripts/e2e-real.fetch-stub.mjs`

**Interfaces:**
- Consumes:
  - `node scripts/install-pinned-miden-cli.cjs install`: installs or reuses the CLI pinned in package.json and prints its path as the last stdout line (scripts/install-pinned-miden-cli.cjs:142-146; cargo and git write to stderr).
  - `resolveCliPath()` returns `MIDEN_CLIENT_BIN` before trying any install (playwright/e2e/helpers/miden-cli.ts:116-120); `browserLaunchOptions(extensionPath, env)` runs headless exactly when `env.E2E_HEADLESS === '1'` (playwright/e2e/fixtures/browser-launch-options.ts:14-18).
  - From Tasks 29 (p4-args-env) and 30 (p4-probes): `SUITES.usdcx*` (`usdcx`, `arcKey`, `headlessByDefault`), `run(command, args, env, { unset })`, `opts.arcRpc`, `opts.arcKey`, `opts.headed`, the stub's `cliInstall` and `exitCodes` answers and its `SPAWN <json>` log lines, `stubbed`, `DOCUMENT`, `runCli`.
- Produces:
  - `export function childEnvironments(opts, suite, cliBin?: string): { build: { env: Record<string, string>, unset: string[] }, test: { env: Record<string, string>, unset: string[] } }`.
  - The child env contract p5 relies on (interfaces section 4). Test env of a usdcx suite: `E2E_NETWORK` `'testnet'`, `E2E_REAL_USDCX` `'true'`, `MIDEN_CLIENT_BIN`, `E2E_ARC_RPC_URL` only when given, `E2E_ARC_PRIVATE_KEY` as `0x` + 64 hex only on usdcx-in, `E2E_HEADLESS` `'1'` unless `--headed`. Unset: `E2E_SEPOLIA_PRIVATE_KEY` in every usdcx child, `E2E_ARC_PRIVATE_KEY` in builds and in every test but usdcx-in's, `E2E_HEADLESS` in a `--headed` test.
  - A usdcx run installs the pinned CLI after the preflight and before the build unless `MIDEN_CLIENT_BIN` is exported, and fails without building when the install fails.

`suite.build` (spec 9: `run('yarn', [suite.build ?? 'test:e2e:blockchain:build'], ...)`) is left to PR 2: usdcx-ios is the first suite with its own build, and no PR 1 suite could test it.

- [ ] **Step 1: Write the failing tests**

Before (`scripts/e2e-real.test.ts`, the runner import Task 30 (p4-probes) left):
```ts
  arcRpcEndpoints,
  circleGet,
```
After:
```ts
  arcRpcEndpoints,
  childEnvironments,
  circleGet,
```

Append to the end of `scripts/e2e-real.test.ts`:
```ts
describe('childEnvironments', () => {
  const SEPOLIA_KEY = `0x${'22'.repeat(32)}`;
  const CLI = '/cli/bin/miden-client';
  // What parseArgs returns for `--suite usdcx`; each case changes only what it names.
  const parsed = {
    suite: 'usdcx',
    network: 'testnet',
    sepoliaRpc: 'https://sepolia.invalid',
    sepoliaKey: undefined,
    arcRpc: undefined,
    arcKey: undefined,
    headed: false
  };

  it('builds usdcx with no key in reach and tests it with the run env alone', () => {
    expect(childEnvironments(parsed, SUITES.usdcx, CLI)).toStrictEqual({
      build: { env: { E2E_NETWORK: 'testnet' }, unset: ['E2E_ARC_PRIVATE_KEY', 'E2E_SEPOLIA_PRIVATE_KEY'] },
      test: {
        env: { E2E_NETWORK: 'testnet', E2E_REAL_USDCX: 'true', MIDEN_CLIENT_BIN: CLI, E2E_HEADLESS: '1' },
        unset: ['E2E_SEPOLIA_PRIVATE_KEY', 'E2E_ARC_PRIVATE_KEY']
      }
    });
  });

  it("hands usdcx-in's test, and no build, the key as 0x hex and the operator's Arc RPC", () => {
    const opts = { ...parsed, suite: 'usdcx-in', arcKey: 'ab'.repeat(32), arcRpc: 'https://arc-rpc.example' };
    expect(childEnvironments(opts, SUITES['usdcx-in'], CLI)).toStrictEqual({
      build: { env: { E2E_NETWORK: 'testnet' }, unset: ['E2E_ARC_PRIVATE_KEY', 'E2E_SEPOLIA_PRIVATE_KEY'] },
      test: {
        env: {
          E2E_NETWORK: 'testnet',
          E2E_REAL_USDCX: 'true',
          MIDEN_CLIENT_BIN: CLI,
          E2E_ARC_RPC_URL: 'https://arc-rpc.example',
          E2E_ARC_PRIVATE_KEY: `0x${'ab'.repeat(32)}`,
          E2E_HEADLESS: '1'
        },
        unset: ['E2E_SEPOLIA_PRIVATE_KEY']
      }
    });
  });

  it('runs headed under --headed, and unsets an exported E2E_HEADLESS', () => {
    const { test } = childEnvironments({ ...parsed, suite: 'usdcx-burn', headed: true }, SUITES['usdcx-burn'], CLI);
    expect(test.env).not.toHaveProperty('E2E_HEADLESS');
    expect(test.unset).toContain('E2E_HEADLESS');
  });

  it('gives a suite that is not usdcx the one environment it had, in both phases', () => {
    const env = {
      E2E_NETWORK: 'testnet',
      E2E_REAL_EPOCH: 'true',
      E2E_SEPOLIA_RPC_URL: 'https://sepolia.invalid',
      E2E_SEPOLIA_PRIVATE_KEY: SEPOLIA_KEY
    };
    expect(
      childEnvironments({ ...parsed, suite: 'swap', sepoliaKey: SEPOLIA_KEY }, SUITES.swap, undefined)
    ).toStrictEqual({ build: { env, unset: [] }, test: { env, unset: [] } });
  });
});

describe('a usdcx run', () => {
  const ARC_KEY: `0x${string}` = `0x${'11'.repeat(32)}`;
  const SEPOLIA_KEY = `0x${'22'.repeat(32)}`;
  const STUB_CLI = '/stub/cli/bin/miden-client';
  interface Spawned {
    command: string;
    args: string[];
    env?: Record<string, string>;
  }
  // The stub logs the CLI install and each child run() starts, with the environment names a phase sets or unsets.
  const spawned = (requests: string): Spawned[] =>
    requests
      .split('\n')
      .filter(line => line.startsWith('SPAWN '))
      .map(line => JSON.parse(line.slice('SPAWN '.length)));
  const testArgs = (grep: string) => [
    'playwright',
    'test',
    '--config',
    'playwright.usdcx.config.ts',
    '--retries=0',
    '--grep',
    grep
  ];

  it('installs the pinned CLI, builds with neither key, then tests with the run env alone', () => {
    const res = stubbed(['--suite', 'usdcx'], DOCUMENT, {
      E2E_ARC_PRIVATE_KEY: ARC_KEY,
      E2E_SEPOLIA_PRIVATE_KEY: SEPOLIA_KEY
    });
    expect(spawned(res.requests)).toEqual([
      { command: 'install-pinned-miden-cli', args: ['scripts/install-pinned-miden-cli.cjs', 'install'] },
      { command: 'yarn', args: ['test:e2e:blockchain:build'], env: { E2E_NETWORK: 'testnet' } },
      {
        command: 'yarn',
        args: testArgs('USDCx round trip'),
        env: { E2E_NETWORK: 'testnet', E2E_REAL_USDCX: 'true', MIDEN_CLIENT_BIN: STUB_CLI, E2E_HEADLESS: '1' }
      }
    ]);
    expect(res.output).not.toContain(ARC_KEY.slice(2));
    expect(res.output).not.toContain(SEPOLIA_KEY.slice(2));
    expect(res.status).toBe(0);
  }, 35_000);

  it("hands usdcx-in's test, and only it, the --arc-key and the --arc-rpc", () => {
    const res = stubbed(
      ['--suite', 'usdcx-in', '--arc-key', '11'.repeat(32), '--arc-rpc', 'https://arc-rpc.example'],
      DOCUMENT,
      { E2E_SEPOLIA_PRIVATE_KEY: SEPOLIA_KEY }
    );
    const [, build, test] = spawned(res.requests);
    expect(build.env).toEqual({ E2E_NETWORK: 'testnet' });
    expect(test).toEqual({
      command: 'yarn',
      args: testArgs('funded Arc key'),
      env: {
        E2E_NETWORK: 'testnet',
        E2E_REAL_USDCX: 'true',
        MIDEN_CLIENT_BIN: STUB_CLI,
        E2E_HEADLESS: '1',
        E2E_ARC_PRIVATE_KEY: ARC_KEY,
        E2E_ARC_RPC_URL: 'https://arc-rpc.example'
      }
    });
    expect(res.output).toContain(privateKeyToAccount(ARC_KEY).address);
    expect(res.output).not.toContain(ARC_KEY.slice(2));
    expect(res.status).toBe(0);
  }, 35_000);

  it('takes an exported MIDEN_CLIENT_BIN and installs nothing', () => {
    const res = stubbed(['--suite', 'usdcx-burn'], DOCUMENT, { MIDEN_CLIENT_BIN: '/operator/bin/miden-client' });
    const children = spawned(res.requests);
    expect(children.map(child => child.command)).toEqual(['yarn', 'yarn']);
    expect(children[1].args).toEqual(testArgs('USDCx burn through the Send UI'));
    expect(children[1].env).toMatchObject({ MIDEN_CLIENT_BIN: '/operator/bin/miden-client' });
    expect(res.status).toBe(0);
  }, 35_000);

  it('runs headed under --headed, over an exported E2E_HEADLESS', () => {
    const res = stubbed(['--suite', 'usdcx', '--headed'], DOCUMENT, { E2E_HEADLESS: '1' });
    const test = spawned(res.requests)[2];
    expect(test.args).toEqual([...testArgs('USDCx round trip'), '--headed']);
    expect(test.env).not.toHaveProperty('E2E_HEADLESS');
    expect(res.status).toBe(0);
  }, 35_000);

  it('builds and runs nothing when the pinned CLI does not install', () => {
    const res = stubbed(['--suite', 'usdcx'], DOCUMENT, {}, { cliInstall: { status: 1, stdout: '' } });
    expect(spawned(res.requests).map(child => child.command)).toEqual(['install-pinned-miden-cli']);
    expect(res.output).toContain('the pinned miden-client CLI did not install (exit 1)');
    expect(res.status).toBe(1);
  }, 35_000);

  // A guard: it holds before and after. The suites that are not usdcx keep one environment for both phases.
  it('leaves a swap run as it was: no install, one environment for the build and the test', () => {
    const res = stubbed(['--suite', 'swap'], DOCUMENT, { E2E_SEPOLIA_PRIVATE_KEY: SEPOLIA_KEY });
    const env = {
      E2E_NETWORK: 'testnet',
      E2E_REAL_EPOCH: 'true',
      E2E_SEPOLIA_RPC_URL: 'https://ethereum-sepolia-rpc.publicnode.com',
      E2E_SEPOLIA_PRIVATE_KEY: SEPOLIA_KEY
    };
    expect(spawned(res.requests)).toEqual([
      { command: 'yarn', args: ['test:e2e:blockchain:build'], env },
      {
        command: 'yarn',
        args: [
          'playwright',
          'test',
          '--config',
          'playwright.swap.config.ts',
          '--retries=1',
          '--grep-invert',
          'guardian maker'
        ],
        env
      }
    ]);
    expect(res.status).toBe(0);
  }, 35_000);
});

describe('the usage', () => {
  it('documents the usdcx suites, the Arc flags, the pinned CLI and one usdcx run at a time', () => {
    const res = runCli('-h');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`  ${'usdcx-in'.padEnd(21)} ${SUITES['usdcx-in'].describe}`);
    expect(res.stdout).toContain('--arc-rpc <url>');
    expect(res.stdout).toContain('(env: E2E_ARC_RPC_URL)');
    expect(res.stdout).toContain('--arc-key <0x...>');
    expect(res.stdout).toContain('(env: E2E_ARC_PRIVATE_KEY)');
    expect(res.stdout).toContain('unless MIDEN_CLIENT_BIN is set');
    expect(res.stdout).toContain('Run one usdcx suite at a time');
  }, 35_000);
});
```

- [ ] **Step 2: Run the new tests and watch them fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; yarn jest scripts/e2e-real.test.ts --maxWorkers=2
```
Expected: `Tests:       9 failed, 213 passed, 222 total`. The 211 earlier tests pass, and so do two new guards that hold before and after: `leaves a swap run as it was: ...` and `takes an exported MIDEN_CLIENT_BIN and installs nothing` (with no install step yet, the inherited value already reaches the test child). The other nine fail:
- the four `childEnvironments` cases: `TypeError: (0 , _e2ereal.childEnvironments) is not a function`.
- `installs the pinned CLI, ...`: the spawned list holds no install and both children carry `E2E_REAL_EPOCH: "true"` and `E2E_SEPOLIA_RPC_URL`.
- `hands usdcx-in's test, ...`: `build.env` holds `E2E_REAL_EPOCH` and `E2E_SEPOLIA_RPC_URL`.
- `runs headed under --headed, over an exported E2E_HEADLESS`: the test child inherits `E2E_HEADLESS: "1"`.
- `builds and runs nothing when the pinned CLI does not install`: two `yarn` children and no install.
- `the usage`: `Expected substring: "--arc-rpc <url>"`.

- [ ] **Step 3: Implement the per-phase environments, the CLI install and the usage**

Before (`scripts/e2e-real.mjs`, the run section heading and the doc comment Task 29 (p4-args-env) gave to run):
```js
// ── run ─────────────────────────────────────────────────────────────────────

/**
 * Run `command` with `env` over this process's environment, less each name in `opts.unset`. A key a phase must not
```
After:
```js
// ── run ─────────────────────────────────────────────────────────────────────

/**
 * The environment of the build and of the test run, each as `{ env, unset }` for run(). A usdcx child gets what its
 * phase reads and loses what it must not: no build sees a private key, and only usdcx-in's test sees the Arc key.
 *
 * Exported for test.
 */
export function childEnvironments(opts, suite, cliBin) {
  if (!suite.usdcx) {
    const env = {
      E2E_NETWORK: opts.network,
      E2E_REAL_EPOCH: 'true',
      // GUARDIAN_URL is deliberately NOT injected: swap-guardian.spec.ts resolves
      // it from the run's own environment record, so injecting it here would make
      // this table a second owner of the same fact. The GUARDIAN_URL table stays
      // because probeGuardian reads it to decide what to probe.
      E2E_SEPOLIA_RPC_URL: opts.sepoliaRpc,
      ...(opts.sepoliaKey ? { E2E_SEPOLIA_PRIVATE_KEY: opts.sepoliaKey } : {})
    };
    return { build: { env, unset: [] }, test: { env, unset: [] } };
  }
  const keyed = suite.arcKey === true;
  const headless = suite.headlessByDefault === true && !opts.headed;
  return {
    build: { env: { E2E_NETWORK: opts.network }, unset: ['E2E_ARC_PRIVATE_KEY', 'E2E_SEPOLIA_PRIVATE_KEY'] },
    test: {
      env: {
        E2E_NETWORK: opts.network,
        // Each usdcx describe's beforeAll throws without it, so no other entry point starts a paid run.
        E2E_REAL_USDCX: 'true',
        MIDEN_CLIENT_BIN: cliBin,
        ...(opts.arcRpc ? { E2E_ARC_RPC_URL: opts.arcRpc } : {}),
        ...(keyed ? { E2E_ARC_PRIVATE_KEY: `0x${opts.arcKey.replace(/^0x/i, '')}` } : {}),
        ...(headless ? { E2E_HEADLESS: '1' } : {})
      },
      // --headed must win over an exported E2E_HEADLESS, so it is unset rather than left to be inherited.
      unset: [
        'E2E_SEPOLIA_PRIVATE_KEY',
        ...(keyed ? [] : ['E2E_ARC_PRIVATE_KEY']),
        ...(headless ? [] : ['E2E_HEADLESS'])
      ]
    }
  };
}

/**
 * Install, or reuse, the miden-client CLI pinned in package.json, and return its path: the installer's last stdout
 * line. It runs here, before the build, because a fixture left to resolve it (resolveCliPath in
 * playwright/e2e/helpers/miden-cli.ts) would spend a cold install of up to 35 min inside the test timeout.
 * Undefined after reporting a failure.
 */
function installPinnedCli() {
  console.log('Installing the pinned miden-client CLI (a cold cache builds it with cargo, up to 35 min)\n');
  const res = spawnSync(process.execPath, ['scripts/install-pinned-miden-cli.cjs', 'install'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 2_100_000,
    maxBuffer: 16 * 1024 * 1024
  });
  const cliBin = res.status === 0 ? res.stdout.trim().split('\n').pop() : undefined;
  if (cliBin) return cliBin;
  const why = res.error?.message ?? `exit ${res.status}`;
  console.error(`\n✗ the pinned miden-client CLI did not install (${why}) - nothing was built or run.\n`);
  return undefined;
}

/**
 * Run `command` with `env` over this process's environment, less each name in `opts.unset`. A key a phase must not
```

Before (`scripts/e2e-real.mjs`:1001-1020):
```js
  console.log(`✓ preflight passed (${results.length} checks)\n`);
  if (opts.preflightOnly) return 0;

  const env = {
    E2E_NETWORK: opts.network,
    E2E_REAL_EPOCH: 'true',
    // GUARDIAN_URL is deliberately NOT injected: swap-guardian.spec.ts resolves
    // it from the run's own environment record, so injecting it here would make
    // this table a second owner of the same fact. The table below stays because
    // probeGuardian reads it to decide what to probe.
    E2E_SEPOLIA_RPC_URL: opts.sepoliaRpc,
    ...(opts.sepoliaKey ? { E2E_SEPOLIA_PRIVATE_KEY: opts.sepoliaKey } : {})
  };

  if (!opts.skipBuild) {
    console.log('Building the extension for a real-endpoint run…\n');
    // The wallet reads its Epoch hosts from the config document at runtime, but
    // the network and MIDEN_REMOTE_CONFIG_URL are build defines: --skip-build is
    // only safe when dist/ was produced with this same env.
    const code = await run('yarn', ['test:e2e:blockchain:build'], env);
```
After:
```js
  console.log(`✓ preflight passed (${results.length} checks)\n`);
  if (opts.preflightOnly) return 0;

  let cliBin;
  if (suite.usdcx) {
    cliBin = process.env.MIDEN_CLIENT_BIN || installPinnedCli();
    if (!cliBin) return 1;
    console.log(`Miden CLI ${cliBin}\n`);
  }
  const phases = childEnvironments(opts, suite, cliBin);

  if (!opts.skipBuild) {
    console.log('Building the extension for a real-endpoint run…\n');
    // The wallet reads its Epoch hosts from the config document at runtime, but
    // the network and MIDEN_REMOTE_CONFIG_URL are build defines: --skip-build is
    // only safe when dist/ was produced with this same env.
    const code = await run('yarn', ['test:e2e:blockchain:build'], phases.build.env, { unset: phases.build.unset });
```

Before (`scripts/e2e-real.mjs`:1037-1039):
```js
  console.log(`\nRunning: yarn ${args.join(' ')}\n`);
  return run('yarn', args, env);
}
```
After:
```js
  console.log(`\nRunning: yarn ${args.join(' ')}\n`);
  return run('yarn', args, phases.test.env, { unset: phases.test.unset });
}
```

Before (`scripts/e2e-real.mjs`:108-144):
```js
const USAGE = `
Run the wallet's bridge and swap E2E against real infrastructure:
the hosted Epoch solver, the AggLayer bridge, Sepolia, and public Miden testnet.

  yarn e2e:real --suite <name> [options]

Suites
${Object.entries(SUITES)
  .map(([name, s]) => `  ${name.padEnd(21)} ${s.describe}`)
  .join('\n')}

Options
  --suite <name>            which suite to run (required)
  --network <net>           testnet | devnet            (default: testnet)
  --sepolia-rpc <url>       Sepolia RPC                 (default: a public node)
  --sepolia-key <0x...>     funded Sepolia EOA key, for suites with a signed EVM leg
                            (env: E2E_SEPOLIA_PRIVATE_KEY)
  --min-eth <amount>        preflight gas floor in ether (default: 0.02)
  --preflight-only          probe the services and exit; build and run nothing
  --agglayer-indexer-only   probe only the AggLayer indexer's Miden exit filing and exit;
                            takes no --suite, reads the config document, no URL or key
  --skip-build              reuse the existing dist/ (it must match --network)
  --headed                  run the browser headed
  --grep <pattern>          further narrow the tests within the suite
  -h, --help                this message

The Epoch allocator, the Sepolia USDC, the AggLayer bridge and its indexer come
from the network's config document, read as the wallet reads it:
MIDEN_REMOTE_CONFIG_URL when set, else the published 0xMiden/wallet-config.

No suite here is secret-gated. Bridge-out is solver-fulfilled and swap is
Miden-side, so neither signs on EVM and neither needs a key; --sepolia-key is
accepted so a funded account's gas and test-USDC balance can be READ ahead of a
suite that does sign. Bridge-IN would be that suite, and it
is not here: it cannot run on the extension, whose COEP isolation for the WASM
prover blocks WalletConnect's cross-origin requests.
`;
```
After:
```js
const USAGE = `
Run the wallet's bridge, swap and USDCx E2E against real infrastructure:
the hosted Epoch solver, the AggLayer bridge, Sepolia, Arc Testnet, Circle's
xReserve, the hosted Guardian and public Miden testnet.

  yarn e2e:real --suite <name> [options]

Suites
${Object.entries(SUITES)
  .map(([name, s]) => `  ${name.padEnd(21)} ${s.describe}`)
  .join('\n')}

Options
  --suite <name>            which suite to run (required)
  --network <net>           testnet | devnet            (default: testnet; usdcx suites: testnet only)
  --sepolia-rpc <url>       Sepolia RPC                 (default: a public node)
  --sepolia-key <0x...>     funded Sepolia EOA key, for suites with a signed EVM leg
                            (env: E2E_SEPOLIA_PRIVATE_KEY)
  --arc-rpc <url>           Arc Testnet RPC the usdcx suites try first, then drpc,
                            QuickNode and arc.io (env: E2E_ARC_RPC_URL)
  --arc-key <0x...>         funded Arc Testnet key for usdcx-in; only its address is
                            printed (env: E2E_ARC_PRIVATE_KEY)
  --min-eth <amount>        preflight gas floor in ether (default: 0.02)
  --preflight-only          probe the services and exit; build and run nothing
  --agglayer-indexer-only   probe only the AggLayer indexer's Miden exit filing and exit;
                            takes no --suite, reads the config document, no URL or key
  --skip-build              reuse the existing dist/ (it must match --network);
                            refused for the usdcx suites
  --headed                  run the browser headed (the usdcx suites run headless otherwise)
  --grep <pattern>          further narrow the tests within the suite
  -h, --help                this message

The Epoch allocator, the Sepolia USDC, the AggLayer bridge and its indexer come
from the network's config document, read as the wallet reads it:
MIDEN_REMOTE_CONFIG_URL when set, else the published 0xMiden/wallet-config.

Only usdcx-in needs a secret: an Arc Testnet key holding at least 1.05 USDC.
Every paid usdcx run records its fresh key, with ~9 USDC left on it, under
~/.miden-e2e/arc-keys (mode 0600), and that key serves. Bridge-out is
solver-fulfilled and swap is Miden-side, so neither signs on EVM; --sepolia-key
is accepted so a funded account's gas and test-USDC balance can be READ ahead of
a suite that does sign.

usdcx-in runs bridge-in on the extension with a deposit signed in Node, not
through WalletConnect, which the extension's COEP isolation for the WASM prover
blocks. Every usdcx suite builds, after installing the miden-client CLI pinned
in package.json unless MIDEN_CLIENT_BIN is set (git and cargo; a cold cache
takes up to 35 min). Run one usdcx suite at a time: there is no run lock, and
two runs share the hosted Guardian, the public faucet and a funded key's nonce.
`;
```
(spike-dependent: Q8 headless. If the spike keeps the usdcx suites headed, the `--headed` line reads `run the browser headed`, as on main, and the `E2E_HEADLESS` expectations above flip: `childEnvironments` gives no `E2E_HEADLESS` and unsets it.)

- [ ] **Step 4: Run the file and the scripts directory and see them pass**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
yarn jest scripts/e2e-real.test.ts --maxWorkers=2
yarn jest scripts/ --maxWorkers=2
```
Expected: `Tests:       222 passed, 222 total` for the file (11 new), and `Test Suites: 10 passed, 10 total` for the directory (the jest suites under `scripts/`, `store-listing/` included; on cfb228a48 they are 312 tests, and this partition adds 102, so 414 unless another partition added a `scripts/` test, which none of the contract's file sets does). The `.sh` and `.cjs` tests there are not jest's.

- [ ] **Step 5: Format, lint and check for dashes**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
npx prettier --write scripts/e2e-real.mjs scripts/e2e-real.test.ts scripts/e2e-real.fetch-stub.mjs
npx eslint --max-warnings 0 scripts/e2e-real.mjs scripts/e2e-real.test.ts scripts/e2e-real.fetch-stub.mjs
printf 'a\xe2\x80\x94b\n' | LC_ALL=C grep -c -e $'\xe2\x80\x94' -e $'\xe2\x80\x93'
git diff origin/main -- scripts/e2e-real.mjs scripts/e2e-real.test.ts scripts/e2e-real.fetch-stub.mjs | grep '^+' | LC_ALL=C grep -c -e $'\xe2\x80\x94' -e $'\xe2\x80\x93'
```
Expected: eslint exits 0; the positive control prints `1`; the diff check prints `0`.

- [ ] **Step 6: Preflight each suite against the live services (read-only, no build)**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
yarn e2e:real --suite usdcx --preflight-only
yarn e2e:real --suite usdcx-burn --preflight-only
for LEDGER in ~/.miden-e2e/arc-keys/*.json; do
  E2E_ARC_PRIVATE_KEY="$(node -e 'process.stdout.write(require(process.argv[1]).privateKey)' "$LEDGER")" \
    yarn e2e:real --suite usdcx-in --preflight-only && break
done
```
Expected: `✓ preflight passed (11 checks)`, then `(10 checks)` twice (all three passed this way from a scratch copy on 2026-10-10, in about 3 s each). The usdcx-in loop stops at the first ledger key holding at least 1.05 USDC; its `Arc funded key` line names that key's address and never the key (on the drafting machine the 2026-10-10T13-24-42-476Z file, `0xfEC2B02f01B3F46F25d604d0451D2a6876b12D7E`, held 9.9836 USDC). A ledger key below the floor, such as a fresh key whose payout has not landed, fails `Arc funded key`, which is the probe working; if every key fails, fund one or run `--suite usdcx` first. A live answer that differs from the stub's default (a changed decode-error text, a new Circle field) is fixed in the runner and in the stub's `ANSWERS` together, never by loosening a check.

- [ ] **Step 7: Commit**

This commit lands after commit 12 in the history: its grep test lists the describes commits 11 and 12 add.

```bash
git add scripts/e2e-real.mjs scripts/e2e-real.test.ts scripts/e2e-real.fetch-stub.mjs
git commit -m "test(e2e): usdcx, usdcx-in and usdcx-burn e2e:real suites"
git show --stat --format=%B HEAD
```
Expected: the message is the single line `test(e2e): usdcx, usdcx-in and usdcx-burn e2e:real suites` with no trailer, and the stat lists exactly the three files.

Mutation notes (revert one implementation line, the named test fails):
- `builds usdcx with no key in reach ...` and `installs the pinned CLI, builds with neither key, ...`: drop `'E2E_ARC_PRIVATE_KEY'` from the build `unset`; the build env holds the exported key.
- `hands usdcx-in's test, and no build, the key as 0x hex ...`: write `E2E_ARC_PRIVATE_KEY: opts.arcKey`; the unprefixed key stays unprefixed.
- `hands usdcx-in's test, and only it, the --arc-key and the --arc-rpc`: drop the `opts.arcRpc` spread; `E2E_ARC_RPC_URL` is missing.
- `runs headed under --headed, and unsets an exported E2E_HEADLESS` and `runs headed under --headed, over an exported E2E_HEADLESS`: drop `...(headless ? [] : ['E2E_HEADLESS'])`; the exported `1` is inherited.
- `gives a suite that is not usdcx the one environment it had, ...` and `leaves a swap run as it was: ...`: unset `E2E_SEPOLIA_PRIVATE_KEY` for every suite; the swap env loses the key.
- `takes an exported MIDEN_CLIENT_BIN and installs nothing`: drop `process.env.MIDEN_CLIENT_BIN ||`; an install child appears first.
- `builds and runs nothing when the pinned CLI does not install`: drop `if (!cliBin) return 1;`; two `yarn` children follow the install.
- `documents the usdcx suites, ...`: drop the `--arc-key` lines from USAGE; the substring is missing.

---

### Task 32: The USDCx live suites and the key ledger in e2e-architecture.md, and the CHANGELOG (p5-docs-changelog)

Spec 10(d) (PR 1 lines and the #1100 line edit), spec 6 step 3 and spec 12 (stranded funds and their recovery are documented in e2e-architecture.md), spec 14 step 2 commit 13. #1401's CHANGELOG line (@main CHANGELOG.md:17) stays unchanged (Q1). Runs after p4's commit 10 (the runner's `--arc-rpc` and `--arc-key` flags the doc names).

**Files:**
- Modify: `playwright/e2e/docs/e2e-architecture.md:100` (Contents), `:184` (section 3), `:356-358` (a new section 8 before `## Under the hood`)
- Modify: `CHANGELOG.md:7` (#1100's line; spec 10(d) quotes "on Arc Testnet and Sepolia" and "Activity offers manual execution when needed": Step 5 writes what Q13 and Q11 made true, Sepolia as an executor source and Execute offered again for a stalled hash) and `CHANGELOG.md:13-15` (two new lines at the top of `### Fixes` under `## 1.17.2 (TBD)`)

**Interfaces:**
- Consumes: the suite names `usdcx`, `usdcx-in`, `usdcx-burn` and the flags `--arc-rpc`, `--arc-key` / `E2E_ARC_PRIVATE_KEY` of p4's runner (interfaces section 4); `ARC_KEY_LEDGER_DIR` (`~/.miden-e2e/arc-keys`) and the ledger file shape of `recordArcKey` (interfaces 3.1, 3.2); `DEPOSIT_UNITS + GAS_RESERVE_UNITS` = 1_050_000 base units (interfaces 3.1).
- Produces: e2e-architecture.md section `8 · USDCx on live testnet - out to Arc and back` (anchor `#8--usdcx-on-live-testnet---out-to-arc-and-back`); CHANGELOG lines `[FIX][all]` (the user-visible PR 1 fixes) and `[FIX][ci]` (the three local suites).

- [ ] **Step 1: Confirm the CHANGELOG section**

```bash
git fetch --tags
git tag --list 'v*' --sort=-v:refname | grep -v -e '-rc' | head -1
sed -n 3p CHANGELOG.md
```

Expected: `v1.17.1`, then `## 1.17.2 (TBD)`. If a newer `vX.Y.Z` tag exists, put the two new lines under the highest `(TBD)` section above it instead (add one if none exists); the #1100 line edit stays wherever that line is.

- [ ] **Step 2: Add the Contents entry**

In `playwright/e2e/docs/e2e-architecture.md` replace line 100:

```markdown
- [7 · dApps - a real dApp against the wallet](#7--dapps---a-real-dapp-against-the-wallet)
```

with:

```markdown
- [7 · dApps - a real dApp against the wallet](#7--dapps---a-real-dapp-against-the-wallet)
- [8 · USDCx on live testnet - out to Arc and back](#8--usdcx-on-live-testnet---out-to-arc-and-back)
```

- [ ] **Step 3: Point section 3 at the USDCx suites**

In the same file, after line 184 (the bullet that starts `- **Post-merge (after every merge to main):** the AggLayer route`), insert:

```markdown
- **On demand (`yarn e2e:real --suite usdcx-burn`, and with Circle's payout `--suite usdcx`):** a USDCx burn to Arc Testnet through Circle's Gateway, on live testnet; see [section 8](#8--usdcx-on-live-testnet---out-to-arc-and-back).
```

- [ ] **Step 4: Add section 8**

In the same file replace lines 356-358 (the dApp section's last paragraph, the blank line, and the `---` that precedes the `## Under the hood` heading, which stays as it is):

```markdown
Where it runs: `e2e-dapp.yml`, after every merge, against the branch's live network (testnet from `main`, devnet from `next`) with that network's public faucet and hosted Guardian. No pull request runs it; a branch can dispatch it by hand.

---
```

with:

```markdown
Where it runs: `e2e-dapp.yml`, after every merge, against the branch's live network (testnet from `main`, devnet from `next`) with that network's public faucet and hosted Guardian. No pull request runs it; a branch can dispatch it by hand.

---

## 8 · USDCx on live testnet - out to Arc and back

**What these tests verify:** a Guardian user can take USDCx from the public faucet, send it to Arc Testnet as USDC through the Send screen, be paid by Circle, and bring USDC back to Miden as USDCx, with every hop checked to the base unit against the chain, Circle and the wallet's own records.

Nothing in this group is stood in for. The wallet runs on the public Miden testnet with the hosted OpenZeppelin Guardian, the funds come from the public faucet (USDCx is the testnet fee asset), and Circle's xReserve, its attestation service, its Gateway payouts and Arc Testnet are the real services. The suites need no secret but spend public testnet funds and depend on services the project does not run, so no workflow runs them: each is started by hand, one at a time, with `yarn e2e:real`.

| Suite | Command | What it covers |
|---|---|---|
| `usdcx` | `yarn e2e:real --suite usdcx` | A fresh Guardian wallet takes one faucet grant and burns 10 USDCx through Send to a fresh Arc key. Circle pays the key, the wallet shows the payout as Confirmed, the key deposits 1 USDC back through xReserve, Circle attests it, Circle's relayer mints it and the wallet receives it. Up to 60 min. |
| `usdcx-in` | `E2E_ARC_PRIVATE_KEY=<key> yarn e2e:real --suite usdcx-in` | The deposit leg alone, into a fresh Guardian wallet, from a key that already holds USDC on Arc. Up to 30 min. |
| `usdcx-burn` | `yarn e2e:real --suite usdcx-burn` | One faucet grant and a burn through Send, on a fresh standard wallet and on a fresh Guardian wallet. |

> #### Circle's payout is a hard gate
> The round trip fails when Circle has not paid the burn to the key within 10 minutes of the faucet consuming it. The proof is one Gateway `AttestationUsed` log on Arc whose mint carries the burn note id, so a transfer to the key from anywhere else does not count. Circle has paid Arc burns 10-12 s after the consume, but also 1 h 45 min and about 17 h late, and one burn was still unpaid days later. A red payout step therefore means a user would not have been paid in time; that can be Circle's doing rather than the wallet's, and the failure message says so.

> #### The wallet's own records are checked too
> Beside the chain and Circle, each run reads the wallet's rows: the burn's phases (Burn confirmed, then Confirmed once the wallet sees the payout on Arc), the deposit's phases, and the fee each transaction paid. A deposit row claiming a real deposit that Circle attested to another Miden account must fail, never read Confirmed. A transaction that completed without keeping its result (a landed path) records no fee, so its fee is bounded from the vault instead of read exactly, and the evidence file says which. Each run attaches its evidence as JSON (`usdcx-round-trip-evidence.json`, `usdcx-in-evidence.json`, `usdcx-burn-evidence.json`), never with a private key in it.

The harness reads Arc through drpc and QuickNode first and through `rpc.testnet.arc.io` last, because that endpoint is the one the wallet itself uses and it rate-limits; `--arc-rpc <url>` puts another endpoint in front.

### Arc keys and getting their USDC back

Every `usdcx` and `usdcx-burn` run pays out to a key made for that run. Before the burn, the key is written to `~/.miden-e2e/arc-keys/<time>-<address>.json` (mode 0600, outside the repository and `test-results/`) with its `address`, `privateKey`, the time and the Miden `walletAddress` that paid it. The key is never logged or attached to a report, and a run that dies after its burn still leaves its file behind.

After a `usdcx` run the key holds about 9 USDC (the payout less the 1 USDC deposited back and its gas); after a `usdcx-burn` run, each of its two keys holds about 9.98 USDC once Circle pays. To use one:

- **Fund `usdcx-in` with it:** `E2E_ARC_PRIVATE_KEY="$(jq -r .privateKey ~/.miden-e2e/arc-keys/<file>.json)" yarn e2e:real --suite usdcx-in`. The suite needs 1.05 USDC on the key: the 1 USDC deposit and its gas. (`--arc-key` works too, but leaves the key in your shell history.)
- **Read its balance:** `cast call 0x3600000000000000000000000000000000000000 'balanceOf(address)(uint256)' <address> --rpc-url https://rpc.drpc.testnet.arc.io` (six decimals).
- **Move its USDC:** import the key into any EVM wallet on Arc Testnet (chain 5042002) and send the USDC on, keeping about 0.05 USDC for gas.

These are testnet keys holding testnet USDC. Never commit one, and delete a file once its key is empty.

Only one of these suites may run at a time: nothing locks a run, and two runs would share the hosted Guardian's and Arc's rate limits.

---
```

- [ ] **Step 5: Edit #1100's CHANGELOG line**

On `CHANGELOG.md:7` (the line that starts `- [FEATURE][all] Bridge USDC to Miden as USDCx`) replace the substring:

```markdown
through Circle xReserve on Arc Testnet and Sepolia, or through CCTP and the Arc executor from Base Sepolia and Arbitrum Sepolia.
```

with:

```markdown
through Circle xReserve on Arc Testnet, or through CCTP and the Arc executor from Sepolia, Base Sepolia and Arbitrum Sepolia.
```

and, on the same line, the substring:

```markdown
Activity offers manual execution when needed and saves its hash before the receipt wait
```

with:

```markdown
Activity offers manual execution when needed, offers it again when a saved execute transaction has not mined after a while, and saves its hash before the receipt wait
```

- [ ] **Step 6: Add the two PR 1 lines**

In `CHANGELOG.md` replace lines 13-15:

```markdown
### Fixes

- [FIX][ci] The live USDCx bridge-IN E2E fails at once when `USDCX_LIVE_EVM_PRIVATE_KEY` is not set, where its spec used to skip and the run passed having tested nothing.
```

(origin/main 6856c9f6a: #1402's line now opens the section) with:

```markdown
### Fixes

- [FIX][all] A USDCx deposit reads Confirmed only once Circle's attestation names the network, token, Miden account and amount the wallet signed for, on the xReserve and the executor route alike, and an xReserve deposit Circle attested otherwise fails naming what differs; a delivered deposit reaches Received however its consume completes; a burn whose submission outcome is unknown waits for the node's verdict instead of failing; a deposit left at Confirmed for 7 days times out, and a mint that arrives later still completes it; the USDCx fee labels name the fee asset instead of MIDEN; the arrival estimate follows the source chain (~1 min from Arc Testnet, ~20 min from the others); an executor deposit whose saved execute transaction never mines offers Execute again and is not failed while its message can still be executed; Sepolia deposits go through CCTP and the Arc executor, since Circle's xReserve does not serve Miden from Sepolia; and a burn retries its destination balance read, so one failed Arc RPC read no longer stops it before it is queued.
- [FIX][ci] Three local `yarn e2e:real` suites check the USDCx bridge on live testnet with fresh wallets funded by the public faucet: `usdcx` (a Guardian wallet on the hosted Guardian burns through Send to a fresh Arc key, Circle pays it, the wallet confirms the payout, the key deposits back through xReserve and the wallet receives the mint, every hop to the base unit), `usdcx-in` (the deposit leg alone, from a funded Arc key) and `usdcx-burn` (the USDCx burn spec, now funded by a public faucet grant for its standard and Guardian wallets and moved to `tests/usdcx`). Each run's Arc key is kept in a 0600 ledger under `~/.miden-e2e/arc-keys`, and playwright/e2e/docs/e2e-architecture.md says how to recover its USDC.
- [FIX][ci] The live USDCx bridge-IN E2E fails at once when `USDCX_LIVE_EVM_PRIVATE_KEY` is not set, where its spec used to skip and the run passed having tested nothing.
```

- [ ] **Step 7: Check the CHANGELOG gate, the anchors and the dashes**

```bash
BASE_REF=origin/main NO_CHANGELOG_LABEL=false bash scripts/check-changelog.sh; echo "exit $?"
grep -n '^## 8 · USDCx on live testnet - out to Arc and back$' playwright/e2e/docs/e2e-architecture.md
grep -c '#8--usdcx-on-live-testnet---out-to-arc-and-back' playwright/e2e/docs/e2e-architecture.md
grep -c 'Fund your wallet asks the faucet for the largest amount' CHANGELOG.md
grep -c 'The live USDCx bridge-in E2E builds against a dispatching pull request' CHANGELOG.md
grep -c 'The live USDCx bridge-IN E2E fails at once' CHANGELOG.md
printf 'a\xe2\x80\x94b\n' | grep -c -e $'\xe2\x80\x94'
git diff -U0 -- playwright/e2e/docs/e2e-architecture.md CHANGELOG.md | grep '^+' | grep -c -e $'\xe2\x80\x94' -e $'\xe2\x80\x93'
```

Expected: `exit 0`; one heading line; `2` anchor references (Contents and section 3); `1`; `1` (#1401's line untouched); `1` (#1402's line untouched); `1` for the positive control; `0` added lines with an em or en dash.

- [ ] **Step 8: Commit spec commit 13**

```bash
git add playwright/e2e/docs/e2e-architecture.md CHANGELOG.md
git status --short
git commit -m "docs(e2e): USDCx live suites, key ledger recovery and changelog"
git show --stat --format=%B HEAD
```

Expected: exactly those two paths staged; the body is the single line with no trailer.

---

## Delivery (PR 1b)

Spec section 14, PR 1, harness, suites, runner and docs. Every command runs from `/Users/celrisen/miden/wt-usdcx-e2e` with `export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"`.

- [ ] **Step 1: Spike outcome and budgets.** Spike v2 ran the round trip on main (header). Freeze the step budgets in `usdcx-roundtrip.spec.ts` (`BUDGET`) and `usdcx-burn.spec.ts` (`BUDGET`, describe 1_500_000) from it: each a small multiple of the spike's step time with a floor for chain variance, and the sums still under 60 min (`usdcx`), 30 min (`usdcx-in`) and 25 min (`usdcx-burn`) with about 2 min of fixture setup. The decode of a burn's `resultBytes` by role is the one point no spike has run: the first live `usdcx` run (Step 7) exercises it, since `burn_confirmed` decodes the row's bytes through `burnOutputs` and requires the burn note N, a sponsorship equal to the live `fee_schedule` entry (119) and a fee note equal to `feeAmount`. A failure there corrects the oracle in its own commit, never loosens the check.

- [ ] **Step 2: Commits.** Five commits in this order, each made by the task named, messages verbatim, no trailers:

| Spec commit | Task | Message |
|---|---|---|
| 9 | 24 | `test(e2e): shared USDCx harness modules and row readers` |
| 11 | 27 | `test(e2e): extension Guardian USDCx round trip and funded-key bridge-in` |
| 12 | 28 | `test(e2e): retarget the USDCx burn spec onto the public faucet and move it to tests/usdcx` |
| 10 | 31 | `test(e2e): usdcx, usdcx-in and usdcx-burn e2e:real suites` |
| 13 | 32 | `docs(e2e): USDCx live suites, key ledger recovery and changelog` |

```bash
git log --format=%s wiktor/usdcx-fixes..HEAD
git log --format=%B wiktor/usdcx-fixes..HEAD | grep -ci -e 'co-authored' -e 'generated with' -e 'claude' -e 'cursor' -e 'codex'
```

Expected: the five subjects above, newest first; `0`.

- [ ] **Step 3: CHANGELOG (the suites line).** PR 1a already edited #1100's line and added the `[FIX][all]` fix line, so Task 32 Steps 5 and 6 are applied against that tree: Step 5 is already done (confirm with `grep -c 'through Circle xReserve on Arc Testnet, or through CCTP and the Arc executor from Sepolia' CHANGELOG.md`, expected `1`, and skip its replacements); in Step 6 the quoted before-block is PR 1a's two-line `### Fixes` opening (the `[FIX][all]` line, then #1402's `[FIX][ci]` line), so insert only the `[FIX][ci] Three local` suites line between them and leave the `[FIX][all]` line as it is. Task 32 Step 7's expected counts hold unchanged.

- [ ] **Step 4: Local gates (only what CI cannot run for us).**

The changed suites and every test file in their directories, with the harness guards (#1401's linked-PR ceiling and #1402's workflow guard live in the harness directory):

```bash
yarn jest playwright/e2e/helpers playwright/e2e/harness scripts --maxWorkers=2
```

Expected: 0 failed suites. Then formatting, lint and the harness ratchet on every changed file:

```bash
CHANGED=$(git diff --name-only --diff-filter=ACMR wiktor/usdcx-fixes...HEAD -- '*.ts' '*.tsx' '*.mjs' | grep -v '^docs/')
npx prettier --check $CHANGED
npx eslint --max-warnings 0 $CHANGED
yarn lint:e2e
```

Expected: prettier reports `All matched files use Prettier code style!`, eslint prints nothing, and `lint:e2e` reports no file above its baseline. The dash check, with its positive control, over every added line and every commit message:

```bash
printf 'a\xe2\x80\x94b\n' | perl -ne 'print "control hit\n" if /\xe2\x80[\x93\x94]/'
git diff -U0 wiktor/usdcx-fixes...HEAD | grep '^+' | perl -ne 'print "DASH: $_" if /\xe2\x80[\x93\x94]/'
git log --format=%B wiktor/usdcx-fixes..HEAD | perl -ne 'print "DASH: $_" if /\xe2\x80[\x93\x94]/'
```

Expected: exactly `control hit`. Mutation checks: for every new harness and runner test, write down which test the task's mutation note predicts will fail, then back the file up and mutate in one command, run that file's suite, and restore in the same command (`F=<file>; cp "$F" "$F.mutbak" && <mutation> && { yarn jest <suite> --maxWorkers=2 2>&1 | grep -E '^Tests:|●'; }; mv "$F.mutbak" "$F"`). Record predicted against observed for each; a mutation that fails nothing means the test is inert, and it is fixed before review. `git status --short` must show no `.mutbak` file afterwards. The changelog check and `lint:i18n` run in CI (Step 9).

- [ ] **Step 5: Review.** A standard whole-branch review on the most capable model (D12, no review-council): base = the fork point on PR 1a's branch (`git merge-base wiktor/usdcx-fixes HEAD`), focus on the Review Focus item, the payout gate and the per-phase child environments. Fix each actionable finding with its own new commit (never amend), re-run that file's suite and every test file in its directory, then a scoped re-review of each fix. P3 findings are not fixed or filed.

- [ ] **Step 6: Merge only if needed.** If GitHub reports the PR `CONFLICTING`, or PR 1a squash-merged first (retarget this PR to main, then merge origin/main; KB `git-stacked-child-merge-resurrects-reverted-lines`: diff the file list against this branch's own afterwards):

```bash
git fetch origin && git fetch --tags
git merge origin/main
git diff origin/main...HEAD -- CHANGELOG.md
```

Resolve hunk by hunk, never by taking one side (CHANGELOG.md is union-merged; KB `github-mergeability-ignores-merge-union`). Then `yarn install --frozen-lockfile`, re-run Step 4's commands, `arc-usdcx.test.ts`, `usdcx-miden.test.ts` and one oracle subcommand against testnet (`node playwright/e2e/helpers/usdcx-chain-evidence.mjs supply https://rpc.testnet.miden.io mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0`), and check that the suites line still sits under the highest `(TBD)` section above the latest `v*` tag and that no line this branch removed came back (KB `git-union-merge-resurrects-moved-lines`).

- [ ] **Step 7: Live runs on the final tree.** One suite at a time (there is no run lock), in this order, each from a clean shell:

```bash
yarn e2e:real --suite usdcx
```

Must show: `✓ preflight passed (11 checks)`, the pinned CLI path, the build, then `1 passed`. The attached `usdcx-round-trip-evidence.json` holds the Guardian identity, every id and hash, the fees f0, f1, s, the Circle payout fee (16_400 so far) and f2 each marked `exact` or `bounded`, the latencies consume-to-payout and payout-to-wallet-confirmation, both phase timelines (POSITIVE ending `received`, NEGATIVE ending `failed` with `Circle attested this deposit to a different Miden account.` and never `ready`), and no private key; a new file under `~/.miden-e2e/arc-keys` holds the run's key with about 9 USDC on it.

```bash
for LEDGER in ~/.miden-e2e/arc-keys/*.json; do
  KEY="$(node -e 'process.stdout.write(require(process.argv[1]).privateKey)' "$LEDGER")"
  E2E_ARC_PRIVATE_KEY="$KEY" yarn e2e:real --suite usdcx-in --preflight-only >/dev/null 2>&1 && break
  KEY=
done
test -n "$KEY" && E2E_ARC_PRIVATE_KEY="$KEY" yarn e2e:real --suite usdcx-in
```

The loop only probes (a ledger key below 1.05 USDC fails its preflight and the next is tried), so the paid run happens once. Must show: a preflight of 10 checks whose `Arc funded key` line names the key's address, never the key, with at least 1.05 USDC, then `1 passed`; if no key passes, nothing runs: read one key's preflight output to see why; `usdcx-in-evidence.json` records whether the approve was sent, the POSITIVE timeline ending `received`, and the mint consume as the account's first transaction.

```bash
yarn e2e:real --suite usdcx-burn
```

Must show: a preflight of 10 checks, then `2 passed` (standard and Guardian), two `usdcx-burn-evidence.json` attachments, and two more ledger keys whose payouts stay recoverable. Keep each evidence path (Playwright's attachments under `test-results/`) for the PR body. A red payout step whose message carries the late-payout sentence can be Circle's doing (spec 12): report it with the evidence rather than retrying blindly.

- [ ] **Step 8: Push and open the PR.** Base branch `wiktor/usdcx-fixes` while PR 1a is open, `main` after it merges.

```bash
BODY="$(mktemp -t usdcx-pr1b-body)"
"${EDITOR:-vi}" "$BODY"
perl -ne 'print "DASH: $_" if /\xe2\x80[\x93\x94]/' "$BODY"; cat "$BODY"
git push -u origin wiktor/usdcx-live-e2e
gh pr create --repo 0xMiden/wallet --base wiktor/usdcx-fixes --head wiktor/usdcx-live-e2e --title "Local live USDCx round-trip suites for extension wallets" --body-file "$BODY"
gh pr view --repo 0xMiden/wallet --json body --jq .body
```

Read the body back before and after creating it. Body rules: open with one sentence saying what changed and why it matters; then one-line bullets (the three suites, the shared harness modules, the runner's suites and refusals, the USDCx burn spec move, the docs, and a `Live E2E (local)` bullet with the Step 7 results); everything else (decisions Q1-Q14 that shaped behavior, test inventory with counts, evidence paths, the rejected alternatives) in one collapsed `<details>` block; above the fold no more than one screen. Describe the current state only, never review rounds. End with: `**Reviewers:** the payout gate in arc-usdcx.ts (waitForGatewayPayout) and the per-phase child environments in scripts/e2e-real.mjs (childEnvironments) are the parts worth your time.` No tool attribution anywhere, and search the body for U+2014 and U+2013 before posting.

- [ ] **Step 9: Push only what review changed, then CI by head SHA.** Each later fix is its own commit, pushed unsquashed; never force-push.

```bash
gh api "repos/0xMiden/wallet/actions/runs?head_sha=$(git rev-parse HEAD)" --jq '.total_count, (.workflow_runs[] | "\(.name) | \(.status) | \(.conclusion)")'
```

`total_count` must be non-zero (a push can create no runs; KB `github-actions-push-sometimes-creates-no-runs`). Watch coverage (95% on every metric), the changelog check, `lint:e2e`, and the linked-PR injection guard. Report each failure as it lands and fix it with a new commit.

- [ ] **Step 10: KB follow-up (separate from the PR).** `notes/infra/agglayer-indexer-miden-exit-shape.md` still says rollup id 86; main uses 73 since #1385 (scripts/e2e-real.mjs:37-44). Fix it with `~/agentic-kb/scripts/note.sh` and push the note.

## Appendix A: Cross-task interface contract (final)

The contract the tasks were drafted against, with every change made at assembly folded in, so each consumer here uses its producer's final signature. Tasks cite it as "contract N.M" or "interfaces section N".

### A.0 Conventions

- Base: origin/main 6856c9f6a (Setup). Files that differ between cfb228a48 and origin/main and that PR 1 touches or calls: `playwright/e2e/helpers/public-faucet.ts`, `scripts/e2e-real.mjs` (:521 text only), `public/_locales/en/en.json` (+3 lines at :430, so `usdcxArrival` is @main :1093; :4, :6, :17 unchanged), `public/_locales/en/messages.json` (`usdcxArrival` @main :4763; :10, :62 unchanged), `CHANGELOG.md` (#1100 line :7, #1402 line :15, #1401 line :17), `playwright/e2e/harness/linked-pr-injection.test.ts`, `.github/workflows/e2e-usdcx-live.yml`.
- A spec commit spanning several tasks is made by the last of them; the earlier ones end at their green run with "Commit deferred to Task N". That last task stages every path of the commit's file set (A.7).
- File ownership: a task edits only its partition's files, except the edits A.7 lists as ratified at assembly.
- New jest tests under `playwright/` and `scripts/` start with the `@jest-environment node` docblock. New `playwright/**` files add no `lint:e2e` violation (no `toBeGreaterThan(0)`, no `waitForTimeout(>2000)`, no `expect` inside if/else).

### A.1 Product receive side (p1) consumed by p2, p3, p5

`src/lib/miden/db/types.ts`:

```ts
export interface IBridgedReceiveExtraInputs {
  /* ...existing fields unchanged... */
  /** usdcx: the xReserve remoteRecipient bytes32 the wallet signed (0x + 64 lowercase hex), written at the deposit's first phase write. */
  usdcxRemoteRecipient?: string;
  /** Unix seconds at which the row first reached `ready`. Written once, never cleared, kept through `failed`; a ready row from before the stamp gets it as it moves on. */
  readyAt?: number;
}
// IUsdcxCctpLeg gains:
//   executeSavedAt?: number;        // Unix seconds the current executeTxHash was saved, from either side
//   stalledExecuteTxHash?: string;  // an execute unmined past USDCX_EXECUTE_STALL_SEC: never adopted again, still asked about
export interface IConsumedNote { id: string; senderAddress: string; faucetId: string; amount?: bigint }
// ITransaction and ConsumeTransaction gain consumedNotes?: IConsumedNote[] (optional, unindexed, no Dexie version bump).
```

`src/lib/miden/transaction/complete.ts`:

```ts
export const updateBridgedReceivePhase: (
  id: string,
  phase: IBridgedReceivePhase,
  extra?: Partial<Pick<IBridgedReceiveExtraInputs,
    'evmTxHash' | 'intentNonce' | 'midenNoteId' | 'outputAmount' | 'outputSymbol' | 'cctp' | 'error' | 'usdcxRemoteRecipient'>>,
  received?: { amount: bigint; faucetId: string; transactionId?: string },
  options?: { onlyIfNoExecuteHash?: boolean }
) => Promise<void>;
```

It stamps `readyAt` as above and `cctp.executeSavedAt` whenever a write sets an execute hash different from the row's; a reopen naming `revertedExecuteTxHash` or `stalledExecuteTxHash` lands only while the row still holds that hash. Phase rules (`canMoveBridgedReceivePhase`) are unchanged.

`src/lib/usdcx/deposit-target.ts` (new; imports the SDK through `accountRefToSdk`, so the Node harness never imports it):

```ts
export function usdcxRemoteRecipientFor(accountRef: string): Hex;
export function usdcxExpectedRemoteTokenFor(faucetRef: string): Hex;
```

`src/lib/usdcx/attestation.ts` (imports only `viem` and `./constant`): `XReserveAttestation`, `FetchXReserveAttestationsOptions`, `fetchXReserveAttestations`, `findAttestationForDomain` kept; `isUsdcxDepositAttested` removed.

```ts
export const XRESERVE_DEPOSIT_INTENT_MAGIC: Hex; // '0x5a2e0acd'
export const XRESERVE_DEPOSIT_INTENT_VERSION: number; // 1
export interface XReserveDepositIntent {
  version: number; amount: bigint; remoteDomain: number; remoteToken: Hex; remoteRecipient: Hex;
  localToken: Hex; localDepositor: Hex; maxFee: bigint; nonce: Hex; hookData: Hex;
}
export function decodeXReserveDepositIntent(payload: Hex): XReserveDepositIntent | undefined;
export interface UsdcxDepositExpectation { remoteRecipient: Hex; remoteToken: Hex; amount: bigint; remoteDomain?: number }
export type UsdcxAttestationMismatchField = 'remoteDomain' | 'remoteToken' | 'recipient' | 'amount';
export type UsdcxAttestationMatch =
  | { kind: 'attested'; attestation: XReserveAttestation; intent: XReserveDepositIntent }
  | { kind: 'mismatch'; field: UsdcxAttestationMismatchField }
  | { kind: 'unreadable' }
  | { kind: 'pending' };
export function matchUsdcxDepositAttestation(list: readonly XReserveAttestation[], expected: UsdcxDepositExpectation): UsdcxAttestationMatch;
```

Byte layout (captured 0x370bf19a, 240 bytes, no hook): magic@0[4] version@4[4] amount@8[32] remoteDomain@40[4] remoteToken@44[32] remoteRecipient@76[32] localToken@108[32] localDepositor@140[32] maxFee@172[32] nonce@204[32] hookLen@236[4] hookData@240[hookLen]. `src/lib/usdcx/attestation.vectors.json` is Circle's body for that deposit, verbatim plus one trailing newline (sha256 `7be79c54...0e0f`), listed in `.prettierignore`; p3's `arc-usdcx.test.ts` imports it read-only.

Row errors `bridge-receive.ts` writes (phase `failed`): `Circle attested this deposit to a different network.` | `... different token.` | `... different Miden account.` | `... different amount.` (remoteDomain, remoteToken, recipient, amount), and `Bridge delivery timed out.` (`BRIDGE_DELIVERY_TIMED_OUT`, exported from bridge-in.ts). The executor route's mismatch, and `unreadable` and `pending` on both routes, write nothing. A `ready` USDCx row that is not `restoredFromBackup` stays in `readUnsettledRows` for the 7-day cutoff only (counted from `readyAt`); an executor row in `delivering` holding an attested message and no saved execute hash is exempt from the cutoff, and one with a saved hash counts its week from `cctp.executeSavedAt`.

`src/lib/miden/activity/bridge-in.ts`:

```ts
export interface AdoptableNote { id: string; senderAddress: string; faucetId: string; amount?: bigint }
export function adoptableNotesOf(tx: Pick<ITransaction, 'consumedNotes' | 'noteId' | 'noteIds' | 'secondaryAccountId' | 'faucetId' | 'amount'>): AdoptableNote[] | undefined;
export async function adoptBridgeDeliveries(consumeId: string, notes: readonly AdoptableNote[]): Promise<void>; // never throws, idempotent per note
export async function adoptLandedConsume(consumeId: string): Promise<void>; // never throws; Completed, non-restored consumes only
```

A note without its amount, faucet or sender goes to the intent registry pass (by id) only. Six call sites: `completeConsumeTransaction` (executed notes), `writeLanding`, the Guardian landed branch, the loop's landed branch, `tryCompleteKilledConsume`, the stuck-consume reaper (the last five through `adoptLandedConsume`). `takeUsdcxBridgeInInfo` keeps its signature and also takes a `failed` USDCx row with `readyAt` and `Bridge delivery timed out.`, ranked after live rows, at any age.

Status semantics p5 relies on: a `provider: 'usdcx'` bridged-send passes `canAwaitVerdict`, so an unknown submit outcome reads 4 (Unconfirmed); a reconciler landing reads 2 with `extraInputs.usdcxBurn` intact, `displayMessage` `Bridged to EVM` and no `feeAmount`, `resultBytes` or `resultReleasedAt`. A consume reads 2 with its result, or 2 on a landed path; a landed consume of a USDCx mint still moves its bridged-receive row to `received`.

### A.2 Product UI and sources (p2) consumed by p1, p3, p5

- Writers: `runUsdcxDeposit` and `runUsdcxExecutorDeposit` (signatures unchanged) pass `usdcxRemoteRecipient: remoteRecipient.toLowerCase()` in their first `updatePhase(trackingTxId, 'submitting', ...)`; the deposit screen derives the recipient at both sites through `usdcxRemoteRecipientFor(midenAccount.publicKey)`.
- `src/lib/usdcx/constant.ts`: Arc Testnet entries byte-identical (`XRESERVE_ADDRESS.get(5042002) = '0x008888878f94C0d87defdf0B07f46B93C1934442'`, `CIRCLE_USDC_ADDRESS.get(5042002) = '0x3600000000000000000000000000000000000000'`, `CIRCLE_DOMAIN.get(5042002) = 26`, `USDCX_REMOTE_DOMAIN = 10007`, `XRESERVE_ATTESTATION_API_TESTNET = 'https://xreserve-api-testnet.circle.com'`, `USDCX_BURN_TAG = 0x4255524e`, `USDCX_BURN_WITHDRAWAL_ATTACHMENT_SCHEME = 5`). Sepolia in `USDCX_SOURCE_CHAINS` is `executorSource(sepolia, ARC_TESTNET_EXECUTOR)` unless `E2E_USDCX_CHAIN === 'sepolia'`; the address maps keep Sepolia. p1 tests use 5042002 for direct rows and 84532 for executor rows, never 11155111. New: `usdcxArrivalKey(sourceChainId: number): 'usdcxArrivalArc' | 'usdcxArrival'`; `EvmBridgeDepositReview` gains `sourceChainId?: number`, `EvmBridgeUsdcxRoute` gains `sourceChainId: number`.
- Test ids: `data-testid="usdcx-burn-notice"` on the notice `<p>` in Route.tsx (inside the new `UsdcxRouteOption`) and ReviewTransaction.tsx, rendering en `usdcxWithdrawalNotice`. Existing ids unchanged: `send-flow`, `send-recipient-input`, `send-network-options`, `send-network-<id>` with `aria-pressed`, `send-recipient-confirm`, `send-amount-input`, `send-amount-confirm`, `bridge-route-usdcx`, `bridge-route-confirm`, `send-review-submit`, `review-error`, `history-status-pill`.
- English copy: `usdcxMidenFees` = `$symbol$ fees`, `usdcxSponsorshipFee` = `Paid in $symbol$, including faucet execution sponsorship` (messages.json declares `placeholders.symbol`), `symbol` = `resolveDisplayMetadata(nativeFaucetId ?? undefined, assetsMetadata, nativeFaucetId).symbol`; `usdcxArrival` stays `~20 min`, new `usdcxArrivalArc` = `~1 min`.
- Test hooks (E2E builds): `CreateBridgeReceiveArgs.sourceChainId?: number` (type only); `__TEST_BRIDGE_RECEIVE_STATE__` and `__TEST_LATEST_BRIDGE_RECEIVE__` also return `evmTxHash`, `error`, `midenNoteId`, `sourceChainId`, `usdcxRemoteRecipient`, `readyAt`; global names unchanged.
- Snapshot retry: `readUsdcxDestinationBalance(chainId, recipient, timeoutMs = 15_000)`; `readUsdcxDestinationSnapshot(chainId, recipient, deps?: UsdcxSnapshotDeps)` tries 3 times, 1 s then 2 s apart, inside one 15 s budget, and rethrows the last error; burn.ts:103 reads through it, so a burn whose every attempt fails still throws before any row is queued.
- `playwright/e2e/ios/helpers/xreserve-fork.ts` reads `XRESERVE_ADDRESS.get(sepolia.id)` and `CIRCLE_USDC_ADDRESS.get(sepolia.id)`, throwing if either is missing; `FORK_USDC_ADDRESS` and `FORK_XRESERVE_ADDRESS` keep their values.

### A.3 Shared harness (p3) consumed by p4 and p5

All in `playwright/e2e/helpers/`; product imports use relative paths; `arc-usdcx.ts` never imports `usdcx/deposit.ts`, `executor.ts` or `deposit-target.ts`.

- `usdcx-constants.ts`: `BURN_UNITS`, `DEPOSIT_UNITS`, `GAS_RESERVE_UNITS`, `GRANT_MARGIN_UNITS`, `PAYOUT_TIMEOUT_MS`, `WALLET_CONFIRM_TIMEOUT_MS`, `ARC_LOG_CHUNK`, `ARC_DRPC_LOG_CHUNK`, `GATEWAY_MINTER` (`0x0022222ABE238Cc2C7Bb1f21003F0a260052475B`), `ATTESTATION_USED_TOPIC` (`0xbb312ce0...fd63`), `ARC_DRPC_URL`, `ARC_QUICKNODE_URL`, `ARC_PUBLIC_URL`, `DEFAULT_ARC_RPCS`, `ARC_KEY_LEDGER_DIR`, `ARC_CHAIN_ID`, `ARC_XRESERVE`, `ARC_USDC`, `ARC_ATTESTATION_API`, `ARC_CIRCLE_DOMAIN`, `GUARDIAN_ECDSA_SCHEME`, `interface ArcClock { now(): number; sleep(ms: number): Promise<void> }`, `realArcClock`, and re-exports of `USDCX_REMOTE_DOMAIN`, `USDCX_BURN_TAG`, `USDCX_BURN_WITHDRAWAL_ATTACHMENT_SCHEME`, `minimumUsdcxPayout`, `FEE_RESERVE_MULTIPLE`.
- `arc-usdcx.ts`: `ArcKey`, `newArcKey()`, `ArcKeyLedgerEntry`, `recordArcKey(key, walletAddress, opts?): string`, `arcEndpoints(override?): string[]` (throws `E2E_ARC_RPC_URL is set but empty`), `ArcClock` and `realArcClock` (re-exported), `ArcPublicClientFactory`, `ArcReadDeps { endpoints; publicClient?; clock? }`, `type ArcWriteDeps = ArcReadDeps` (writes sign locally and send raw through the read client), `readArcUsdc(address, deps, blockNumber?)`, `readXReserveDomainState(deps)` (its `depositor` is the address padded to a lowercase bytes32), `scanArcLogs(client, endpoint, query)`, `GatewayPayout`, `PayoutGateFailure`, `PayoutGateError`, `GatewayPayoutArgs`, `waitForGatewayPayout(args, deps)` (`deadlineMs` is an absolute epoch time, `consumeTsMs + PAYOUT_TIMEOUT_MS`), `DepositSubmission`, `submitDepositToMiden(args, deps)`, `DepositedToRemoteEvent`, `confirmDepositToMiden(submission, deps)`, `waitForXReserveAttestation(depositHash, opts)`, `DecodedDepositIntent`, `decodeDepositIntent(payload)`, `assertDepositIntent(attestation, expected): Promise<{ intent: DecodedDepositIntent; signer: Address }>` (async: viem's `recoverAddress` is async, so callers `await` it), `XRESERVE_HARNESS_ABI`, `LATE_PAYOUT_NOTE`, `errorText`.
- `usdcx-guardian.ts`: `GuardianIdentity`, `guardianIdentity(url, fetchImpl?)`, `guardianFailureContext(identity, fetchImpl?)` (never throws), `assertNoGuardianOpInFlight(rows, accountId)`, `burnFailureMessage(row)`.
- `usdcx-miden.ts` over `usdcx-chain-evidence.mjs` (subcommands `supply`, `burn-evidence`, `burn-outputs`, `mint-note-id`, `note`, `nullifier`, `account-hex`, `recent-notes`; the positional form is gone and fails with its usage line): `ChainEvidenceRunner`, `runChainEvidence`, `bareId`, `accountHex`, `supply`, `BurnEvidence`, `burnEvidence` (throws naming the verdict when the burn was never committed or not consumed, so a returned evidence has `nullifierCommitted: true`), `BurnOutputs`, `burnOutputs` (spike-dependent: decode by role), `deriveUsdcxMintNoteId` (validated on two real mints), `MidenNoteRead` (`committed` equals `found`), `note`, `nullifier`, `recentNotes`, `waitForUsdcxMint`, `boundLandedFee({ vaultDelta, knownTerms, baseFee })` (signed debits: a burn passes V1 - V2 and N + s, a consume of M passes V2 - V3 and -M).
- `history.ts`: `JsonValue`; `TransactionRowSnapshot` gains `extraInputs`, `stageTimestamps`, `submitEvidence`, `resultReleasedAt`, and (only from `readTransactionRowsWithBytes`) `outputNoteIds`, `requestBytes`, `resultBytes`; `TransactionRowsQuery`, `readTransactionRowsInPage(query)`, `readTransactionRowsWithBytes(page, type)`; `TxStatus`, `readTransactionRows`, `readTransactionRow`, `openHistoryDetails` unchanged.
- `bridge.ts`: `UsdcxBalanceSnapshotRow`, `UsdcxBurnRow`, `BridgedSendExtraInputsRow`, `BridgedSendRow` (id, status, stage, stageTimestamps, error, rawError, displayMessage, transactionId, outputNoteIds, requestBytes, feeAmount, feeFaucetId, completedAt, resultBytes, resultReleasedAt, submitEvidence, extraInputs), `readBridgedSendRows(page)`, `bridgedSendRowOf`, `readNativeDisplaySymbol(page, nativeTokenId)`, `enText(key, values?)` (throws on a missing key, a value without its placeholder, or a placeholder left unreplaced), `BridgeOutUsdcxOptions { destAddress; amount; nativeTokenId; nativeSymbol; stepTimeoutMs?; screenshotDir }`, `BridgeOutUsdcxResult`, `bridgeOutUsdcx(wallet, opts)`, `CreateUsdcxBridgeReceiveArgs`, `createUsdcxBridgeReceive(wallet, args)`, `BridgeReceivePhase`, `BridgeReceiveStateSnapshot`, `parseBridgeReceiveState`, `bridgeReceiveState(wallet, txId)`, plus `USDCX_DESTINATION_CHIPS`, `NetworkChipState`, `usdcxChipsProblem`, `reviewQueryParam`, `isArcSnapshotFailure`.
- Existing harness symbols used unchanged: `test`, `expect`, fixtures `walletA`, `envConfig`, `steps`, option `injectFeeFaucet`; `ownsProfile`, `trackGuardianCommitments()`, `waitForGuardianSettled(timeoutMs?)`; `createGuardianWallet(url)`, `assertGuardianAuth(pk, expected)`, `currentGuardianEndpoint()`, `navigateHome()`; `getEnvironmentConfig()`; `walletDiscoveredNativeFaucetId`, `walletDiscoveredBaseFee`, `vaultBalanceOfCurrentAccount`, `waitForVaultBalanceOfCurrentAccount`, `fromBaseUnits`; `mintFromPublicFaucet(baseUrl, accountId)`, `publicFaucetApiUrl(network)`; `waitForPublicNoteCommitment`; `swOf`; `midenAccountHexToXReserveRecipient`; `listPlaywrightTests`.

### A.4 Runner (p4) to the specs (p5): the child environment

Test env of a usdcx suite: `E2E_NETWORK` `'testnet'`, `E2E_REAL_USDCX` `'true'`, `MIDEN_CLIENT_BIN` (the installer's last stdout line, or the operator's export), `E2E_ARC_RPC_URL` only when given, `E2E_ARC_PRIVATE_KEY` as `0x` + 64 hex only for `usdcx-in`, `E2E_HEADLESS` `'1'` unless `--headed` (spike v2 confirmed Q8). Unset: `E2E_SEPOLIA_PRIVATE_KEY` in every usdcx child; `E2E_ARC_PRIVATE_KEY` in builds and in every test but `usdcx-in`'s; `E2E_HEADLESS` in a `--headed` test. `scripts/e2e-real.mjs` exports `run(command, args, env, opts?: { unset?: readonly string[] })`, `childEnvironments(opts, suite, cliBin?)`, `ARC_TESTNET_CHAIN_ID`, `ARC_XRESERVE`, `ARC_USDC`, `ARC_CIRCLE_DOMAIN`, `USDCX_REMOTE_DOMAIN`, `USDCX_DECIMALS`, `XRESERVE_API_TESTNET`, `GATEWAY_MINTER`, `DEFAULT_ARC_RPCS`, `USDCX_GRANT_FLOOR_UNITS`, `USDCX_FUNDED_KEY_FLOOR_UNITS`, `arcRpc`, `circleGet`, `arcRpcEndpoints`, `usdcxGrantProblem`; `e2e-real.test.ts` pins each constant to `usdcx-constants.ts` and `src/lib/usdcx/constant.ts`.

### A.5 Specs (p5) to the runner (p4): configs and titles

- `playwright.usdcx.config.ts`: `{ ...base, testDir: './playwright/e2e/tests/usdcx', testIgnore: undefined, timeout: 3_600_000 }`; `playwright.e2e.config.ts` testIgnore gains `'**/usdcx/**'`.
- `usdcx-roundtrip.spec.ts`: describe `USDCx round trip: burn to a fresh Arc key, Circle payout, deposit back` with test `Guardian wallet: public faucet grant, Send burn, payout and its confirmation, deposit back, receipt` (grep `USDCx round trip`); describe `USDCx bridge-in from a funded Arc key` (timeout 1_800_000) with test `Guardian wallet receives a Node-signed xReserve deposit` (grep `funded Arc key`).
- `usdcx-burn.spec.ts`: describe `USDCx burn through the Send UI after a public faucet grant` (timeout 1_500_000) with tests `standard wallet publishes a burn and the faucet consumes it` and `Guardian wallet publishes a burn and the faucet consumes it` (grep `USDCx burn through the Send UI`).
- Each grep compiles case-insensitive and lists only its own tests. Each spec module loads with no env set.

### A.6 Spec-level strings

POSITIVE hook row: `{ accountId: address, amount: String(M), faucetId: native, sourceChainId: 5042002, sourceAddress: key, sourceAmount: '1', sourceSymbol: 'USDC', evmTxHash: depositHash }`. NEGATIVE: the same with `amount: '2000000000'`, `sourceAddress: '0xe88f781e6cc8b7496f259200b57e22cb9457ff99'`, `sourceAmount: '2000'`, `evmTxHash: '0x370bf19aefa34f6f07d7b731d5b5f323a364c6f4116a22768d4e44a16ffeca4d'`; it ends `failed` with `Circle attested this deposit to a different Miden account.` and is never sampled `ready`.

### A.7 Commit file sets

- Commit 1 (Task 7): `.prettierignore`, `src/lib/miden/db/types.ts`, `src/lib/miden/transaction/complete.ts`, `src/lib/miden/transaction/bridged-receive-phase.test.ts`, `src/lib/usdcx/deposit-target.ts`, `src/lib/usdcx/deposit-target.test.ts`, `src/lib/usdcx/attestation.ts`, `src/lib/usdcx/attestation.test.ts`, `src/lib/usdcx/attestation.vectors.json`, `src/lib/miden/activity/bridge-receive.ts`, `src/lib/miden/activity/bridge-receive.test.ts`, `src/lib/miden/activity/bridge-receive.usdcx.test.ts`, and p2's `src/lib/usdcx/deposit.ts`, `src/lib/usdcx/deposit.test.ts`, `src/lib/usdcx/executor.ts`, `src/lib/usdcx/executor.test.ts`, `src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.tsx`, `src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.usdcx.test.tsx` (18 paths).
- Commit 3 (Task 9) also stages `src/lib/miden/transaction/transactions.guardian-offscreen.test.ts` and `src/lib/miden/transaction/transactions.bridged-earn-offscreen.test.ts`: they pin the old exclusion, and the commit is red without them (ratified at assembly).
- Commit 4 (Task 12): every p1 file of Tasks 10-12.
- Commit 9 (Task 24): every p3 file plus `playwright/e2e/helpers/drain-progress.test.ts`, whose expectation pins the old projection (ratified at assembly; 14 paths).
- Commit 11 (Task 27): `playwright.usdcx.config.ts`, `playwright.e2e.config.ts`, `playwright/e2e/harness/spec-selection.test.ts`, `playwright/e2e/tests/usdcx/usdcx-roundtrip.spec.ts`, and the three files p5 adds beyond its list, `playwright/e2e/helpers/usdcx-run.ts`, `usdcx-run.test.ts` and `usdcx-legs.ts` (ratified at assembly: the burn spec shares the legs, and a spec cannot import a spec; 7 paths).
- Commit 12 (Task 28): `playwright/e2e/tests/usdcx/usdcx-burn.spec.ts` (moved from `tests/bridge/bridge-out-usdcx.spec.ts`), `playwright/e2e/harness/spec-selection.test.ts`.
- Commit 10 (Task 31): `scripts/e2e-real.mjs`, `scripts/e2e-real.test.ts`, `scripts/e2e-real.fetch-stub.mjs`; it lands after commit 12.
- Commit 13 (Task 32): `playwright/e2e/docs/e2e-architecture.md`, `CHANGELOG.md`.
