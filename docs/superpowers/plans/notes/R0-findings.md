# R0 findings — PSWAP taker discovery + fill, validated against the live local stack

Status: CREATE path + DISCOVERY validated end-to-end on the real chain; TAKER FILL
blocked at the final vault-signing bridge (precisely isolated). 13 spike iterations.

## Environment (what it takes to run swaps locally)
- Base stack (validator/sequencer/ntx-builder/tx-prover, v0.15.0) via docker-compose. RPC :57291, prover :50052.
- **note-transport service (:57292) is REQUIRED even for swaps** — wallet CREATION's `Vault.spawn → syncState` fails without it ("note transport network error"). Run `run-note-transport.sh` (builds miden-note-transport, ~min first time). Guardian profile NOT needed for standard swaps.
- Playwright browser: install the pinned build (`npx playwright install chromium` → chromium-1228). macOS runs headed without xvfb.
- miden-client 0.15.0 CLI on PATH is used as-is (resolveCliPath prefers PATH).

## Validated (works on the real chain)
1. Fund 2 faucets (CLI, hex ids) → mint → both wallets sync + claim → balances render.
2. **Registry override needs BECH32 faucet ids**: CLI returns HEX; convert via `__TEST_HEX_TO_BECH32_FAUCET__(hex)` (= `Address.fromAccountId(id,'BasicWallet').toBech32()`, matching the balance-key normalization) before `__TEST_SET_SWAP_TOKENS__`. Raw hex → offer balance 0 → "Review Swap" disabled.
3. Create the order via the real `#/swap` UI (offer/request tokens + amounts, typed receive bypasses the price feed) → success → `orderId` read from Dexie `TridentMain.transactions.extraInputs.orderId` (bigint → String across page.evaluate).

## Discovery findings (taker finds the maker's note)
4. Lineage is own-orders-only → the taker CANNOT resolve the maker's note via `pswap.lineage`.
5. **PSWAP notes appear in `client.notes.list()` (input notes), NOT `getConsumableNotes()`** (custom script, not a P2ID to the taker).
6. **`buildSwapTag(offer,request)` does NOT reproduce the tag `pswapCreate` stamps on the note** — e.g. real note tag `1433…` vs buildSwapTag `3654…` (same faucets/amounts/type). The taker must use the MAKER'S REAL TAG. Read it from the maker via `note.metadata().tag().asU32()` (new `__TEST_PSWAP_ORDER_INFO__` hook) and convey it to the taker (as a solver reads it from the mempool). With the real tag, `tags.add + syncState` imports the note. (Amount-sensitivity of the tag is therefore moot — always use the real tag.)
7. **Discover on the DEFAULT client** (`getMidenClient()`, the wallet's already-synced singleton). `getMidenClient(options)` disposes+recreates a FRESH, unsynced client that can't find the note in time.

## The remaining blocker (taker fill) — precisely isolated
8. `pswapConsume` needs a VAULT signature: the wallet's keys are in the SW vault, not the SDK keystore. Routing signing through the page-side `store.signTransaction` (via a `signCallback` on `getMidenClient(options)`) IS invoked, but the SW `SignTransactionRequest` handler returns an **EMPTY signature** → SDK: "failed to deserialize Signature: unexpected end of file". The wallet's own extension txs sign **SW-direct** (`transaction-processor.ts` → `swSignCallback` → `Actions.signTransaction`/`vault.signTransaction`), NOT via this page→intercom bridge.
   - **Next step:** run the consume in the SW context (call `__TEST_PSWAP_CONSUME__` via `serviceWorker.evaluate`, with the hook installed in the SW) and build the `signCallback` from the SW's direct vault signer (`Actions.signTransaction`) instead of `store.signTransaction`. Discover on the default client (proven), fill by note id on the signing client.

## Hook shape (src/lib/miden/swap/test-hooks.ts, all MIDEN_E2E_TEST-gated)
- `__TEST_SET_SWAP_TOKENS__`, `__TEST_PSWAP_ORDER_INFO__` (maker's note id+tag), `__TEST_PSWAP_CONSUME__({accountId, orderId, tagU32, fillAmount, ...})`, `__TEST_PSWAP_CANCEL__`. Consume = discover-on-default-client-by-tag → fill-by-note-id-on-signing-client.
