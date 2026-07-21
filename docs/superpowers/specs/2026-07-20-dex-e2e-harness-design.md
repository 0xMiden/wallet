# In-Protocol DEX (PSWAP) E2E Test Harness — Design

**Date:** 2026-07-20
**Status:** Design — revised after review
**Branch:** `in-protocol-dex`
**Author:** drafted with Claude Code

> **Revision note (post-review).** This spec was reviewed by two independent passes (a design-consistency review and an adversarial technical-feasibility review that traced every claim against `@miden-sdk/miden-sdk@0.15.5` and the repo). The Codex second-opinion path was unavailable (project lacks model access), so two internal reviews were used. Material corrections applied: the taker discovers A's note **by tag, not by lineage** (lineage only tracks a client's own notes) → the fill hook signature changed (§4.2); `orderId` is a `bigint` in Dexie (not the store) and must be stringified across `page.evaluate` (§5.2); CLI faucets have no metadata so the offer balance renders 0 unless the harness's existing metadata-injection workaround is reused, and the payback is a **public P2ID note A must claim** (§3, §4.1, §9); the CI must be a **separate path-filtered job**, never a `paths:` gate on the shared local-E2E job (§7); the settlement risk was re-framed and a **discovery+settlement spike is now the mandatory first step** (§9). Open items that genuinely require running code (swap-tag amount-sensitivity; settlement latency) are called out as spike deliverables that may reshape §4.2/§6 before the plan is written.

---

## 1. Goal

Add a **local-first, comprehensive** end-to-end test suite for the wallet's in-protocol DEX (PSWAP partial-swap) feature: **one wallet creates a swap order through the actual UI, a second wallet takes (fills) it as a genuine counterparty, and vice-versa** — asserting on-chain settlement, both wallets' balances, the order's on-chain lineage, and the wallet's own swap UI surfaces (generating-transaction badge, history row, order-tracking card).

It runs on the existing **local node stack** (no live network, no external solver) and gates PRs that touch swap code via a **dedicated path-filtered job**. Testnet/devnet and a real matching solver are explicitly **Phase 2**.

## 2. Background & constraints (verified against code + SDK)

- **The wallet is create-and-track only.** It calls `pswapCreate` / `newPswapCreateTransactionRequest` (guardian path) and polls `pswap.lineage(orderId)`. There is **no fill/consume/cancel UI**; filling is delegated to external solvers in production.
- **The bundled SDK (`0.15.5`) has the full lifecycle** (confirmed in `api-types.d.ts` / `crates/miden_client_web.d.ts`):
  - `client.transactions.pswapCreate({ account, offer, request, type?, paybackType? })` — payback defaults to **public** when unspecified.
  - `client.transactions.pswapConsume({ account, note, fillAmount, noteFillAmount? })` — the fill/take; `note` is resolved from the **consumer's own local store** (an input `Note`, not a note id); partial fills emit a remainder PSWAP note.
  - `client.transactions.pswapCancel({ account, note })` / `client.pswap.cancelByOrder({ orderId })` — creator reclaim.
  - `client.pswap.lineage(orderId)` → `PswapLineageRecord { orderId(): string(decimal), state(), currentDepth(), currentTipNoteId(), remainingOffered(): bigint, remainingRequested(): bigint }`; `PswapLineageState = Active | FullyFilled | Reclaimed`. **`lineage`/`cancelByOrder` reject a JS `number`** (u64-shaped — pass a decimal `string` or `bigint`).
- **Lineage is per-client and only covers a client's OWN created/consumed orders.** `B.client.pswap.lineage(orderId)` for an order B has not created or consumed returns **null**. → The taker **cannot** resolve A's note via lineage; it must discover by tag (below). Lineage-by-order is valid only for the creator (used in the cancel/reclaim scenario) and for the wallet's own tracking.
- **Public-note discovery requires an explicit tag subscription.** A client imports a public note on sync only if subscribed to its tag. The swap tag is derived by `buildSwapTag(noteType, offerFaucet, offerAmount, requestFaucet, requestAmount)`; register it via `client.client.tags.add(tag.asU32())` (a `NoteTag` has `asU32()` but no `toString()` — passing the object registers `"[object Object]"`). After sync, the specific note is selected by scanning the client's consumable/input notes for `serialNum().toFelts()[1] === orderId`.
- **PSWAP is maker/taker, not auto-matching.** A PSWAP note is a resting on-chain note holding the offered asset; two crossing orders never settle themselves — a third party must consume both. Hence the realistic bilateral flow is **A posts (maker) → B takes (taker)** via `pswapConsume`, spending B's own vault. No runnable v0.15 solver exists publicly → deferred to Phase 2.
- **The payback is a public P2ID note the creator must CLAIM.** It is not a network note; the **ntx-builder is not in this path**. A's requested-token balance rises only after A syncs and consumes the payback note. (Same for the remainder note the maker of a partial fill receives back into its own lineage.)
- **CLI-minted faucets have no wallet metadata → they render as balance 0.** `attachMetadataToNotes` filters out notes whose faucet lacks metadata. The harness already ships workarounds — `injectClaimableMetadata()` and `__TEST_HEX_TO_BECH32_FAUCET__` — which the swap test must reuse for both wallets' swap faucets, or the offer balance is 0 and `canProceed` is never satisfied.
- **`orderId` lives only in Dexie as a `bigint`** (`extraInputs.orderId`), not in the zustand store. It must be read via the harness's `dumpIndexedDBStore` helper and **`String()`-ed** at the `page.evaluate` boundary (Playwright can't serialize `bigint`); lineage comparisons are string-vs-string.
- **Local stack** (`playwright/e2e/local-stack/docker-compose.local.yml`, node `v0.15.0`, optional guardian profile) + `run-note-transport.sh`, driven per-PR by `.github/workflows/pr-e2e-local.yml` (a **single job** that builds the extension and runs core + guardian specs).
- **The two-wallet fixture exists** (`playwright/e2e/fixtures/two-wallets.ts` → `walletA`, `walletB`, `midenCli`, `steps`); `MidenCli` (`helpers/miden-cli.ts`) is currently single-faucet (`createFaucet()` hardcodes `TST`, one `faucetId`, `mint` uses it).
- **E2E hooks** use the `process.env.MIDEN_E2E_TEST === 'true'` guard (statically replaced with `'false'`, dead-stripped in prod). Existing: `__TEST_STORE__`, `__TEST_INTERCOM__`, `__TEST_GUARDIAN_AUTH__`, `__TEST_SYNC_PAUSED__`, `__TEST_HEX_TO_BECH32_FAUCET__`, `injectClaimableMetadata`.
- **Reference lifecycle:** `0xMiden/rust-sdk` `bin/integration-tests/src/tests/pswap_transaction.rs` (full + partial fill; Bob discovers by pair tag then consumes).

## 3. Architecture

**Actors:** `walletA`, `walletB` (real extension contexts) · `midenCli` (two faucets) · local node stack (+ guardian profile for the multisig scenario).

**Maker/taker loop (one direction; the suite runs it both ways)**
1. Deploy two faucets via CLI (`SWPA`, `SWPB`, both 8-dec); mint `SWPA` to A and `SWPB` to B.
2. Both wallets sync, **inject faucet metadata** (existing workaround) and **claim** their minted notes so real balances render.
3. Inject the two local faucet ids (as **bech32**) into each wallet's registry via `__TEST_SET_SWAP_TOKENS__` — **before the swap screen mounts** (SwapManager seeds React state from the token objects at mount).
4. **A (real UI):** `#/swap` → offer `SWPA` + request `SWPB` → type pay & receive amounts (typing the receive amount bypasses the price feed) → `swap-review-submit` → `swap-submit` → success ("Swap Order Created!"). Read `orderId` from A's Dexie (`dumpIndexedDBStore`), stringified.
5. **B (taker):** register the swap tag (`tags.add(buildSwapTag(...).asU32())`), sync, select A's note by `serialNum felt[1] === orderId`, then `__TEST_PSWAP_CONSUME__({...})` drives B's `pswapConsume`, spending B's `SWPB`.
6. **A claims the payback:** A syncs + injects metadata + consumes the payback P2ID note.
7. **Assertions:** A −`SWPA`, A +`SWPB`; B −`SWPB`, B +`SWPA`; `lineage(orderId)`: `Active → FullyFilled` (or partial); A's order-tracking card + history row + generating-transaction badge reflect the state.
8. Reverse (B maker, A taker) proves bidirectionality.

**Honesty statement (revised):** the fill spends wallet B's own real vault balance and really settles on-chain; the test conveys the `orderId` + pair parameters to B (exactly what a solver learns from the mempool/tags) — it does not hand B a note object out-of-band nor fabricate balances. B still resolves the note from its own store after a real tag-subscribed sync.

**Egress:** block/stub the external price host (`35-175-40-181.sslip.io`) deterministically (route abort in Playwright), so the "hermetic" claim holds and console isn't spammed; the typed receive amount already makes prices non-blocking for `canProceed`.

## 4. Wallet production-code changes (all `MIDEN_E2E_TEST`-gated except the behavior-preserving accessor refactor)

A plan verification step builds a production bundle and greps for the hook symbols to prove they're dead-stripped.

### 4.1 Swap-token registry accessor + override — `src/lib/miden/swap/tokens.ts` (+ consumers)
- Behavior-preserving refactor: route all reads through `getSwapTokens()` backed by a module-level mutable list defaulting to today's registry. **This touches every consumer** — `getSwapTokenByFaucetId`, `getSwapTokenBySymbol`, the picker (`SelectSwapTokenDrawer`), the summary badge, and `resolveSwapHistoryFields` — because several import the `SWAP_TOKENS` const directly and would otherwise hold a stale reference. The accessor is **always-on production code** (inert); only the mutation is E2E-gated.
- `window.__TEST_SET_SWAP_TOKENS__(tokens: SwapToken[])` replaces the list at runtime. Constraints: injected `faucetId` must be **bech32** (matches SwapManager's balance-key normalization; a hex id → balance 0); must fire **before** the swap screen mounts (SwapManager seeds `useState` from the token objects).
- **Faucet metadata**: also reuse the existing `injectClaimableMetadata` / `__TEST_HEX_TO_BECH32_FAUCET__` for the swap faucets so balances render (§2). No new production code — reuse the harness's existing hooks.

### 4.2 PSWAP fill/cancel hooks — new E2E-only module `src/lib/miden/swap/test-hooks.ts`
- `window.__TEST_PSWAP_CONSUME__({ orderId, offerFaucetId, requestFaucetId, offerAmount, requestAmount, noteType, fillAmount, noteFillAmount? })` (all id/amount fields as strings; amounts are **base units**): build the swap tag → `client.client.tags.add(tag.asU32())` → `syncState()` → find the input note whose `serialNum().toFelts()[1]` stringifies to `orderId` → `client.transactions.pswapConsume({ account, note, fillAmount: BigInt(fillAmount) })`. Returns a serializable result `{ txId, ok, error? }`; the test asserts balances/lineage separately.
- `window.__TEST_PSWAP_CANCEL__({ orderId })`: `client.pswap.cancelByOrder({ orderId })` (creator path — lineage-by-order is valid for the creator).
- **Open (spike-verified):** whether `buildSwapTag` encodes the amounts. If it does, the partial-fill **remainder** note carries different remaining amounts → a different tag → the taker's registered tag won't match it. The spike must confirm the tag encoding and, if amount-sensitive, register the remainder's tag (derivable from lineage `remainingOffered/Requested`) before the second fill. This may reshape scenario #3.
- Installed only under the `MIDEN_E2E_TEST` guard, from the app-init test-hooks path.

### 4.3 Test-stable selectors (small production additions)
- Add `data-testid` to the swap CTAs — `swap-review-submit`, `swap-submit` — instead of relying on the i18n text "Review Swap"/"Swap" (the latter also collides with the bottom-nav **Swap tab**).
- Add `data-testid`s to the `HistoryDetails` order-tracking card (status / fill rounds / amount filled) so scenario #5 asserts on stable hooks, not i18n labels.

## 5. Harness changes (test-only, under `playwright/e2e/`)

### 5.1 `MidenCli` two-faucet extension — `helpers/miden-cli.ts`
- `createFaucet(symbol: string, decimals = 8): Promise<string>` (parameterize the hardcoded TOML symbol; return the id; track a map). `mint(faucetId, targetAddress, amount, noteType)` takes an explicit id. Keep the existing transient-retry wrapper (extra faucet/mint round-trips widen the `less-than-old-nonce` retry surface — already handled). No pswap CLI subcommand is needed (fill is via the wallet SDK hook), so the CLI is **not** bumped.

### 5.2 Page-object swap methods — `ChromeWalletPage` + `WalletPage` interface (`helpers/wallet-page.ts`)
- `createSwapOrder({ offerSymbol, requestSymbol, payAmount, receiveAmount }): Promise<{ orderId: string }>` — drives `#/swap` (`swap-flow` root; `send-token-selector.first()/.nth(1)` → `swap-token-<SYMBOL>` rows; `send-amount-input.first()` pay / `.nth(1)` receive, typed; `swap-review-submit` → `swap-submit`; waits for `#/generating-transaction/*` success). Reads `orderId` from **Dexie** via `dumpIndexedDBStore`, `String()`-ed.
- `setSwapTokens(tokens)` (calls `__TEST_SET_SWAP_TOKENS__`, before navigating to `#/swap`).
- `consumeSwapOrder({ orderId, offerFaucetId, requestFaucetId, offerAmount, requestAmount, fillAmount, ... })` / `cancelSwapOrder({ orderId })` — call the hooks via `page.evaluate` (used by the taker/creator). Options-object style, consistent with `createSwapOrder`.
- `getSwapOrderState(orderId)` (drives the wallet's own `trackOrderId`) + history-card assertion helper (via the new testids).
- Price-host route-abort helper.

### 5.3 Specs & test selection
- `playwright/e2e/tests/swap/*.spec.ts` in a **subfolder excluded from the default core glob** (so it does *not* auto-run inside the existing core step — see §7). Standard-account scenarios here.
- `playwright/e2e/tests/swap/guardian-swap.spec.ts` for the multisig scenario (guardian create routes through the *same* swap UI; the wallet auto-detects the guardian account and takes the custom-proposal path — no separate UI). Sequence it **after** the standard flow works, as it inherits all the taker-discovery complexity.
- Written against the `two-wallets` fixture + `steps` wrapper. **Fixture scope:** deploy the two faucets and fund/claim **once per describe-block** (shared setup) and reuse across scenarios where isolation allows, to keep the PR-gate runtime bounded; only scenarios that must start from a clean balance get fresh funding.

## 6. Scenario matrix (comprehensive)

Fill amounts are **base units (bigint)**; partial amounts are derived from lineage `remainingRequested` and the order's `min_fill_step` (read/observed in the spike).

| # | Scenario | Key assertions |
|---|---|---|
| 1 | **Full fill A→B** | A −offer, A +request (after claiming payback); B −request, B +offer; `lineage Active→FullyFilled`; orderId (Dexie, string) == `lineage.orderId()`; badge + history row + tracking card = filled |
| 2 | **Full fill B→A** | same, reversed — bidirectional maker/taker |
| 3 | **Partial fill + remainder** | B fills part → remainder PSWAP note; `currentDepth+1`; `remainingOffered/Requested` decrease; A card "partially filled / N rounds"; proportional payback; **2nd partial → FullyFilled** (depends on tag-encoding spike result, §4.2) |
| 4 | **Cancel / reclaim** | creator reclaims unfilled order via `cancelByOrder` → offered asset returns (after claim); `lineage → Reclaimed`; card "reclaimed" |
| 5 | **Order-tracking card UI** | `HistoryDetails` card (via new testids), polled through the wallet's own `trackOrderId`, renders correctly across Active→partial→filled and Active→reclaimed |
| 6 | **Never-filled / resting order** | an order requesting ≥ fair value that no taker takes: stays `Active`; card shows active; balances unchanged (proves the price-cross premise + the Phase-2 testnet lever) |
| 7 | **Create-side UI guards** | same-token blocked; insufficient-balance blocked; `swap-review-submit` enabled/disabled correctly; price-host stubbed |
| 8 | **Failed-status path** | a swap whose generation fails lands `Failed`; history status pill shows Failed (exercises the status-driven pill) |
| 9 | **Guardian-account swap** | Guardian (multisig) account creates via `newPswapCreateTransactionRequest` + custom proposal; B fills; settlement + tracking assert; guardian profile up |

Optional (planning decision): **min-fill-step / below-limit rejection** (fill below `min_requested`/`min_fill_step` → protocol rejects, order stays `Active`); **decimals-mismatch guard** (the untested `SWAP_TOKEN_DECIMALS=8` invariant); **double-consume race** (two takers, one wins). Add at least the first two.

## 7. CI integration (dedicated path-filtered job — NOT a `paths:` gate on the shared job)

- The swap suite must **not** ride the existing core-spec glob (that would run it on every PR and defeat path-filtering), and a `paths:` filter on `pr-e2e-local.yml`'s single job would **skip all existing send/mint/guardian coverage** on non-swap PRs. Both are wrong.
- Instead: a **separate job** (same repo workflow or a sibling), gated by `dorny/paths-filter` on swap-relevant paths, that reuses the local-stack bring-up and runs only `playwright/e2e/tests/swap/**` (dedicated `testMatch`/project). Trigger paths: `src/lib/miden/swap/**`, `src/screens/swap-flow/**`, `src/lib/miden/transaction/{index,complete,get}.ts`, `src/lib/miden/db/types.ts`, `src/app/templates/history/**`, `playwright/e2e/tests/swap/**`, `playwright/e2e/helpers/{wallet-page,miden-cli}.ts`, and the workflow file.
- **Required-check handling:** if this becomes a required gate, the filtered-out path must still report success (a skip that satisfies branch protection) so unrelated PRs aren't blocked — use a job that no-ops-green when the filter doesn't match, per the standard paths-filter pattern.

## 8. Phase 2 (noted, not built now)

- **Testnet/devnet:** the network auto-matcher will race us. Lever (confirmed by matching logic + scenario #6): create orders at an **unreasonable price** (request ≥ fair value) so the price-cross-sensitive solver ignores them, then take them ourselves.
- **Real solver scenario:** no runnable v0.15 matcher exists publicly; if pursued, a thin custom poller (discover by pair tag → `pswapConsume`) as a separate tier — it tests the *solver's* matching, not the wallet's behavior.
- **Mobile swap E2E:** mirror later via the existing two-simulator harness.

## 9. Risks & sequencing

- **R0 — taker note-discovery + settlement spike (MANDATORY FIRST STEP, highest risk).** Before any matrix work: create one order with A, and from B `tags.add(buildSwapTag(...).asU32())` → sync → select by `serialNum felt[1] === orderId` → `pswapConsume`; then A claims payback. Deliverables: (a) confirm the discovery sequence + exact `pswapConsume` inputs; (b) **confirm whether `buildSwapTag` encodes amounts** (decides whether remainder discovery in scenario #3 needs re-tagging); (c) measure public-note propagation + claim latency on the local stack and set poll/timeouts. Its result may reshape §4.2 and §6 — do it before writing the plan's later phases.
- **R1 — settlement latency (re-framed).** The reliability risk is **public-note propagation + discovery + claim** on the local stack (payback/remainder are public P2ID notes A/maker consume), **not** ntx-builder network-note settlement. Tuned by the R0 spike.
- **R2 — registry override correctness.** Behavior-preserving multi-file accessor refactor; must be inert in prod (bundle-grep verification) and inject **bech32** ids **before** swap mount (§4.1).
- **R3 — CI coverage preservation.** The path-filtered swap job must not remove existing per-PR coverage and must satisfy required-checks when skipped (§7).
- **R4 — hermeticity.** Deterministically stub the price host; otherwise slow failing fetches + console spam (§3).
- **R5 — guardian scenario cost.** Guardian-profile bring-up + one multisig round-trip; single focused scenario, sequenced last.
- **R6 — per-PR runtime.** Two faucet deploys + mint + claim per scenario is slow; use describe-scoped shared funding (§5.3).

## 10. Out of scope
- Live testnet/devnet runs and a real matching solver (Phase 2).
- Mobile swap E2E (later).
- Any change to the wallet's *production* swap create/track *behavior*. Production touch-points are limited to: the behavior-preserving `getSwapTokens()` accessor, the E2E-gated hooks, and the added `data-testid`s.
