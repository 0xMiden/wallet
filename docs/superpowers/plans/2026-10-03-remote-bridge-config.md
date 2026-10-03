# Remote Epoch and Agglayer Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Epoch and Agglayer redeploys stop needing a wallet release: the wallet reads 9 roots and 4 switches from `0xMiden/wallet-config` once at startup, derives the rest from chain, and greys out each affected entry point while what it needs is missing, undeployed or down.

**Architecture:** Load at startup. Each realm hydrates the stored document and its derived values into one in-memory snapshot when it starts (instant, from storage), then refreshes in the background. Every consumer reads values synchronously from that snapshot. Entry points are greyed until the snapshot makes their feature available, so code past an entry point always finds its values; a missing value there throws `BridgeConfigUnavailableError` into the flow's existing error path.

**Tech Stack:** TypeScript, React 18, Jest 30, `@miden-sdk/miden-sdk` 0.17.0-rc.5, viem 2, `@epoch-protocol/epoch-intents-sdk` 1.0.39, Playwright with Anvil doubles.

**Spec:** `docs/superpowers/specs/2026-10-03-remote-bridge-config-design.md` (lean v1, commit `0c9f98fcb`, plus the startup-load amendment in Task A).

## Starting point

The design-independent code is already built: 19 commits in a scratch copy of `0c9f98fcb` (`scratchpad/lean/wt`), each built with its own and neighbouring jest suites, `tsc` with no new errors, eslint and prettier; full jest once after T12; Playwright specs listed and linted, not run. Its async-design plan is archived as `scratchpad/plan-lean-13k.md`.

| Commit | Contents |
|---|---|
| T2-T3 | `schema.ts` (document rules R1-R11), `source.ts` (bounded fetch, version floor, `MIDEN_REMOTE_CONFIG_URL` define, floor key preserved on reset) |
| T4 | `derive.ts`: bridge registry decoding (rollup id, registered faucets), L1 `networkID()` and code, ERC-20 metadata, Miden faucet metadata, allocator and indexer health |
| T5-T8 | `availability.ts`, `runtime.ts` (store and poll scheduler), `values.ts`, hooks, `FeatureUnavailableNotice`, two i18n keys, config loaded at the app root |
| T9-T15 | Consumers: Epoch SDK hosts, Fast route, Earn, pricing, Agglayer bridge out and indexer, bridge-in sender from the registry, deposit screen |
| T16 | Entry points greyed |
| T17-T19 | `EPOCH_*` defines removed, E2E mocks fixed (`networkID()`, `MockUsdc` symbol and 18 decimals), served document for the local suites |
| T20 | Dead constants removed, CHANGELOG, CLAUDE.md |

The `0xMiden/wallet-config` repo (old Task 1) is executed separately, from `scratchpad/plan-lean-13k.md` Task 1.

## Global Constraints

- Base `origin/next`; branch `feat/remote-bridge-config` in `~/wallet/.worktrees/remote-bridge-config`.
- No `any`, no `as`; `.prettierrc` has `trailingComma: "none"`; i18n for user-facing text; comment density near the touched file's.
- Remote-config modules do no I/O at import.
- Single-line commit messages with no attribution of any kind. No em or en dashes.
- Tests: `yarn jest <path> --maxWorkers=2`. Per-commit green is not required during this work (decided 2026-10-03); the branch must be green before the PR.

## Review Focus

1. **Service worker before hydration:** a bridge-in delivery or a spend valued in the first milliseconds of a service-worker wake must see the stored config, so `start()` awaits `initBridgeConfig()` before any handler can run. Test in Task E Step 1.
2. **Fresh install, first fetch fails:** every gated entry point stays greyed, nothing throws at render, and the next poll recovers. Test in Task C Step 1.
3. **Network switched in Developer Settings while open:** the snapshot never serves one network's values for another. Test in Task C Step 1.
4. **Getter reached while unavailable** (a deep link straight to a review screen): it throws `BridgeConfigUnavailableError` into the flow's existing error UI, never an unhandled rejection. Test in Task E Step 3.
5. **Document published between render and submit:** the submit reads the newer document. Accepted; no test.

---

### Task A: Spec amendment for startup load

**Files:**
- Modify: `docs/superpowers/specs/2026-10-03-remote-bridge-config-design.md` (section "Wallet runtime")

- [ ] **Step 1:** Add after the "Network" bullet:

```markdown
- **Startup load:** each realm hydrates the stored document and derived snapshot into memory when it starts, and every consumer reads them synchronously. The service worker awaits that hydration in `start()` before its handlers run; pages start it at app mount without blocking render, since their entry points stay greyed until the snapshot is ready. A realm with nothing stored starts the first fetch without waiting for it.
```

- [ ] **Step 2:** `git add -f docs/superpowers/specs/2026-10-03-remote-bridge-config-design.md && git commit -m "docs: load the remote config at startup"`

### Task B: Bring in the built commits

- [ ] **Step 1:** Export the 19 commits after the scratch base and apply them on the branch:

```bash
cd /private/tmp/claude-501/-Users-celrisen/98041d6b-5fb3-4b6a-91fa-f888a8bf58de/scratchpad/lean/wt
git format-patch -o ../patches "$(git log --format=%H | tail -1)"..HEAD
cd ~/wallet/.worktrees/remote-bridge-config
git am --3way /private/tmp/claude-501/-Users-celrisen/98041d6b-5fb3-4b6a-91fa-f888a8bf58de/scratchpad/lean/patches/*.patch
```

Before `git am`, replace each patch's `Subject:` line (`T2 schema` and so on) with a real single-line message. Expected: 19 commits applied, authored by the git config defaults.

### Task C: Synchronous runtime entry

**Files:**
- Modify: `src/lib/remote-config/runtime.ts`, `src/lib/remote-config/runtime.test.ts` and its worker-environment suite

- [ ] **Step 1: Failing tests.** Replace the `loadBridgeConfig` cases with:
  - `initBridgeConfig()` with a stored document resolves with the snapshot `ready` and the document in memory, and does not wait for the network (the fetch mock never resolves; the promise still resolves).
  - `initBridgeConfig()` with nothing stored resolves at once with `status: 'loading'`, starts one fetch, and publishes `ready` with the document when it lands; with a failing fetch it publishes `ready` with `config: null` and the next scheduled poll recovers (Review Focus 2).
  - Calling `initBridgeConfig()` twice starts one hydration and one scheduler.
  - After `getEffectiveNetworkName` changes, `getBridgeConfigSnapshot()` reports the new network with `status: 'loading'` until the next `initBridgeConfig()` hydrates it (Review Focus 3).

Run: `yarn jest src/lib/remote-config/runtime --maxWorkers=2`. Expected: FAIL, `initBridgeConfig is not a function`.

- [ ] **Step 2: Implement.** Rename `loadBridgeConfig` to `initBridgeConfig(): Promise<void>` and drop the branch that awaits the first refresh when nothing is stored:

```ts
/**
 * Hydrates the stored document and derived snapshot for the effective network into memory and starts the scheduler.
 * Never waits for the network: with nothing stored it starts the first fetch and resolves at once. Never rejects.
 */
export async function initBridgeConfig(): Promise<void> {
  const state = await hydrateCurrent();
  const due = isDue(state, state.failures > 0 ? backoffDelay(state.failures) : HEALTHY_POLL_MS);
  if (due || !state.stored) void startRefresh(state);
  ensureScheduler();
}
```

Keep `_refreshBridgeConfigForTest`. Make `getBridgeConfigSnapshot()` return the effective network's state with `status: 'loading'` when that network is not hydrated yet.

- [ ] **Step 3:** Run the suite; expected PASS. Mutation: restore the awaited first refresh; the "resolves at once" test fails.

- [ ] **Step 4:** `git commit -am "Load the remote config at startup without waiting for the network"`

### Task D: Synchronous getters

**Files:**
- Modify: `src/lib/remote-config/values.ts`, `src/lib/remote-config/values.test.ts`

- [ ] **Step 1: Failing test.** With a ready snapshot each getter returns its value synchronously (not a Promise); with `config: null` each throws `BridgeConfigUnavailableError` naming the value.

- [ ] **Step 2: Implement.** Replace the async helper and rename every getter from `require*` to `get*`, dropping `async`; each keeps its selector body unchanged:

```ts
function getValue<T>(value: string, select: (s: BridgeConfigSnapshot) => T | null): T {
  const found = select(getBridgeConfigSnapshot());
  if (found === null) throw new BridgeConfigUnavailableError(value);
  return found;
}

export function getEpochAllocatorUrl(): string {
  return getValue('epoch.allocatorUrl', s => s.config?.epoch.allocatorUrl ?? null);
}
```

Same for `getEpochPositionsUrl`, `getEvmChainId`, `getMidenUsdc`, `getEvmUsdc`, `getEarnMarket`, `getAgglayerMidenBridge`, `getAgglayerIndexerUrl`, `getAgglayerL1Bridge`, `getAgglayerBridgeOut`, `getAgglayerDeposit`.

- [ ] **Step 3:** `yarn jest src/lib/remote-config --maxWorkers=2`; expected PASS. Mutation: drop the null check in `getValue`; the throw tests fail.

- [ ] **Step 4:** `git commit -am "Read remote config values synchronously"`

### Task E: Call sites and startup hooks

Each edit drops the `await` and the `require` prefix (lines as of commit T20):

| File:line | Old | New |
|---|---|---|
| `src/app/App.tsx:68` | `void loadBridgeConfig();` | `void initBridgeConfig();` |
| `src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.tsx:387` | `await requireAgglayerDeposit()` | `getAgglayerDeposit()` |
| `src/lib/epoch/positions.ts:314` | `await Promise.all([requireEpochPositionsUrl(), requireEarnMarket()])` | `[getEpochPositionsUrl(), getEarnMarket()]` |
| `src/lib/epoch/earn.ts:285` | `await requireEvmChainId()` | `getEvmChainId()` |
| `src/lib/epoch/earn.ts:357` | `await requireEarnMarket()` | `getEarnMarket()` |
| `src/lib/epoch/epoch-send.ts:77`, `:132` | `await requireEvmUsdc()` | `getEvmUsdc()` |
| `src/lib/epoch/epoch-send.ts:251` | `await requireEvmChainId()` | `getEvmChainId()` |
| `src/lib/epoch/earn-withdraw.ts:156`, `:688` | `await requireEvmUsdc()` | `getEvmUsdc()` |
| `src/lib/epoch/earn-withdraw.ts:165` | `await requireEpochAllocatorUrl()` | `getEpochAllocatorUrl()` |
| `src/lib/epoch/sdk.ts:45`, `:73`, `:99` | `await requireEpochAllocatorUrl()` | `getEpochAllocatorUrl()` |
| `src/lib/agglayer/status.ts:101`, `:172` | `${await requireAgglayerIndexerUrl()}` | `${getAgglayerIndexerUrl()}` |
| `src/lib/agglayer/contract.ts:55` | `await requireAgglayerL1Bridge()` | `getAgglayerL1Bridge()` |
| `src/lib/agglayer/allowed-faucets.ts:23`, `:58` | `await requireAgglayerMidenBridge()` | `getAgglayerMidenBridge()` |
| `src/lib/agglayer/b2agg/index.ts:91` | `await requireAgglayerBridgeOut()` | `getAgglayerBridgeOut()` |
| `src/lib/miden/spending-limits/valuation.ts:60` | `await loadBridgeConfig();` | delete (the worker hydrates in `start()`, pages at mount) |
| `src/lib/miden/activity/bridge-in.ts:180` | `selectNativeEthFaucet(await loadBridgeConfig())` | `selectNativeEthFaucet(getBridgeConfigSnapshot())` |

Update each file's imports. Leave function signatures unchanged.

- [ ] **Step 1: Service worker startup.** In `src/lib/miden/back/main.ts` `start()`, right after `await loadEndpointOverrides();`:

```ts
  // Synchronous readers in this realm (bridge-in matching, spend valuation) need the stored config before any handler runs.
  await initBridgeConfig();
```

Test in `src/lib/miden/back/main.test.ts` (Review Focus 1): `start()` calls `initBridgeConfig` after `loadEndpointOverrides` and before `Actions.init`. Mutation: move it after `Actions.init`; the test fails.

- [ ] **Step 2:** Apply the table. Update tests that mocked `require*` or `loadBridgeConfig` (grep `require(Epoch|Evm|Miden|Earn|Agglayer)|loadBridgeConfig` under `src` and `playwright`): they become synchronous `get*` mocks or a ready snapshot.

- [ ] **Step 3: Review Focus 4.** In `src/screens/earn-flow/EarnDepositReview.test.tsx`: with no document, submitting from a deep-linked review shows the existing failure state and logs no unhandled rejection.

- [ ] **Step 4:** Run the changed suites and every test file in each changed file's directory: `yarn jest src/lib/epoch src/lib/agglayer src/lib/remote-config src/lib/miden/spending-limits src/lib/miden/activity src/lib/miden/back src/app/App src/app/templates/EvmConnectModal src/screens/earn-flow --maxWorkers=2`. Expected PASS.

- [ ] **Step 5:** `git commit -am "Consumers read the remote config synchronously"`

### Task F: Ship

- [ ] **Step 1:** `grep -rn -E 'require(EpochAllocatorUrl|EpochPositionsUrl|EvmChainId|MidenUsdc|EvmUsdc|EarnMarket|Agglayer)|loadBridgeConfig' src playwright` returns nothing.
- [ ] **Step 2:** `yarn lint`, `yarn lint:i18n`, prettier check, the source-scanning guard tests, and `npx tsc --noEmit` with no new errors against the base.
- [ ] **Step 3:** Push `feat/remote-bridge-config`; open the PR against `next` (one-sentence summary, bullets, details collapsed, a Reviewers line; links the spec).
- [ ] **Step 4:** Run `/review-council:rev` on the PR, fix, and babysit CI.
