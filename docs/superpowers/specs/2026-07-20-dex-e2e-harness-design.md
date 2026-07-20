# In-Protocol DEX (PSWAP) E2E Test Harness — Design

**Date:** 2026-07-20
**Status:** Design — pending review
**Branch:** `in-protocol-dex`
**Author:** drafted with Claude Code

---

## 1. Goal

Add a **hermetic, local-first, comprehensive** end-to-end test suite for the wallet's in-protocol DEX (PSWAP partial-swap) feature. The suite proves the real user-facing behavior: **one wallet creates a swap order through the actual UI, a second wallet takes (fills) it as a genuine counterparty, and vice-versa** — asserting on-chain settlement, both wallets' balances, the order's on-chain lineage, and the wallet's own history / order-tracking UI.

It runs on the existing **local node stack** (no live network, no external solver) and gates **every PR that touches swap code** via a path filter. Testnet/devnet and a real matching solver are explicitly **Phase 2**.

## 2. Background & constraints (established during investigation)

- **The wallet is create-and-track only.** It calls `pswapCreate` / `newPswapCreateTransactionRequest` (guardian path) and polls `pswap.lineage(orderId)`. It never fills, consumes, or cancels an order — there is **no fill/consume/cancel UI**. Filling is delegated to external solvers in production.
- **The bundled SDK (`@miden-sdk/miden-sdk@0.15.5`) has the full lifecycle.** Available and usable from the wallet's own in-page client:
  - `client.transactions.pswapCreate({ account, offer, request, type?, paybackType? })`
  - `client.transactions.pswapConsume({ account, note, fillAmount, noteFillAmount? })` — **the fill/take**; supports partial fills → remainder note.
  - `client.transactions.pswapCancel({ account, note })` and `client.pswap.cancelByOrder({ orderId })` — creator reclaim.
  - `client.pswap.lineage(orderId)` / `lineages()` / `lineagesFor(account)` → `PswapLineageRecord { orderId(), state(), currentDepth(), currentTipNoteId(), remainingOffered(): bigint, remainingRequested(): bigint }`; `PswapLineageState` = `Active | FullyFilled | Reclaimed`.
- **PSWAP is maker/taker, not auto-matching.** A PSWAP note is a resting on-chain note holding the offered asset. Two crossing orders do **not** settle themselves — settling two notes together requires a third-party matcher/solver to consume both in one tx. Therefore the realistic bilateral flow is: **A posts (maker) → B consumes/takes (taker)** via `pswapConsume`, supplying the requested asset from B's own vault. This is the genuine protocol fill, not a synthetic shortcut.
- **No runnable v0.15 solver exists publicly.** The only public matcher (`partylikeits1983/CLOB`) targets the *old* SWAPp note format and won't fill v0.15 PSWAP notes. Building/forking a matcher is real work and flaky/slow for a PR gate → deferred to Phase 2.
- **Matching is price-cross-sensitive (no oracle at protocol level).** The wallet bakes in `SOLVER_MARGIN = 0.05` (requests ~5% less value than it offers) so its notes are trivially profitable to take. An order requesting ≥ fair value simply never gets taken. This is the lever for the Phase-2 testnet workaround (create "unreasonable price" orders the testnet bot ignores, then take them ourselves).
- **The local stack is ready but ships no filler.** `playwright/e2e/local-stack/docker-compose.local.yml` (node `v0.15.0`: sequencer/RPC `:57291`, ntx-builder, tx-prover `:50052`, optional guardian profile + postgres) + `run-note-transport.sh`. Run per-PR by `.github/workflows/pr-e2e-local.yml` (`E2E_NETWORK=localhost`).
- **The two-wallet Playwright fixture already exists** (`playwright/e2e/fixtures/two-wallets.ts` → `walletA`, `walletB`, each its own extension context/vault; `midenCli`; `steps`). A→B transaction flows (`send-public.spec.ts`) are the harness's core competency.
- **E2E test hooks use a proven, zero-prod-impact pattern:** guarded by `process.env.MIDEN_E2E_TEST === 'true'` (statically replaced with `'false'` and dead-code-eliminated in production builds), installed on `globalThis`/`window`. Existing examples: `__TEST_STORE__`, `__TEST_INTERCOM__`, `__TEST_GUARDIAN_AUTH__`, `__TEST_SYNC_PAUSED__`.
- **Reference implementation** for a correct lifecycle: `0xMiden/rust-sdk` → `bin/integration-tests/src/tests/pswap_transaction.rs` (`test_pswap_full_fill_onchain`, `test_pswap_partial_fill_onchain`).

### Two blockers this design must solve

1. **Fixed token registry.** `src/lib/miden/swap/tokens.ts` hardcodes `SWAP_TOKENS` to specific `mtst1…` faucet IDs. A locally-minted CLI faucet has a **dynamic** id and won't be swap-eligible, so the create UI can't be driven hermetically without an override.
2. **No fill path in the wallet.** The counterparty take must be invoked via the SDK (there's no UI button).

## 3. Architecture

**Actors**
- `walletA`, `walletB` — real Chrome-extension contexts (existing fixture), each a distinct account/vault.
- `midenCli` — funds both wallets; extended to deploy two faucets and mint per-token.
- Local node stack — real chain (RPC, ntx-builder, prover), optional guardian profile for the multisig scenario.

**Maker/taker loop (one direction; the suite runs it both ways)**
1. Test deploys two faucets via CLI (`SWPA`, `SWPB`), mints `SWPA` to A and `SWPB` to B; both wallets sync and claim.
2. Test injects the two local faucet ids into each wallet's registry via `__TEST_SET_SWAP_TOKENS__` (see §4.1).
3. **A (real UI):** `#/swap` → select offer `SWPA` + request `SWPB` → type pay & receive amounts (typing the receive amount bypasses the external price feed) → "Review Swap" → "Swap" → success ("Swap Order Created!"). Capture `orderId`.
4. **B (taker):** B syncs, **discovers A's public PSWAP note on-chain by pair tag** (never handed the note out-of-band), then `__TEST_PSWAP_CONSUME__(orderId, fillAmount)` drives B's own client's `pswapConsume`, spending B's `SWPB`.
5. **Assertions:** A's vault −`SWPA`, A +`SWPB` (payback); B −`SWPB`, B +`SWPA`; `lineage(orderId)`: `active → filled` (or partial); A's history order-tracking card reflects the state.
6. Reverse (B maker, A taker) proves bidirectionality.

**Honesty guarantees (per user refinement):** the fill always spends wallet B's own real vault balance and requires B to discover the note via real sync + pair tag. It is a true two-wallet maker/taker settlement on the real local chain; the only non-UI element is the take being an SDK call rather than a button.

## 4. Wallet production-code changes (all `MIDEN_E2E_TEST`-gated → zero production impact)

Each change follows the existing `if (process.env.MIDEN_E2E_TEST !== 'true') return;` guard so it is dead-stripped from production bundles. A verification step (build a production bundle, grep the output for the hook symbols) is part of the plan.

### 4.1 Swap-token registry override — `src/lib/miden/swap/tokens.ts`
- Convert `SWAP_TOKENS` reads to go through a small accessor (e.g. `getSwapTokens()`), backed by a module-level mutable list defaulting to the current hardcoded registry.
- Add an E2E-gated `window.__TEST_SET_SWAP_TOKENS__(tokens: SwapToken[])` that replaces the list at runtime (after the test deploys its faucets and knows their ids/symbols/decimals).
- All existing consumers (`getSwapTokenByFaucetId`, `getSwapTokenBySymbol`, `SWAP_TOKENS` iteration in the picker, summary badge, history resolution) read through the accessor. This is the one change inside the swap feature core; it is inert in production.

### 4.2 PSWAP fill/cancel hooks — new module `src/lib/miden/swap/test-hooks.ts` (E2E-only)
- `window.__TEST_PSWAP_CONSUME__(orderId, fillAmount, noteFillAmount?)`: resolve A's PSWAP note for `orderId` from the in-page client (sync first; locate by lineage/tip note id or pair-tag scan), then call `client.transactions.pswapConsume({ account, note, fillAmount })`. Returns a serializable result (tx id, resulting balances snapshot) for the test to assert on.
- `window.__TEST_PSWAP_CANCEL__(orderId)`: `client.pswap.cancelByOrder({ orderId })` (or `pswapCancel` with the resolved note).
- Installed only under the `MIDEN_E2E_TEST` guard, imported from the app-init test-hooks path alongside the existing hooks.

*(No change to the wallet's create or tracking code — those are exercised through the real UI.)*

## 5. Harness changes (test-only, under `playwright/e2e/`)

### 5.1 `MidenCli` two-faucet extension — `playwright/e2e/helpers/miden-cli.ts`
- `createFaucet(symbol: string, decimals = 8): Promise<string>` — parameterize the currently-hardcoded TOML symbol; return the faucet id (don't overwrite a single field — track a map).
- `mint(faucetId: string, targetAddress: string, amount: bigint, noteType): Promise<void>` — explicit faucet id.
- Keep the existing retry/backoff wrapper.
- **CLI version check:** confirm the pinned `miden-client` CLI can deploy multiple faucets and mint per-id on one store (it can — single store, multiple faucets). No pswap CLI subcommand is needed (fill is via the wallet SDK hook), so the CLI does **not** need bumping for this design.

### 5.2 Page-object swap methods — `ChromeWalletPage` + `WalletPage` interface (`playwright/e2e/helpers/wallet-page.ts`)
- `createSwapOrder({ offerSymbol, requestSymbol, payAmount, receiveAmount }): Promise<{ orderId: string }>` — drives `#/swap`: `swap-flow` root, `send-token-selector.first()` / `.nth(1)` → `swap-token-<SYMBOL>` rows, `send-amount-input.first()` (pay) / `.nth(1)` (receive, typed to bypass price feed), "Review Swap" → "Swap", waits for `#/generating-transaction/*` success, reads `orderId` (from `__TEST_STORE__` / the swap tx row).
- `setSwapTokens(tokens)` — calls `__TEST_SET_SWAP_TOKENS__` via `page.evaluate`.
- `consumeSwapOrder(orderId, fillAmount)` / `cancelSwapOrder(orderId)` — call the fill/cancel hooks via `page.evaluate` (used by the *taker* wallet).
- `getSwapOrderState(orderId)` — reads the wallet's own tracked state (drives `trackOrderId`), for lineage-through-UI assertions.
- History-card assertions helper for the order-tracking card in `HistoryDetails`.

### 5.3 Specs
- `playwright/e2e/tests/swap-create-and-fill.spec.ts` — standard-account scenarios (auto-picked up by `playwright.e2e.config.ts`).
- `playwright/e2e/tests/guardian-swap.spec.ts` — the guardian scenario, named `guardian-*` so `playwright.guardian.config.ts` runs it and the standard config ignores it.
- Written against the `two-wallets` fixture and the `steps` checkpoint wrapper, mirroring `send-public.spec.ts`.

## 6. Scenario matrix (comprehensive)

| # | Scenario | Key assertions |
|---|---|---|
| 1 | **Full fill A→B** | A −offer, A +request (payback); B −request, B +offer; `lineage active→FullyFilled`; A history card "filled"; orderId derived from the note's serial felt[1] matches the SDK lineage id |
| 2 | **Full fill B→A** (reverse) | same, opposite direction — proves bidirectional maker/taker |
| 3 | **Partial fill + remainder** | B fills part → remainder PSWAP note emitted; `currentDepth+1`; `remainingOffered/remainingRequested` decrease correctly; A card "partially filled / N rounds"; proportional payback to A; a 2nd partial fill → `FullyFilled` |
| 4 | **Cancel / reclaim** | creator reclaims an unfilled order via `cancelByOrder` → offered asset returns to creator; `lineage → Reclaimed`; A card "reclaimed" |
| 5 | **Order-tracking card UI** | `HistoryDetails` card (status / fill rounds / amount filled), polled via the wallet's own `trackOrderId`, renders correctly across active→partial→filled and active→reclaimed |
| 6 | **Create-side UI guards** | same-token selection blocked; insufficient-balance blocked; "Review Swap" disabled/enabled correctly; (price-feed-down handled by typed receive amount) |
| 7 | **Guardian-account swap** | a Guardian (multisig) account creates a swap via `newPswapCreateTransactionRequest` + the custom-proposal path (persisted request bytes reused across proposal + submit); B fills it; asserts settlement + tracking — proves the distinct multisig create path |

Optional (decide during planning): **min-fill-step / below-limit rejection** — attempt a fill below `min_requested`/`min_fill_step`; protocol MASM rejects; assert the take fails and the order stays `Active`.

## 7. CI integration (path-filtered per-PR)

Extend `.github/workflows/pr-e2e-local.yml` with a **path filter** so the swap suite runs on every PR **only when swap-relevant paths change**:

- Trigger paths: `src/lib/miden/swap/**`, `src/screens/swap-flow/**`, `src/lib/miden/transaction/{index,complete,get}.ts`, `src/lib/miden/db/types.ts`, `src/app/templates/history/**` (order-tracking card), the swap specs/helpers, and the workflow itself.
- Mechanism: `dorny/paths-filter` (or `paths:` on a dedicated job) gating a `swap-e2e` step that reuses the existing local-stack bring-up (docker compose `--wait`, note-transport, build with `MIDEN_E2E_TEST=true MIDEN_NETWORK=localhost`, `xvfb-run` Playwright). The guardian scenario additionally brings up the `guardian` profile.
- Result: full comprehensive suite on swap PRs; skipped on unrelated PRs.

## 8. Phase 2 (noted, not built now)

- **Testnet/devnet:** the network auto-matcher bot will race us. Mitigation: create orders at an **unreasonable price** (request ≥ fair value) so the price-cross-sensitive solver ignores them, then take them ourselves via the hook. Confirmed viable by the matching logic.
- **Real solver scenario ("two crossing orders matched by a matcher"):** requires an actual v0.15 matcher (none runnable publicly). If pursued, a thin custom poller (discover by pair tag → `pswapConsume`) run in the stack. Note this tests the *solver's* matching, not the *wallet's* behavior, so it belongs in a separate tier.

## 9. Risks & open questions

- **R1 — network-note settlement timing (highest).** PSWAP payback and remainder notes may settle via the ntx-builder; polling/timeout tuning on the local stack is the biggest reliability unknown. **Mitigation:** an early timing spike in the plan (create+fill one order, measure settlement latency, set polls/timeouts) before building the full matrix.
- **R2 — registry override correctness.** The one production-file change in the swap core; must be provably inert in prod. **Mitigation:** production-bundle grep for the hook symbols in the plan's verification step.
- **R3 — note resolution in the fill hook.** How B reliably resolves A's note object for `pswapConsume` from `orderId` (lineage tip note id vs. pair-tag scan). **Mitigation:** the timing spike also validates the resolution path; the rust-sdk reference test shows the tag-discovery approach.
- **R4 — guardian scenario cost.** Adds guardian-profile bring-up + multisig setup; keep it a single focused scenario.
- **R5 — CLI two-faucet assumption.** Confirmed a single local `miden-client` store holds multiple faucets; verify against the pinned CLI version in the plan.

## 10. Out of scope

- Live testnet/devnet runs (Phase 2).
- A real matching solver (Phase 2).
- Mobile (iOS/Android) swap E2E — can mirror later via the existing two-simulator harness.
- Any change to the wallet's *production* swap create/track behavior (this is test infrastructure only, plus E2E-gated hooks).
