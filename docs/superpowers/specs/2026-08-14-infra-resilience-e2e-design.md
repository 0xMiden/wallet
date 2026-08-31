# Infra-Resilience E2E Harness — Design

Date: 2026-08-14
Branch: `feat/infra-resilience-e2e` (off `origin/main` @ `562b62421`)
Status: awaiting approval

## Goal

Build a **local, fault-injecting E2E suite** that simulates every piece of wallet
infrastructure failing / flaking / returning transient errors, and asserts the
wallet degrades and recovers **gracefully** by industry best practice. The suite
runs on pushes to `main`.

This is explicitly **not** a green-tests-for-current-behavior exercise. For each
scenario the test encodes the *best-practice* behavior; where the wallet does not
meet it today, we **fix the product** and leave the passing test behind as a
permanent regression guard.

North-star definition of "graceful" (the assertion vocabulary):

- **No silent failure** — every infra failure produces a user-visible signal.
- **No fund loss / no fund-loss-shape** — funds are never dropped, double-spent,
  or made unrecoverable; ambiguous state is reconciled against the chain, never
  guessed.
- **No misleading state** — an outage is never rendered as "you have $0 / no
  positions / delivered / up-to-date". Stale data is labeled stale.
- **Bounded, cancellable waits** — no unbounded hang; every network wait has a
  timeout; wedged operations are cancelled, not leaked.
- **Retry with backoff** — transient faults self-heal via bounded exponential
  backoff (with jitter), not fixed-interval thundering herd, and not iteration
  counters that a fast blip can exhaust.
- **Idempotent recovery** — a retry of an operation that already landed is a
  no-op, never a double-submit.
- **Correct offline handling** — offline is detected and distinguished from
  node-down; recovery on reconnect.

## Non-goals

- **Mobile (iOS/Android) fault injection.** The fault seams (`context.route`,
  the localnet docker stack) are Chrome/desktop-only; mobile guardian traffic
  goes through `CapacitorHttp` and native proving, which `context.route` cannot
  reach. Mobile fault coverage needs an OS-level proxy / native shim and is a
  documented follow-up. Fund-loss-critical paths are covered on Chrome first.
- **Live-network testing.** This suite is fully hermetic (localnet only).
- Changing the underlying SDK/node. Fixes live in the wallet.

## Decisions locked with the requester

1. **Scope:** full sweep in one program — harness + all 17 gaps + all 25
   scenarios, no mid-way checkpoint.
2. **CI trigger:** `push: [main]` + `workflow_dispatch` + nightly `schedule`
   (post-merge signal; not a pre-merge PR gate).
3. **Double-send fix (gap 2):** full node-authoritative landed-check for
   send/swap + idempotent Retry (fall back to the interim guard only if it
   balloons; if so, surface that before deciding).

## Infra dependency inventory (what the suite faults)

| # | Dependency | Local double | Fault seam |
|---|---|---|---|
| 1 | Miden node gRPC — sync/state | localnet sequencer `:57291` | proxy/route |
| 2 | Miden node gRPC — submit proven tx | `:57291` | proxy/route + harness hook |
| 3 | Miden node gRPC — one-shot reads (block header, account) | `:57291` | proxy/route |
| 4 | Remote/delegated prover | localnet tx-prover `:50052` | proxy/route |
| 5 | Note Transport Layer (NTL) relay | note-transport-service `:57292` | proxy/route |
| 6 | Guardian / multisig operator HTTP | OZ guardian `:3000`/`:3001` | `context.route` (existing) |
| 7 | Epoch Positions service | fake-epoch-positions `:8549` | `context.route` |
| 8 | Epoch Allocator service | fake-epoch-allocator `:8548` | `context.route` |
| 9 | EVM JSON-RPC | Anvil `:8545` | Anvil program / route |
| 10 | AggLayer bridge indexer | **hardcoded host** | route + **new env-override seam** |
| 11 | Faucet (Miden REST + Forkchoice) | route-mocked | `context.route` |
| 12 | Binance price API | **hardcoded host** | route + **new env-override seam** |
| 13 | `chrome.storage.local` (SW→popup) | in-process | harness hook |
| 14 | `navigator.onLine` / network layer | — | `context.setOffline` |

## Ranked resilience gaps → best-practice fix

Numbering follows the audit's severity ranking. Each fix is verified RED (gap
reproduces) before the fix, GREEN after.

**Critical (silent fund loss / correctness):**

1. **Incoming private note silently dropped** after 3 loop-tick failures
   (`notes.ts:64-80`); dApp (`dapp.ts:922`) and manual (`main.ts:143`) import
   have zero retry. **Fix:** classify transport-vs-malformed; retry transient
   errors with **wall-clock-bounded** exponential backoff (not iteration count);
   on final give-up persist to a **new dead-letter store** and surface a
   "couldn't import incoming note" indicator. Add retry+queue to dApp/manual
   import. (Note: existing `note-quarantine.ts` is a *simulation-hiding*
   mechanism, unrelated — the dead-letter store is new.)
2. **Manual Retry on a Failed send/swap can double-send** — `requeueFailedTransaction`
   (`retry.ts`) resets to Queued with no on-chain check; only consume has
   `verifyConsumeLanded` (`cancel.ts:240`). **Fix:** node-authoritative landed
   check for send/swap before resubmit; idempotent Retry (landed → mark Completed,
   no resend); never mark Completed without on-chain confirmation
   (`ApplyTransactionAfterSubmitFailed` must confirm, not optimistically assume).

**High (misleading / stuck state):**

3. **Private send shows "Sent" even when relay failed** (`complete.ts:464`
   swallows). **Fix:** per-tx delivery state (relayed/pending/failed),
   "delivery pending" chip, wallet-layer relay retry with backoff, add an `ntl`
   connectivity category, reconcile a never-delivered send.
4. **Positions outage renders as $0 portfolio** (`positions.ts:172` returns
   `{items:[],error}`; `EarnPositions.tsx` never reads `error`). **Fix:**
   distinguish "couldn't load — retry" from genuine empty; stale badge when
   `keepPreviousData` masks a live outage; request timeout.
5. **Connectivity banner only on Explore** (`Explore.tsx:253`). **Fix:**
   app-wide connectivity indicator + "last synced Xs ago" staleness cue on money
   surfaces (Home, Send review, Swap, History).
6. **Background tx failure is fully silent** — no toast/badge/notification.
   **Fix:** failed-tx notification/badge symmetric with the received-note path.
7. **Startup RPC blip poisons the client singleton** (`miden-client.ts:247`
   never resets the rejected init promise). **Fix:** reset memoized init promise
   on failure + retry `create()` with backoff so a transient startup outage
   self-heals without reload.
8. **AggLayer bridge outage → eternal "Claim Pending"** (`use-bridge-tracker.ts:37`
   silent 8s poll forever); stalled native-ETH delivery unrecoverable. **Fix:**
   timeout + surfaced error on indexer polling; reconcile anchor for stalled
   Slow-bridge delivery; make the indexer host env-overridable.
9. **One-shot RPC reads have no timeout** (`native-asset.ts`, `epoch/chain.ts`,
   `metadata/fetch.ts`) → accept-then-blackhole hangs forever; reclaim gate
   silently never opens. **Fix:** per-call timeout + one retry; reclaim gate
   falls back to local synced chain height; "couldn't check eligibility, retry"
   message.

**Medium / Low:**

10. **Faucet partial success = total failure** (`wallet-prompts.ts:296` throws on
    any partial); retry double-mints the succeeded source; unbounded PoW loop on
    UI thread; no timeout. **Fix:** per-source status; retry only failed source;
    fetch timeout; bounded/cancellable PoW off the UI thread; honor `Retry-After`.
11. **Dead `Try Again` button** (`ErrorBoundary.tsx:95` no `onClick`). **Fix:**
    wire it to reset the boundary + re-init the client; subscribe to online/offline.
12. **Onboarding create/import failure is a dead spinner** (`Welcome.tsx:419`
    `recoveryError` unwired; good `PublicError` discrimination thrown away).
    **Fix:** wire `recoveryError`; typed retryable error; best-effort pre-create
    sync; create-time guardian register via retry.
13. **add-account own-mnemonic swallows any error → fresh empty account**
    (`vault.ts:795`, vs the correct discrimination at `vault.ts:478`). **Fix:**
    apply `isLikelyNetworkError` discrimination — abort+retry on connectivity
    error, only create-fresh on a definitive on-chain miss.
14. **Sync watchdog is a paper timeout** (`sync-manager.ts:124`) that never
    cancels the wedged RPC nor frees the global WASM mutex; mobile loop has no
    watchdog/backoff. **Fix:** true cancel/abort (offscreen-client kill) so the
    mutex frees; exponential backoff + jitter; mobile loop watchdog + breaker.
15. **Guardian structural ops terminal-fail on 5xx/429** (`serialize.ts:141`
    handles only 409; structural ops excluded from 429 requeue). **Fix:** retry
    transient 5xx + rate-limit-aware 429 for structural ops; add `guardian`
    connectivity category; surface persistent guardian outage.
16. **Price feed failure silently renders every token at $1** (`binance.ts:70`).
    **Fix:** "prices unavailable / values may be stale" indicator; env-overridable host.
17. **`chrome.storage.local` write failure signals false freshness**
    (`sync-manager.ts:326` warns but still broadcasts SyncCompleted). **Fix:**
    don't signal "synced" when persist failed; escalate a persistent failure.

## Test matrix (25 scenarios)

Each scenario is one spec in `playwright/e2e/tests/resilience/`. 22 assert
behavior the wallet does **not** meet today (→ product fix); 3 are
**regression guards** for paths already handled well (must be GREEN immediately
and lock the behavior in): **#15** remote-prover→local fallback, **#16** guardian
409 conflict retry, and **#19** guardian nonce-lag/canonicalizing eventual
success.

The 25 scenarios map to gaps 1–17 as follows (full text in the audit synthesis):
1→g1, 2→g1, 3→g2, 4→g2, 5→g4, 6→g3, 7→g5, 8→g6, 9→g7, 10→g8, 11→g9, 12→g9,
13→g10, 14→g10, 15→(prover, guard), 16→(guardian 409, guard), 17→g15, 18→g15,
19→(canonicalizing, guard), 20→g12, 21→g13, 22→g14, 23→g11/offline, 24→g16,
25→g17.

## Harness architecture

Built on the existing hermetic localnet stack (`playwright/e2e/local-stack/`,
`pr-e2e-local.yml`) and the two-wallet fixture (`fixtures/two-wallets.ts`).

**Fault seam — extend, don't replace.** The existing `harness/guardian-fault.ts`
installs a context-wide `context.route('**/*')` handler that already reaches
service-worker fetches (Playwright `serviceWorkers: 'allow'`), but matches
guardian origins only. Generalize it into `harness/network-faults.ts`:
`installNetworkFaults(context, targets)` matching **all** infra origins (node
`:57291`, prover `:50052`, transport `:57292`, guardian `:3000/:3001`, epoch
`:8548/:8549`, anvil `:8545`, and the env-repointed AggLayer/Binance hosts).
Armed per-spec on the wallet page object exactly like `armGuardianFault`
(`walletA.armNetworkFault({ target, mode })` / `clearFaults()`). Keep the
existing guardian modes (`status500`, `abort`, `delay`, `failFirstN`,
`conflictPendingDelta`).

**New fault modes** the matrix requires:
`connectionRefused` (`route.abort('connectionrefused')`), `hang` (never resolve
— distinct from fixed `delay`), `timeout` (`route.abort('timedout')`),
`status429WithRetryAfter`, `truncatedBody` / `malformedBody`, `slowStream`, and
guardian `nonceMismatch` / `canonicalizing` response envelopes.

**Seam choice — `context.route` first, TCP proxy only if forced.** `context.route`
reuses the existing seam, needs no new CI dependency, matches the team's
hand-rolled `node:http` fakes, reaches both the SW and the SDK page-worker, and
can produce refused/timeout/hang/malformed. A hand-rolled `node` TCP proxy is
added **only if** a specific fault (e.g. an authentic tonic-web gRPC framing
error that `connectivity-classify.ts` pattern-matches on) cannot be faithfully
reproduced via route — decided per-gap during TDD, not as a blanket dependency.
(No toxiproxy: avoids a new CI binary.)

**Two branches no network seam can reach** — `ApplyTransactionAfterSubmitFailed`
(submit genuinely landed, apply threw) and the offscreen-write-kill identity
loss. Preference order: (a) force at the network layer by letting the submit
land via the CLI counterparty then faulting the apply/read; (b) if unreachable,
a **harness-level** fault hook living in `playwright/` (like `guardian-fault.ts`),
**not** a `src/` behavior switch — honoring the repo rule "keep it a hook flag,
not a behaviour switch."

**Timing knobs.** Env-gate the sync watchdog / backoff / breaker constants
(`SYNC_TIMEOUT_MS`, `BACKOFF_MS`, `MAX_CONSECUTIVE_SYNC_FAILURES`) so breaker
tests don't wait ~90s. These are already module constants; make them read an env
override under the E2E build only.

**Enabling seams (small product changes):** narrow env-override for the two
hardcoded hosts (AggLayer indexer, Binance) mirroring the existing
endpoint-override pattern — enables both fault injection and degraded-mode
repointing. Build **without** `MIDEN_E2E_DISABLE_ENDPOINT_OVERRIDES` so node /
prover / transport can be repointed at the fault layer with zero product change.

**Assertions** read existing test hooks: `__TEST_STORE__`, `__PROVE_TIMINGS__`,
`connectivity-state` getters, IDB dumps, the transaction rows, and the rendered
DOM (banners, chips, notifications).

## CI wiring

- `playwright.resilience.config.ts` = `{...base, testDir:
  './playwright/e2e/tests/resilience', testIgnore: undefined}`.
- Add `'**/resilience/**'` to `testIgnore` in `playwright.e2e.config.ts` so the
  core PR suite doesn't also pick these up.
- `package.json`: `test:e2e:resilience:run` + a build+run `test:e2e:resilience`
  wrapper (`E2E_NETWORK=localhost`).
- `.github/workflows/e2e-resilience.yml`: `on: push:[main]` + `workflow_dispatch`
  + `schedule` (nightly). Models `pr-e2e-local.yml` docker bring-up **with**
  `--profile guardian --profile guardian-switch` (guardian faults in scope).
  Stable job `name:` (`infra-resilience-e2e (chrome)`). `timeout-minutes ~60`.
- Extend `scripts/lint-e2e-harness.mjs` (the `lint:e2e` gate) to cover the new
  specs (no conditional expect, no long bare waits, no unfalsifiable assertions).

## Methodology (per gap, TDD red→green)

1. Write the resilience spec asserting the **best-practice** behavior.
2. Run → confirm **RED** (gap reproduces). If unexpectedly GREEN, either it's a
   designated regression-guard (lock it in) or the gap was mis-described
   (re-examine before touching product code).
3. Fix the product to the best-practice target.
4. Run → confirm **GREEN**; the test stays as a regression guard.
5. One commit per gap (spec + fix); CHANGELOG one-liner for the effort.

Add focused **unit tests** for pure fix logic (classifiers, backoff, landed-check,
delivery-state machine) alongside the e2e — fast feedback and cheaper regression
coverage than a 60-min docker suite for the logic core.

## Execution phasing

- **Phase 0 — Harness foundation:** `network-faults.ts` + new modes, config,
  package scripts, `e2e-resilience.yml`, `lint:e2e` extension, env-override
  seams, timing knobs. Prove it with one RED→GREEN (gap 1) and one immediate
  GREEN regression-guard (#15 prover fallback).
- **Phase 1 — Critical:** gaps 1, 2 (+ scenarios 1–4).
- **Phase 2 — High:** gaps 3–9 (+ scenarios 5–12, plus guards 15/16/19).
- **Phase 3 — Medium/Low:** gaps 10–17 (+ scenarios 13,14,17,18,20–25).

Sequencing note: many fixes touch shared files (`sync-manager.ts`,
`transaction/index.ts`, `connectivity-state.ts`), so implementation is primarily
**sequential grouped by subsystem** to avoid conflicts; genuinely independent
gaps (faucet, prices, error-boundary) may be parallelized.

## Risks & mitigations

- **60-min docker suite is heavy.** Mitigated by timing-knob env overrides and by
  keeping logic-core coverage in fast unit tests; the e2e proves end-to-end
  gracefulness, units prove the branch logic.
- **Faithful transport errors.** If `context.route` can't reproduce a real gRPC
  framing error the classifier keys on, add a scoped node TCP proxy (per-gap).
- **Fixing 17 areas risks scope creep in product code.** Each fix is the minimal
  change to hit the best-practice assertion; no unrelated refactors. Fixes that
  turn out larger than a focused change (e.g. gap 2 node-verify, gap 8 reconcile)
  are surfaced before ballooning.
- **Flakiness.** Reuse `report-flaky-e2e.mjs`; `retries: 0` for correctness
  determinism; deterministic fault arming (`failFirstN`, explicit clear).

## Success criteria

- New hermetic resilience suite runs on `push:main` + dispatch + nightly, green.
- All 25 scenarios present; the 21 gap-scenarios each demonstrably RED before
  their fix (captured in commit history) and GREEN after.
- Every product fix meets the north-star "graceful" definition for its scenario.
- No fund-loss-shape path remains among the covered scenarios.
- `lint:e2e`, `ts`, `lint`, and unit suites stay green.
