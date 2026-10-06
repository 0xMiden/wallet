# Wallet 1.17 does not know its fee token unless it is configured

Status: implementation, review fixes and all local validation gates pass at this source checkpoint. Final independent certification and PR publication follow the commit. Results are in `tasks/fee-faucet-plan.md`.

- Worktree: `~/wt-wallet-fee-faucet`, branch `fix/fee-faucet-from-sdk`, based on `origin/next` at `70f592724` (the v1.17.0 release commit).
- Every claim below cites `path:line` at `v1.17.0` unless it says otherwise.

## Symptom

In a release build of wallet 1.17.0 the wallet's own code never learns which token pays fees. The SDK inside it does, so transactions still pay their fees. But every wallet feature keyed on "the native asset" or "the fee asset" sees `null`, or an exception, and switches itself off or fails.

## What the chain actually uses (verified live on 2026-10-06)

The probe ran SDK 0.17.0 in Node against `https://rpc.devnet.miden.io`, syncing the chain and then asking the client.

- **Fee token on devnet:** `client.feeFaucetId()` after `syncChain()` returns `0x817edea77acc5d71616e493afecea3`. Its storage reads symbol `USDCX` with 6 decimals.
- **"Fund your wallet":** it calls `faucet-api.devnet.miden.io` `/pow`, then `/get_tokens` for `100_000_000` base units (`src/lib/wallet-prompts.ts:599`), which is 100 USDCX.
  - The 0.17 faucet service's `/get_metadata` reports `"version":"0.17.0"`, an `id` of `mdev1apd27ya3k9g6j5tu7jkuptn9kqmy5l9y`, and a `balance` (no `max_supply`).
  - That `id` is not a faucet. It is a public single-sig wallet: `isFaucet()` is false, and its only storage slots are `miden::standards::auth::singlesig::{scheme,pub_key}`. Its vault holds about 999.98 million USDCX from the same fee faucet.
  - So funding hands out the fee token itself.
- **Testnet:** its faucet still reports `"version":"0.16.0"`, so a 0.17 wallet cannot use testnet yet.

## Root cause

`src/lib/miden-chain/native-asset.ts:179-184`. `discover()` needs a configured fee faucet and throws without one:

```
no fee faucet is configured for this network: set feeFaucetId in Developer Settings, MIDEN_FEE_FAUCET_ID, or the E2E injector
```

`getEffectiveFeeFaucetId()` (`src/lib/miden-chain/effective-endpoints.ts:162-168`) reads four sources, in this order:

1. the E2E injector (`setFeeFaucetIdForTest`, `:146`)
2. the storage key `fee_faucet_id`, which only that injector writes
3. a Developer Settings override
4. `process.env.MIDEN_FEE_FAUCET_ID`, baked in by the vite configs

None of them is set in a shipped build.

- `.github/workflows/build-chrome.yml` sets only `MIDEN_NETWORK`, `MODE_ENV`, `NODE_ENV` and the two telemetry secrets. The only `MIDEN_FEE_FAUCET_ID` write in the repo is the local-node CI action (`.github/actions/run-local-node/action.yml:671`).
- Nothing in `src` reads the SDK's own `feeFaucetId()`. That accessor returns the fee faucet from the protocol config the client stored on sync (web-sdk `crates/web-client/src/lib.rs:285-320` at `v0.17.0`).

The code was right when written. During the release-candidate period the node did not serve the protocol config, so the wallet had to be told. The comment at `effective-endpoints.ts:158-161` still says so. SDK 0.17.0 final receives the config on sync, and the wallet was never switched over.

## Why the devnet E2E suites pass

The harness supplies the value a shipped build lacks.

1. `playwright/e2e/fixtures/two-wallets.ts:947,993` calls `midenCli.ensureNativeFaucetId()`.
2. On a public network that runs `discoverFeeFaucetId()` (`playwright/e2e/helpers/fee-faucet.ts`): the SDK in Node, `syncChain()`, then `feeFaucetId()`.
3. It then injects the result through the test-only service-worker hook `__TEST_SET_FEE_FAUCET__` (`two-wallets.ts:395-412`).

No test launches a wallet without that injection, so the gap cannot show up in CI.

## Impact (callers that resolve the native or fee asset)

`getFaucetIdSetting()` (`src/lib/miden/assets/faucet-id-setting.ts:24-33`) turns the throw into `null`. `getNativeAssetId()` callers receive the rejection. Read from the code; none of this has been observed on a running release build yet.

- `hasNoFeeAsset` returns `false` for an unknown native id (`src/lib/miden/fees/spendable.ts:42-44`). The "insufficient fee asset" prompt never shows (`src/app/templates/HomePrompts.tsx:385,394`), and the hot-key rotation funding gate cannot tell fee notes apart (`HotKeyRotationGate.tsx:210-216`).
- **Base fee:** `getVerificationBaseFee()` reads the fee only inside `discover()` (`native-asset.ts:333-382`), so it stays `null`. The comment at `native-asset.ts:466-471` says `partitionFeeNote` fails closed on `null`. To check: whether fee-note identification in history stops working.
- **Native note auto-consume:** it returns early when the native id is `null` (`src/lib/miden/front/NativeNoteAutoConsumeManager.tsx:56-57`).
- **Earn withdraw:** it awaits `getNativeAssetId()` before it starts (`src/lib/epoch/earn-withdraw.ts:175`), so the rejection propagates. To check: what the user sees.
- **dApp fee metadata:** `getTokenMetadata(await getNativeAssetId())` (`src/lib/miden/back/dapp.ts:2731`).
- **Other callers still to check:**
  - the SW sync lap (`src/lib/miden/back/sync-manager.ts:611`)
  - transaction initiation and the loop (`src/lib/miden/transaction/initiate.ts:215`, `transaction/index.ts:1957`)
  - native-token branding and metadata (`src/lib/miden/metadata/utils.ts:32`, `src/lib/miden/assets/utils.ts:85`)
  - guardian history (`src/lib/miden/sdk/guardian-history.ts:158`)
  - `fetchBalances`, which per `CLAUDE.md` awaits the native faucet id

## Constraints on the fix

- **Only a synced WebClient has the fee faucet.** The stateless `RpcClient` that `native-asset.ts` uses for the block header has no protocol-config read (web-sdk `crates/web-client/src/rpc_client/mod.rs` at `v0.17.0`). The header carries only `protocolConfigCommitment()`.
- **`feeFaucetId()` before the first sync** falls back to the `feeFaucetId` the client was created with, and throws when there is none (web-sdk `lib.rs:311-317`).
- **Clients live per realm, behind the WASM lock.**
  - On the extension, the service worker forwards WASM work to the offscreen document (`midenClientProxy`; `src/offscreen/main.ts:584` runs the sync there).
  - On mobile and desktop the client is in-process, and `useSyncTrigger` syncs every 3 s.
  - Any WASM call follows the lock and liveness rules in `CLAUDE.md`.
- **`native-asset.ts` caches per scope** (RPC URL plus network name) and persists to `native_asset_id:v4:<scope>`. A fix must not reintroduce a value that survives an endpoint switch.
- **The `fee_faucet_id` storage key is not scope-keyed.** Writing the synced value there would carry one network's fee faucet into another after a Developer Settings switch.

## Candidate designs

- **A. Read it lazily in `discover()`.** When nothing is configured, ask the realm's client (via `midenClientProxy`) for `feeFaucetId()` under the WASM lock.
  - Risks: `discover()` runs from many places, so it needs a check that no caller already holds the lock (re-entrancy). It also needs a new proxied op for the offscreen document.
- **B. Record it at sync time.** After a successful sync, inside the hold that already exists, read `feeFaucetId()` and hand it to `native-asset.ts`. That module persists it under its scope-keyed id key and emits `onNativeAssetChanged`. `discover()` without a configured value then re-reads that scoped key and throws a transient "not known until the first sync" if it is still empty.
  - Risks: every sync path (SW and offscreen, mobile and desktop `useSyncTrigger`, the other `syncState()` callers) has to record it, or some realm never learns it. The extension popup must pick up the SW's write, because `hydrateFromStorage` latches `hydrated = true` after its first read.
- **C. Bake a per-network value** into `networks-config.ts`. Rejected: a devnet genesis reset changes the faucet id (devnet was reset on 2026-10-05), and the value would go stale silently.

Design B was selected after the sync-path inventory and independent plan check. The implementation handoff below records the resulting behavior.

## Test plan

- **Unit (`native-asset.test.ts`):**
  - nothing configured and a synced value recorded: `getNativeAssetId()` returns it
  - nothing configured and nothing recorded yet: a transient failure, then success once a sync records the value
  - a scope switch drops the recorded value
  - a configured value still wins over the synced one
- **Devnet E2E:** launch a wallet without `__TEST_SET_FEE_FAUCET__`, wait for the first sync, then assert the wallet's native asset id equals `discoverFeeFaucetId(rpcUrl)` and its metadata symbol is `USDCX`.
- **Mutation check:** remove the new fallback and confirm the E2E test fails.

## Implementation handoff

- Chosen design: B. Successful sync records the SDK fee identity under its immutable RPC/network construction scope and existing WASM hold.
- The offscreen document relays plain scoped identity to the service worker through runtime messaging. Other realms adopt the persisted identity through storage changes and re-read an early miss.
- Identity-bound metadata/fee cache envelopes reject stale values. SDK-synced identity evidence is stored separately from explicit overrides.
- Native metadata keeps its chain symbol and decimals. Recognized USDCX uses a fixed $1 quote across balances and spending limits; copied symbols and arbitrary overrides remain unpriced.
- The Send reserve uses the actual fee asset, with known zero omitted and unknown fee kept distinct from zero.
- Developer Settings and the localhost injector remain explicit overrides. The stale endpoint comment has been updated.
- The uninjected devnet regression discovers USDCX, values it with an empty market feed, and checks the Send fee bound against the live header. It stops before Send submission.
- Remaining verification and publication steps are tracked in `tasks/todo.md` and `tasks/fee-faucet-plan.md`.
