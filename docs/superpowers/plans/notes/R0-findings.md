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
8. `pswapConsume` needs a VAULT signature (keys live in the SW vault, not the SDK keystore). Routing signing via `store.signTransaction` → SW `Actions.signTransaction` → `withUnlocked(vault.signTransaction(pk, inputs))` IS invoked (not locked — `withUnlocked` throws when locked; we got no throw), but **`vault.signTransaction` returns an EMPTY signature** for the taker's auth pubkey (`d5bc…`) → SDK "failed to deserialize Signature: unexpected end of file".
   - ROOT CAUSE: the taker's auth pubkey (as the fresh consume client presents it) does NOT resolve to B's stored secret key — a **public-key-commitment / key-lookup mismatch**. This ties to the known `MidenWalletSigner` "invalid public key commitment" bug (Phase-0 fix on a branch; Phase-1 first-class web-SDK signer pending). NOTE: the taker's OWN signing is never exercised by the existing E2E suite (the maker always signs), so this path was untested.
   - **This is a wallet-crypto issue, not a harness tweak.** Faithful "wallet B signs" requires either the wallet vault-signer/commitment fix, or wiring a wallet-native consume tx type through the wallet's own pipeline (which uses the correct `swSignCallback`). The already-rejected "standalone SDK filler with its own keystore" would sidestep vault signing entirely if the maker/taker fidelity can be relaxed.

## Hook shape (src/lib/miden/swap/test-hooks.ts, all MIDEN_E2E_TEST-gated)
- `__TEST_SET_SWAP_TOKENS__`, `__TEST_PSWAP_ORDER_INFO__` (maker's note id+tag), `__TEST_PSWAP_CONSUME__({accountId, orderId, tagU32, fillAmount, ...})`, `__TEST_PSWAP_CANCEL__`. Consume = discover-on-default-client-by-tag → fill-by-note-id-on-signing-client.
