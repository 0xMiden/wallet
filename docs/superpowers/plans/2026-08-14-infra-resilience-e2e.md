# Infra-Resilience E2E Harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local, hermetic, fault-injecting Playwright E2E suite that simulates every wallet infra dependency failing/flaking, asserts best-practice graceful degradation & recovery, fixes the wallet where it falls short, and leaves the passing tests as regression guards — running on pushes to `main`.

**Architecture:** Extend the existing localnet docker-stack harness. Generalize the guardian-only `context.route` fault seam (`harness/guardian-fault.ts`) into a whole-infra `harness/network-faults.ts` armed per-spec on the wallet page object. Each gap is a TDD red→green cycle: assert best-practice behavior → prove it fails (gap reproduces) → fix the product minimally → prove it passes → commit. 22 scenarios start RED (need a fix); 3 are regression guards (green immediately).

**Tech Stack:** Playwright (`@playwright/test`), TypeScript, the localnet docker-compose stack (miden-node, tx-prover, note-transport, OZ guardian, Anvil), Jest+RTL (unit), GitHub Actions.

## Global Constraints

- **Node >= 22** for any local build/run (`source ~/.nvm/nvm.sh && nvm use 22`).
- **No new CI binary dependency by default** — fault via `context.route`; add a scoped hand-rolled `node` TCP proxy only if a specific fault can't be faithfully reproduced (decided per-gap).
- **"Hook flag, not behavior switch"** — test seams live in `playwright/`; never suppress real product behavior under `MIDEN_E2E_TEST`. The two unreachable branches use a `playwright/`-level hook, not a `src/` switch.
- **No `any`, no `as`** — concrete types (repo rule).
- **i18n required** — all new user-facing strings use `t('key')` / `<T id/>`, keys added to `public/_locales/en/en.json` (flat, `$name$` placeholders). `yarn lint:i18n` gates.
- **Prettier**: 120 cols, single quotes, semicolons, trailing commas.
- **Commits**: single-line, short, no `Co-Authored-By`, never `--amend`, never `git push` without explicit request.
- **CHANGELOG**: one entry for the whole effort, under a `(TBD)` section whose version is strictly higher than the latest release tag.
- **CI trigger** for the new suite: `push: [main]` + `workflow_dispatch` + nightly `schedule` (NOT a required PR gate).
- **Regression-determinism**: `retries: 0` for the resilience config; deterministic fault arming (`failFirstN` + explicit `clear`).
- **Fund-safety invariant** (assertion north-star): no scenario may leave a fund-loss-shape — no dropped incoming note, no double-send, no falsely-Completed-without-confirmation, no unrecoverable stuck delivery, no fresh-empty-account-on-blip.

---

## File Structure

**New (harness):**
- `playwright/e2e/harness/network-faults.ts` — generalized fault seam (all infra origins + new modes). Mirrors `guardian-fault.ts` structure (pure `decideNetworkFault` + `applyNetworkFaultAction` + `installNetworkFaults`).
- `playwright/e2e/harness/network-faults.spec.ts` — unit tests for the pure decision/hit-count logic (no browser), mirroring `guardian-fault-policy.spec.ts`.
- `playwright.resilience.config.ts` — `{...base, testDir: './playwright/e2e/tests/resilience', testIgnore: undefined}`.
- `playwright/e2e/tests/resilience/*.spec.ts` — one spec file per scenario (25).
- `playwright/e2e/harness/resilience-assertions.ts` — shared assertion helpers (staleness cue, connectivity banner, delivery chip, notification, dead-letter indicator) reading `__TEST_STORE__` / DOM.
- `.github/workflows/e2e-resilience.yml` — the new workflow.

**Modified (harness wiring):**
- `playwright/e2e/fixtures/two-wallets.ts` — install `network-faults` alongside guardian-faults; expose `armNetworkFault(policy)` on the wallet page object (both `launchWalletInstance` and `relaunchContext`).
- `playwright.e2e.config.ts:22` — add `'**/resilience/**'` to `testIgnore`.
- `package.json` — add `test:e2e:resilience:run` + `test:e2e:resilience`.
- `scripts/lint-e2e-harness.mjs` — include `playwright/e2e/tests/resilience/**` in the lint scope.

**Modified (product fixes — one subsystem per gap; exact lines in each task):**
`src/lib/miden/activity/notes.ts`, `.../back/dapp.ts`, `.../back/main.ts`, new `src/lib/miden/note-deadletter.ts` (g1); `.../transaction/retry.ts`, `.../transaction/cancel.ts`, `.../transaction/index.ts` (g2); `.../transaction/complete.ts`, `.../activity/connectivity-state.ts` (g3); `src/lib/epoch/positions.ts`, `src/screens/earn-flow/EarnPositions.tsx`, `.../useEarnPositions.ts` (g4); `src/components/ConnectivityIssueBanner.tsx`, `src/app/App.tsx`, money surfaces (g5); new failed-tx notification in `src/lib/extension/notifications.ts` + `src/lib/mobile/native-notifications.ts` (g6); `.../sdk/miden-client.ts` (g7); `src/lib/agglayer/{use-bridge-tracker.ts,constant.ts}` (g8); `src/lib/miden-chain/native-asset.ts`, `src/lib/epoch/chain.ts`, `src/lib/miden/metadata/fetch.ts`, `.../history/BridgeClaimSection.tsx` (g9); `src/lib/wallet-prompts.ts`, `src/lib/miden-chain/faucet-api.ts` (g10); `src/app/ErrorBoundary.tsx` (g11); `src/app/pages/Welcome.tsx`, `.../back/account.ts` (g12); `src/lib/miden/back/vault.ts` (g13); `.../back/sync-manager.ts`, `.../front/useSyncTrigger.ts` (g14); `.../guardian/serialize.ts`, `.../transaction/index.ts` (g15); `src/lib/prices/binance.ts` (g16); `.../back/sync-manager.ts` (g17).

---

## Shared conventions

### The per-gap TDD micro-loop (every gap task follows this exactly)

1. **Write the failing spec** — `playwright/e2e/tests/resilience/<scenario>.spec.ts`, importing `{ test, expect } from '../fixtures/two-wallets'`, arming the specified fault via `walletA.armNetworkFault(...)`, driving the wallet action via `ChromeWalletPage`, and asserting the **best-practice** behavior (given per task).
2. **Run it → confirm RED.** `yarn test:e2e:resilience:run <spec>` (stack must be up locally). Capture the failure in the commit body. If it passes and the gap is not a designated regression-guard, STOP and re-examine — the audit may be wrong for that gap (verify before touching product code).
3. **Read the cited code, then apply the minimal fix** to the target behavior. This is TDD bug-fixing: the minimal fix is written against the real code at execution time, not pre-guessed. Add a fast **unit test** for any pure logic introduced (classifier, backoff, landed-check, delivery-state machine).
4. **Run → confirm GREEN** (e2e + unit + `yarn ts`).
5. **Commit** — one commit per gap: `git add <spec> <unit> <src>` then `git commit -m "fix(resilience): <gap>"`.

### Fault-arming API (produced by Task 0.1)

```ts
walletA.armNetworkFault({
  target: 'node' | 'prover' | 'transport' | 'guardianA' | 'guardianB'
        | 'positions' | 'allocator' | 'anvil' | 'agglayer' | 'binance' | 'faucetMiden' | 'faucetForkchoice',
  path?: string,            // optional URL-substring narrowing (e.g. 'submit', 'SyncState', '/pow')
  mode: 'status500' | 'status429RetryAfter' | 'abort' | 'connectionRefused' | 'timeout'
      | 'hang' | 'delay' | 'slowStream' | 'truncatedBody' | 'malformedBody'
      | 'failFirstN' | 'conflictPendingDelta' | 'nonceMismatch' | 'canonicalizing',
  count?: number,           // failFirstN / conflict* : requests to fault before pass-through
  delayMs?: number,         // delay / slowStream
  retryAfterSec?: number,   // status429RetryAfter
});
walletA.clearFaults();      // disarm all (network + guardian)
```

Guardian faults keep working via `armGuardianFault` (unchanged); `armNetworkFault` is the superset used by resilience specs.

---

## PHASE 0 — Harness foundation

### Task 0.1: Generalized network-fault seam (pure logic + unit tests)

**Files:**
- Create: `playwright/e2e/harness/network-faults.ts`
- Create: `playwright/e2e/tests/resilience/network-faults-policy.spec.ts` (Playwright pure-logic spec, mirroring `guardian-fault-policy.spec.ts` — no browser/stack)

**Design (integration-critical):** ONE combined `context.route('**/*')` handler.
`guardian-fault.ts` stays **untouched**. `installNetworkFaults` holds two policy
slots: an array of `NetworkFaultPolicy` (armed by `armNetwork`) and one
`GuardianFaultPolicy` (armed by `armGuardian`, the adapter behind `armGuardianFault`).
The handler tries network policies first; on no network match it defers to the
existing `decideGuardianFault`/`applyGuardianFaultAction` (byte-identical guardian
behavior — the guardian suite is unaffected). This avoids the Playwright "route
already handled" double-`continue()` conflict of two `**/*` handlers.

**Interfaces:**
- Produces: `installNetworkFaults(context, {network, guardian}): NetworkFaultControls` with `armNetwork(policyOrPolicies)/armGuardian(policy)/clear()`; pure `decideNetworkFault(url, policies, hits, origins)` returning `{matchedIndex, action, hits}` and `applyNetworkFaultAction(route, action)`; types `NetworkFaultTarget` (incl. `guardianA`/`guardianB`), `NetworkFaultMode`, `NetworkFaultPolicy`, `NetworkOrigins`, `LOCAL_NETWORK_ORIGINS`.
- Consumes: `decideGuardianFault`, `applyGuardianFaultAction`, `GuardianFaultPolicy`, `GuardianOrigins` from `guardian-fault.ts` (imported, not modified).
- Modes implemented here: `status500`, `status429RetryAfter`, `abort`, `connectionRefused`, `timeout`, `hang` (never settle), `delay`, `slowStream`, `truncatedBody`, `malformedBody`, `failFirstN`. (`conflictPendingDelta` stays guardian-only via `armGuardian`; `nonceMismatch`/`canonicalizing` added in Task 3.3 with real wire envelopes read from the guardian client.)

- [ ] **Step 1 — Write failing unit tests** in `network-faults.spec.ts` mirroring `guardian-fault-policy.spec.ts`: for each `mode`, assert `decideNetworkFault` returns the right `action` and hit-count; assert target/path matching by origin table; assert `failFirstN`/`count` self-clears; assert an unmatched origin → `{kind:'continue'}`.
- [ ] **Step 2 — Run → FAIL** (`yarn jest network-faults` → "installNetworkFaults is not a function").
- [ ] **Step 3 — Implement** `network-faults.ts` mirroring `guardian-fault.ts`: `NetworkOrigins` maps each `NetworkFaultTarget` → origin (localnet defaults: node `http://localhost:57291`, prover `http://localhost:50052`, transport `http://localhost:57292`, guardianA `:3000`, guardianB `:3001`, positions `:8549`, allocator `:8548`, anvil `:8545`, agglayer/binance/faucet\* read from env overrides Task 0.5 adds). `targetOf(url,origins)` by origin; optional `path` substring narrows. `applyNetworkFaultAction`: `continue`/`abort('failed')`/`abort('connectionrefused')`/`abort('timedout')`/`fulfill{status,body}`/never-resolve (`hang`)/`setTimeout` (`delay`,`slowStream`)/truncated or non-JSON body (`truncatedBody`,`malformedBody`)/`429` with `Retry-After` header (`status429RetryAfter`)/guardian `nonceMismatch`+`canonicalizing` envelopes.
- [ ] **Step 4 — Run → PASS** (`yarn jest network-faults`).
- [ ] **Step 5 — Commit** `test(resilience): generalized network-fault decision logic`.

### Task 0.2: Wire network-faults into the two-wallet fixture

**Files:** Modify `playwright/e2e/fixtures/two-wallets.ts` (import + `launchWalletInstance` ~439-466 + `relaunchContext` ~224 + the `GuardianAwareWalletPage` type ~43).

**Interfaces:** Produces `walletA.armNetworkFault(policy)` (superset of guardian faults) + `clearFaults()` now clears both.

- [ ] **Step 1** — Add a resilience spec `playwright/e2e/tests/resilience/_seam.smoke.spec.ts` that arms `{target:'node', path:'SyncState', mode:'status500'}` and asserts the wallet raises a connectivity signal (proves the seam reaches SW node traffic). Expected RED (method missing).
- [ ] **Step 2 — Run → FAIL** (`armNetworkFault` undefined).
- [ ] **Step 3** — `installNetworkFaults(context, networkOrigins())` next to `installGuardianFaults`; add `armNetworkFault` to the `Object.assign` augmentation and to `relaunchContext`; extend `clearFaults` to clear both control objects; add `armNetworkFault` to `GuardianAwareWalletPage`.
- [ ] **Step 4 — Run → PASS** (seam reaches SW node fetch; connectivity signal observed).
- [ ] **Step 5 — Commit** `test(resilience): arm whole-infra faults on the wallet page object`.

### Task 0.3: Resilience Playwright config + test dir + base exclusion

**Files:** Create `playwright.resilience.config.ts`; Modify `playwright.e2e.config.ts:22` (add `'**/resilience/**'`); create `playwright/e2e/tests/resilience/.gitkeep`.

- [ ] **Step 1** — Create config = copy `playwright.earn.config.ts`, swap `testDir` to `'./playwright/e2e/tests/resilience'`.
- [ ] **Step 2** — Add `'**/resilience/**'` to the base `testIgnore` array.
- [ ] **Step 3 — Verify** `npx playwright test --config playwright.resilience.config.ts --list` shows only resilience specs and the core PR run (`playwright.e2e.config.ts`) excludes them.
- [ ] **Step 4 — Commit** `test(resilience): dedicated playwright config + base exclusion`.

### Task 0.4: package.json scripts + lint:e2e scope

**Files:** Modify `package.json` (scripts); Modify `scripts/lint-e2e-harness.mjs`.

- [ ] **Step 1** — Add `"test:e2e:resilience:run": "playwright test --config playwright.resilience.config.ts"` and `"test:e2e:resilience": "cross-env E2E_NETWORK=localhost yarn test:e2e:blockchain:build && yarn test:e2e:resilience:run"`.
- [ ] **Step 2** — Add `playwright/e2e/tests/resilience/**` to the file globs in `scripts/lint-e2e-harness.mjs`.
- [ ] **Step 3 — Verify** `yarn lint:e2e` passes over an empty resilience dir; `yarn test:e2e:resilience:run --list` resolves.
- [ ] **Step 4 — Commit** `chore(resilience): scripts + e2e-harness lint scope`.

### Task 0.5: Env-override seams for hardcoded hosts + timing knobs (enabling product changes)

**Files:** Modify `src/lib/agglayer/constant.ts` (AGGLAYER_BRIDGE_API), `src/lib/prices/binance.ts` (base URL), `src/lib/miden/back/sync-manager.ts` (SYNC_TIMEOUT_MS / BACKOFF_MS / MAX_CONSECUTIVE_SYNC_FAILURES).

**Interfaces:** Produces env-overridable hosts (`agglayer`, `binance` fault targets become real) + shrinkable sync timing under the E2E build.

- [ ] **Step 1 — Unit test**: `binance.ts` uses an overridable base URL; `agglayer` constant reads an override; sync constants read an env override with the production value as default. (Jest, mock `import.meta.env`/`process.env`.)
- [ ] **Step 2 — Run → FAIL.**
- [ ] **Step 3 — Implement** narrow overrides mirroring `effective-endpoints.ts` (a single `getEffective*` accessor each; production default unchanged when unset). Vite-define the new env vars in the relevant configs; guard reads so a missing define doesn't throw (extension bundle has no `process`).
- [ ] **Step 4 — Run → PASS** + `yarn ts`.
- [ ] **Step 5 — Commit** `feat(resilience): env-overridable agglayer/binance hosts + sync timing knobs`.

### Task 0.6: CI workflow `e2e-resilience.yml`

**Files:** Create `.github/workflows/e2e-resilience.yml`.

- [ ] **Step 1** — Copy `pr-e2e-local.yml` verbatim, then change: `on:` → `push: {branches: [main]}` + `workflow_dispatch` + `schedule: [{cron: '0 5 * * *'}]`; drop the block-cadence matrix (single default-timing leg); bring up guardians too (`docker compose … --profile guardian --profile guardian-switch up --wait`); run `xvfb-run -a yarn test:e2e:resilience:run --retries=0`; job `name: infra-resilience-e2e (chrome)`; `timeout-minutes: 60`.
- [ ] **Step 2 — Validate** YAML (`yq . .github/workflows/e2e-resilience.yml`) and that the referenced scripts/config exist.
- [ ] **Step 3 — Commit** `ci(resilience): run the fault-injection suite on push:main + nightly`.

### Task 0.7: Foundation proof — one RED→GREEN + one immediate-GREEN guard

**Files:** `playwright/e2e/tests/resilience/prover-fallback.spec.ts` (guard, scenario 15).

- [ ] **Step 1** — Write scenario 15 (prover 502 → local fallback): arm `{target:'prover', mode:'status500'}` (or `abort`), send, assert tx completes AND `__PROVE_TIMINGS__` shows `path='delegate'` then a local-fallback, AND the prover connectivity banner shows then auto-clears.
- [ ] **Step 2 — Run → EXPECT GREEN** (this path is already handled — `proveWithFallback`). If RED, the fallback regressed → investigate before proceeding.
- [ ] **Step 3 — Commit** `test(resilience): regression guard — remote-prover outage falls back to local`.
- [ ] Gap-1 (Task 1.1) serves as the first RED→GREEN foundation proof.

---

## PHASE 1 — Critical (fund loss / correctness)

### Task 1.1 — Gap 1: incoming private-note never silently dropped (scenarios 1 & 2)

**Files:** `playwright/e2e/tests/resilience/note-import-blip.spec.ts`, `note-import-deadletter.spec.ts`; Modify `src/lib/miden/activity/notes.ts:55-90`, `src/lib/miden/back/dapp.ts:922`, `src/lib/miden/back/main.ts:143`; Create `src/lib/miden/note-deadletter.ts` + `.test.ts`.

- **Fault:** `{target:'transport'|'node', path:'import', mode:'failFirstN', count:3}` (blip), then `mode:'status500'` sustained (dead-letter).
- **Assert (best-practice):** after a 3-tick blip the note is NOT dropped — it imports on recovery and becomes consumable (balance reflects it); no `Dropping queued note` terminal drop. Under sustained failure the note lands in the **new dead-letter store** with a user-visible "couldn't import incoming note" indicator (never a silent `logger.error`). dApp/manual import survive a single blip (retry/queue, not lost).
- **Fix direction:** replace the iteration-count `MAX_IMPORT_ATTEMPTS` with wall-clock-bounded exponential backoff; classify transient-vs-malformed; on final give-up call `noteDeadletter.add(...)` + raise a connectivity/indicator signal; route dApp (`dapp.ts`) and manual (`main.ts`) imports through the same retry/queue path. New `note-deadletter.ts` = durable store (chrome.storage) with `add/list/retry/clear`, defensively wrapped.
- Follow the TDD micro-loop. **Commit** `fix(resilience): never silently drop an incoming private note`.

### Task 1.2 — Gap 2: idempotent Retry / node-verified completion for send/swap (scenarios 3 & 4)

**DECISION (revisited with the user): FULL PROJECT.** The double-send risk lives in
the offscreen-kill (`OperationAbortedError`) path where the submit landed but the
row was marked Failed — and that's where no anchor is captured. A naive nonce
check has a "silently never sends" false-Completed trap, so the full fix is:
(a) **anchor capture** — persist `transactionId` + `outputNoteIds` from the
execute `TransactionResult` to the row *before* the kill-prone submit/apply, so
every Failed send has a verifiable identity; (b) **`verifySendLanded(tx)`** —
sync, then match the row's `transactionId` against `getTransactionsForAccount`
and treat `TransactionStatus.getBlockNum() !== undefined` (committed) as landed;
fall back to checking the captured `outputNoteIds` on-chain; (c) **sync-side
reconciliation** — flip a landed-but-Failed send to Completed; (d) **requeue** —
`requeueFailedTransaction` calls `verifySendLanded` first (landed → Completed, no
resend; not-landed → resubmit; unknown → funds-safe, no blind resubmit).
**Verification note:** whether the SDK's local tx list materializes a
killed-but-landed tx after sync is SDK behavior that must be confirmed against the
running localnet stack — this fix's e2e (scenario 3) is the authority; unit tests
cover the branch logic with a mocked client.


**Files:** `playwright/e2e/tests/resilience/send-submit-lost.spec.ts`, `send-retry-idempotent.spec.ts`, `apply-after-submit-confirmed.spec.ts`; Modify `src/lib/miden/transaction/retry.ts`, `.../cancel.ts` (add a send/swap analogue of `verifyConsumeLanded`), `.../transaction/index.ts:1361-1454` (`ApplyTransactionAfterSubmitFailed` path).

- **Fault:** submit lands then result is lost — `{target:'node', path:'submit', mode:'hang'|'abort'}` armed to fire AFTER the CLI-counterparty confirms the tx on-chain; plus the harness hook for `ApplyTransactionAfterSubmitFailed` (Task 0.1 `malformedBody` on the apply read, or the `playwright/`-level hook if unreachable).
- **Assert:** an ambiguous post-submit abort is reconciled against the node (landed→Completed, not-landed→Failed), never guessed. Manual Retry performs a node landed-check first and does NOT broadcast a second send when the first landed (balance moves exactly once; nullifier consumed once). `ApplyTransactionAfterSubmitFailed` shows `confirming` until sync verifies commitment, then Completed — or Failed if it never lands.
- **Fix direction:** add `verifySendLanded(tx)` (nullifier/nonce landed-check mirroring `verifyConsumeLanded`); `requeueFailedTransaction` calls it for send/swap before resetting to Queued (landed → mark Completed, no resend); replace the optimistic `→Completed` at `index.ts:1361` with a confirm-then-complete.
- **Commit** `fix(resilience): node-verified idempotent retry for send/swap (no double-send)`.

---

## PHASE 2 — High (misleading / stuck state)

### Task 2.1 — Gap 3: private-send delivery state, not false "Sent" (scenario 6)
**Files:** spec `ntl-delivery-pending.spec.ts`; Modify `src/lib/miden/transaction/complete.ts:464`, `src/lib/miden/activity/connectivity-state.ts` (+`ntl` category), tx row type.
- **Fault:** `{target:'transport', mode:'status500'|'hang'}`. **Assert:** row shows `delivery pending` (not bare `Sent`); wallet-layer relay retry with backoff; `ntl` connectivity indicator; a never-delivered send is reconciled/demoted, not shown delivered. **Commit** `fix(resilience): private-send delivery state + NTL retry`.

### Task 2.2 — Gap 4: positions outage ≠ $0 portfolio (scenario 5)
**Files:** spec `positions-outage.spec.ts`; Modify `src/lib/epoch/positions.ts:172`, `src/screens/earn-flow/EarnPositions.tsx`, `.../useEarnPositions.ts`.
- **Fault:** `{target:'positions', mode:'status500'|'connectionRefused'}`. **Assert:** UI shows "couldn't load positions — retry", never "0 deposits / no positions"; last-good shown carries a stale badge; request timeout added. **Commit** `fix(resilience): positions outage shows error, not empty portfolio`.

### Task 2.3 — Gap 5: app-wide connectivity + staleness (scenario 7)
**Files:** spec `connectivity-app-wide.spec.ts`; Modify `src/components/ConnectivityIssueBanner.tsx`, `src/app/App.tsx`, money surfaces (Home/Send review/Swap/History).
- **Fault:** `{target:'node', path:'SyncState', mode:'connectionRefused'}` sustained past the breaker (timing-knobbed). **Assert:** connectivity indicator + "last synced Xs ago" cue appear on Home/Send/Swap (not only Explore); balances marked stale. **Commit** `fix(resilience): surface connectivity + staleness app-wide`.

### Task 2.4 — Gap 6: background tx failure notifies (scenario 8)
**Files:** spec `bg-failure-notify.spec.ts`; Modify `src/lib/extension/notifications.ts`, `src/lib/mobile/native-notifications.ts`, the tx-failure emit site.
- **Fault:** `{target:'node', path:'submit', mode:'status500'}` + prover `status500` (force terminal failure) on a background auto-consume while off the generating screen. **Assert:** a toast/OS-notification/badge fires for the failed tx, symmetric with the received-note path. **Commit** `fix(resilience): notify on background transaction failure`.

### Task 2.5 — Gap 7: startup RPC blip self-heals (scenario 9)
**Files:** spec `startup-rpc-blip.spec.ts`; Modify `src/lib/miden/sdk/miden-client.ts:247`.
- **Fault:** node down at first `MidenClient.create` (`connectionRefused`), then recover. **Assert:** init retries with backoff and succeeds; the singleton is not poisoned into a permanently-rejected promise (no reload needed). **Commit** `fix(resilience): self-heal poisoned client singleton on startup blip`.

### Task 2.6 — Gap 8: AggLayer indexer outage surfaced + reconcile (scenario 10)
**Files:** spec `agglayer-indexer-outage.spec.ts`; Modify `src/lib/agglayer/use-bridge-tracker.ts:37`, `src/lib/agglayer/constant.ts` (host override from Task 0.5).
- **Fault:** `{target:'agglayer', mode:'status500'|'hang'}`. **Assert:** poll times out → retryable error (not eternal "Claim Pending"); a stalled `delivering` bridged-receive has a reconcile path so native ETH is recoverable. **Commit** `fix(resilience): surface AggLayer outage + reconcile stalled delivery`.

### Task 2.7 — Gap 9: one-shot RPC reads time out + reclaim fallback (scenarios 11 & 12)
**Files:** specs `oneshot-rpc-timeout.spec.ts`, `reclaim-gate-rpc-wedged.spec.ts`; Modify `src/lib/miden-chain/native-asset.ts:56`, `src/lib/epoch/chain.ts:11`, `src/lib/miden/metadata/fetch.ts:57`, `src/app/templates/history/BridgeClaimSection.tsx:166`.
- **Fault:** `{target:'node', path:'GetBlockHeader'|'GetAccount', mode:'hang'}`. **Assert:** each one-shot read times out (no infinite hang) + one retry; reclaim gate falls back to local synced chain height or shows "couldn't check reclaim eligibility, retry" (never silently hides the button); deposit/Fast-send review shows a typed "network unavailable, retry" (not a raw string), re-enabled after recovery. **Commit** `fix(resilience): timeouts + reclaim fallback for one-shot RPC reads`.

---

## PHASE 3 — Medium / Low + regression guards

### Task 3.1 — Gap 10: faucet partial-success + bounded PoW (scenarios 13 & 14)
**Files:** spec `faucet-partial-success.spec.ts`, `faucet-timeout-pow.spec.ts`; Modify `src/lib/wallet-prompts.ts:296`, `src/lib/miden-chain/faucet-api.ts:22-64`.
- **Fault:** `{target:'faucetMiden', mode:'status429RetryAfter'}` + Forkchoice 200; separately faucet `hang` and `target=0` malformed challenge. **Assert:** per-source status; Retry re-mints ONLY the failed source; succeeded source not double-minted; `Retry-After` honored; fetch timeout; PoW bounded/cancellable and off the UI thread. **Commit** `fix(resilience): faucet per-source retry + bounded PoW`.

### Task 3.2 — Gap 15: guardian structural ops survive 5xx/429 (scenarios 17 & 18) + guardian category
**Files:** spec `guardian-structural-degraded.spec.ts`, `guardian-outage-signal.spec.ts`; Modify `src/lib/miden/guardian/serialize.ts:141`, `src/lib/miden/transaction/index.ts:531`, connectivity-state (+`guardian` category).
- **Fault:** `{target:'guardianA', path:'delta'|'configure', mode:'status429RetryAfter'|'status500'}` on a switch-guardian/replace-hot-key; and `status500` during guardian-account create/send. **Assert:** structural op retried honoring `Retry-After` (waiting state, not "Failed to switch guardian"); create surfaces "guardian unavailable, retry"; ongoing outage raises a `guardian` connectivity indicator. **Commit** `fix(resilience): guardian structural ops tolerate 5xx/429 + outage signal`.

### Task 3.3 — Gap 16 (guard #16) + gap 19 (guard): guardian 409 & canonicalizing eventual success
**Files:** spec `guardian-409-retry.spec.ts` (guard), `guardian-canonicalizing.spec.ts` (guard).
- **Fault:** `conflictPendingDelta`; `nonceMismatch`→`canonicalizing`. **Assert (expect GREEN):** `withGuardianConflictRetry` waits it out and the tx completes; the two-stage sync retry + one re-register resolves nonce-lag to Completed, no false failure. If RED → regression, fix. **Commit** `test(resilience): regression guards — guardian 409 + canonicalizing eventual success`.

### Task 3.4 — Gap 11: ErrorBoundary Try Again + offline subscribe (part of scenario 23)
**Files:** spec `error-boundary-recovery.spec.ts`; Modify `src/app/ErrorBoundary.tsx:95`.
- **Fault:** induce a render crash (infra-triggered) + toggle offline. **Assert:** `Try Again` resets the boundary and re-inits the client (dead control now works); the boundary subscribes to online/offline (not one-shot `navigator.onLine`); offline hint shown. **Commit** `fix(resilience): wire ErrorBoundary Try Again + offline subscription`.

### Task 3.5 — Gap 23: offline detection distinct from node-down (scenario 23)
**Files:** spec `offline-vs-node-down.spec.ts`; Modify connectivity classification (`src/lib/miden/activity/connectivity-classify.ts`).
- **Fault:** `context.setOffline(true)` during the sync loop. **Assert:** banner shows `network/offline` category (not mislabeled `node`); recovers on reconnect. **Commit** `fix(resilience): distinguish offline from node-down`.

### Task 3.6 — Gap 20: onboarding failure shows retryable error (scenario 20)
**Files:** spec `onboarding-node-down.spec.ts`; Modify `src/app/pages/Welcome.tsx:419`, `src/lib/miden/back/account.ts:235`.
- **Fault:** `{target:'node', mode:'connectionRefused'}` (and guardian `status500`) during create/restore. **Assert:** typed connectivity error + Retry renders in Welcome (`recoveryError` wired); clean retry succeeds; no orphaned account row after a mid-create failure. **Commit** `fix(resilience): onboarding shows retryable error, no orphaned account`.

### Task 3.7 — Gap 13: add-account never mints empty wallet on a blip (scenario 21)
**Files:** spec `add-account-node-blip.spec.ts`; Modify `src/lib/miden/back/vault.ts:795`.
- **Fault:** `{target:'node', mode:'status500'|'abort'}` during the own-mnemonic existence probe. **Assert:** restore aborts with "couldn't reach network" (retryable); does NOT create a fresh empty account. **Commit** `fix(resilience): add-account discriminates network error from on-chain miss`.

### Task 3.8 — Gap 14: sync watchdog truly cancels + backoff (scenario 22)
**Files:** spec `wedged-sync-frees-lock.spec.ts`; Modify `src/lib/miden/back/sync-manager.ts:124`, `src/lib/miden/front/useSyncTrigger.ts:127`.
- **Fault:** `{target:'node', path:'SyncState', mode:'hang'}` past the (knobbed) watchdog while a send needs the WASM lock. **Assert:** the wedged sync is actually cancelled / offscreen client killed so the mutex frees and the send proceeds; exponential backoff + jitter; mobile loop gets a watchdog + breaker. **Commit** `fix(resilience): cancel wedged sync so proving isn't starved`.

### Task 3.9 — Gap 16(prices) & Gap 17(storage) (scenarios 24 & 25)
**Files:** specs `prices-unavailable.spec.ts`, `storage-write-failure.spec.ts`; Modify `src/lib/prices/binance.ts:70`, `src/lib/miden/back/sync-manager.ts:326`.
- **Faults:** `{target:'binance', mode:'status500'}`; injected `chrome.storage.local.set` rejection (harness hook). **Assert:** portfolio shows "prices unavailable" (not silent $1); the sync indicator does NOT clear to "up to date" on a persist failure, and a persistent failure escalates a cue. **Commit** `fix(resilience): prices-unavailable cue + no false-freshness on storage failure`.

---

## Finalization

### Task 4.1 — CHANGELOG + full-suite green + lint gates
- [ ] Add one CHANGELOG entry under the correct `(TBD)` section (verify latest release tag first).
- [ ] Run `yarn ts`, `yarn lint`, `yarn lint:i18n`, `yarn lint:e2e`, `yarn test` (unit) — all green.
- [ ] Run the full `yarn test:e2e:resilience` against the local stack — all 25 specs green; confirm the 22 gap-specs' RED→GREEN transitions are captured in commit history.
- [ ] **Commit** `docs: changelog for infra-resilience e2e suite`.

---

## Delivery status (as of 2026-08-14)

**Done, verified, committed (full unit suite green: 529 suites / 7,414 tests; tsc + lint:e2e clean):**
- **Harness foundation** — generalized fault engine (`network-faults.ts`, 18 unit tests); dedicated config + base exclusion; package scripts; `e2e-resilience.yml` (push:main + nightly + dispatch). **Key discovery + fix:** `context.route` cannot reach node/prover/transport gRPC-web (it runs in the SW + the SDK's `web-client-methods-worker`), so a **fetch-layer fault injector** was built (`fetch-faults.ts` + the wrapper in `network-capture.ts`), with reliable arming that skips the parked rayon WASM workers. **Seam smoke passes against the live localnet stack** — the seam is proven to fault real node operations.
- **Gap 1** (critical) — silent note-drop → wall-clock retry + backoff + dead-letter store + dApp/manual funnel. 18 tests.
- **Gap 2** (critical) — double-send → `verifySendLanded` + node-verified idempotent Retry (`getTransactionCommitState`). 12 tests. (Remaining for the FULL project: anchor-capture-before-submit for the offscreen-kill no-id case + sync-side reconciliation — mobile/offscreen is out of e2e scope; the inline/default path is covered.)
- **Gap 7** (high) — client singleton self-heals after a startup RPC failure. Test.
- **Gap 9** (high) — one-shot RPC reads get a timeout + retry (`rpc-timeout.ts`). 3 tests.
- **Gap 11** (med) — ErrorBoundary Try Again wired + live offline subscription. Test.
- **Gap 13** (med) — add-account discriminates node-unreachable from on-chain miss (extends shipped #629). Mirrors the tested spawn guard.
- CHANGELOG entries.

**Remaining (roadmap — most are UI/UX-coupled or larger, several need a UX decision):**
- **Gap 3** (NTL delivery-state chip), **4** (positions error state vs $0), **5** (app-wide connectivity + staleness — needs banner placement + threshold decisions), **6** (background-failure notification — needs notification-style decision), **16** (prices "unavailable" cue) — each spans data + store + UI layers and involves a UX choice.
- **Gap 8** (AggLayer poll timeout is easy; the stalled-delivery reconcile is larger), **10** (faucet per-source retry + bounded PoW + timeout — clean logic, unit-testable), **14** (sync watchdog *true* cancellation — hard: the SDK sync isn't cheaply abortable), **15** (guardian 5xx/429 for structural ops + `guardian` connectivity category), **17** (storage false-freshness — couples to the SyncCompleted/spinner semantics).
- **Per-gap browser e2e specs** — the seam is proven; each gap's e2e (arm fault → assert graceful behavior) is written against the validated harness. The 3 regression-guard specs (#15/#16/#19) similarly.

### Update — browser e2e specs delivered + a pivotal fetch-seam finding

Delivered, each verified live against the localnet stack and made **falsifiable** (the fault-fired half fails if the fault doesn't actually bite, so none can be a false green):

- `node-outage-recovery` — under a node read outage, a note minted while offline is undiscoverable (proves the fault bit); after reconnect the wallet catches up and conserves both notes exactly.
- `claim-under-outage-recovery` — a claim during a node outage does not strand funds; the claimed balance is proven spendable **on-chain** (sent to B, B receives). *Finding #2 investigated → NOT a gap.*
- `guardian-conflict-retry` (guard #16) — co-signed **send** survives a transient `conflict_pending_delta` (409); `guardianFaultHits()` proves it fired.
- `guardian-switch-transient-5xx` (gap 15) — **switch-guardian** survives a transient 5xx on the `/configure` register call; endpoint ends on B. *Not a gap — `registerOnGuardianWithRetry` covers it.*
- `guardian-consume-transient-5xx` — co-signed **consume** survives a transient guardian 5xx; vault settles exactly.
- Added `guardianFaultHits()` to the fault controls + wallet page object so every guardian-fault spec self-verifies the fault fired.

**PIVOTAL FINDING — the fetch seam faults only the node READ path.** Verified the hard way (external ground truth, not just green tests): the delegated **prover**, the transaction **submit**, and **note-transport delivery** all use a non-`fetch` gRPC-web transport the evaluate-installed wrapper cannot retrofit — a prover fault leaves the container still proving, a consume submitted under a node fault still lands on-chain, and a private note is still delivered under a recipient transport fault (zero requests seen at the fetch layer). Only node SyncState/GetAccount/GetBlockHeader reads go through the wrapped `fetch` and genuinely fault (they log `INJECTED:<mode>`). Two false-green specs (prover-fallback, transport-delivery) were written, caught, and deleted. Consequence: the original design's assumption that node/prover/transport are all fetch-faultable holds **only for node reads**; prover / submit / transport-delivery / total-node-partition scenarios need **infra-level faulting** (`docker pause <svc>` / disconnect the container network), which is the natural next harness increment. Guardian (context.route) and node-read (fetch) are the two working seams today. See the FIDELITY BOUNDARY block in `harness/fetch-faults.ts`.

### Update — remaining gap FIXES landed (product changes + jest, not e2e)

Since the e2e/guardian work, the remaining CLEAN-LOGIC gaps were fixed at the product layer with jest coverage (the fetch/guardian seams can't reach these, so they're unit-tested, not e2e):

- **Gap 10** (faucet) — per-source retry so Retry re-mints only the FAILED source (no double-mint), fetch timeout, honor `Retry-After`, and a wall-clock deadline on the PoW solve (a `target=0` challenge can't spin forever). `faucet-api.ts` + `wallet-prompts.ts` + tests.
- **Gap 8** (AggLayer poll) — both bridge-status requests bounded by an AbortController timeout so a silent indexer fails the poll tick and retries instead of a wedged "Claim Pending". (The larger stalled-delivery reconcile is still deferred.) `agglayer/status.ts` + test.
- **Gap 14** (sync backoff) — the circuit breaker now backs off EXPONENTIALLY with jitter (capped 5 min) instead of a fixed 30s, extracted as the pure, unit-tested `computeSyncBackoffMs`. (True SDK-sync cancellation is still deferred — the SDK sync isn't cheaply abortable, as the code notes.) `sync-manager.ts` + test.
- **Gap 4** (positions) — a failed positions load now shows a retryable "couldn't load your positions" state instead of a misleading empty "$0 / no positions", while keeping last-good data on a transient error. `useEarnPositions.ts` + `EarnPositions.tsx` + i18n + tests.

Full jest suite green (535 suites / 7469 tests) after these.

**Still open — genuinely UX/design-coupled (need the UX owner; each touches a shared/core surface e2e can't reach):**
- **Gap 3** (private-send delivery-state chip) — new "delivery pending vs Sent" state on send rows.
- **Gap 5** (app-wide connectivity + "last synced Xs ago") — the connectivity banner exists but renders only on Explore; making it app-wide is a layout decision, and the staleness cue is a new UI element.
- **Gap 6** (background tx-failure notification) — needs the notification-style decision (toast / OS notification / badge), symmetric with the received-note notification.
- **Gap 16** (prices "unavailable" cue) — the shared `Balance` render-prop total can't distinguish a price-feed outage (mapped tokens fall to the $1 default) from unmapped-token defaults without a store flag + a display treatment that the UX owner should choose.
- **Gap 17** (storage false-freshness) — the code deliberately fires `SyncCompleted` on a persist failure (gating it would just hang the spinner); showing "synced but not saved" distinctly is a spinner-semantics/UX decision.

These are good follow-up PRs; each should pair with the UX owner on the banner/notification/chip/stale-badge design.

## Self-Review

**Spec coverage:** every ranked gap 1–17 maps to a task (g1→1.1, g2→1.2, g3→2.1, g4→2.2, g5→2.3, g6→2.4, g7→2.5, g8→2.6, g9→2.7, g10→3.1, g11→3.4, g12→3.6, g13→3.7, g14→3.8, g15→3.2, g16→3.9, g17→3.9); all 25 scenarios map to a spec (guards 15/16/19 → Tasks 0.7/3.3). Harness/config/CI/lint from the spec → Phase 0. Env-override seams + timing knobs → Task 0.5. Mobile explicitly out of scope (spec non-goal).

**Placeholder scan:** the per-gap "fix direction" is intentionally a precise change specification, not literal pre-written code, because these are TDD bug-fixes whose minimal fix is written against the real cited code during the RED→GREEN cycle (pre-guessing would be speculative and lower-quality). Every task names exact files, exact fault, and the exact best-practice assertion — the engineer has no ambiguity about WHAT to build or how to verify it. Shared TDD steps are defined once (DRY) and referenced.

**Type consistency:** `armNetworkFault`/`NetworkFaultPolicy`/`NetworkFaultTarget`/`NetworkFaultMode` used consistently across Tasks 0.1, 0.2, and every gap task; `verifySendLanded` (new, Task 1.2) mirrors the existing `verifyConsumeLanded`; the fault-mode enum in the arming API matches the modes implemented in Task 0.1.
