# Remote Epoch and Agglayer config - Design

**Decision:** The wallet reads a small per-network JSON document from the `main` branch of a dedicated repo, derives every other Epoch and Agglayer value from chain and from the services themselves at runtime, and greys out each affected feature when what it needs is missing, undeployed, or down.

## Goal

Deploying Epoch and Agglayer contracts is the last step of a network deployment, and today every redeploy needs a wallet release because the ids are compiled in (#885 bridge account, #1104 Earn USDC faucet, #1276 Agglayer faucet and note sender, all within three weeks). After this change a redeploy is a commit to the config repo; open wallets pick it up within the hour, and wallets showing a greyed-out feature within minutes.

## Product contract

- Earn deposit, Fast bridge in and out (Epoch, one switch), Bridge in (Agglayer, EVM to Miden) and Bridge out (Agglayer, Miden to EVM) are each **available** or **unavailable**. Unavailable entry points render greyed out and non-interactive with built-in, translated copy: "Temporarily unavailable" / "This external service is currently down. Please try again later." The cause is never shown to users; it is logged once per change.
- A feature recovers on its own: the wallet re-reads the config and re-runs its checks on a schedule (see Polling), and the control re-enables without a reload.
- Withdraw (Earn), Claim (Agglayer, on L1) and Reclaim (Epoch, Miden-only) are recovery actions. **No remote switch can disable them, and this change does not gate them at all;** if a service they call is down they fail through their existing error paths, as today.
- Gating happens at entry points. A flow already past its entry point that finds a value missing fails through its existing error path; there is no separate re-check before confirm.
- A row created before a config change keeps the ids it was created with. Matching, polling and recovery for that row use the row's values, not the current config.
- Swap (in-protocol DEX) is out of scope.

## The config repo

`0xMiden/wallet-config`, public, read from `https://raw.githubusercontent.com/0xMiden/wallet-config/main/<network>.json`.

- **Access:** write access only for WiktorStarczewski, Domi2000 and bobbinth. Pull requests merge without review. A ruleset on `main` blocks force pushes and deletion and requires the `validate` status check. No GitHub App or deploy key with write access.
- **Trust:** whatever is on `main` is what wallets use. There is no signature; the repo's GitHub setup is the control (see Threat model).
- **Files:** `testnet.json`, `devnet.json` (`mainnet.json` later: a document only, unless mainnet needs an EVM chain or Earn protocol the wallet does not support yet), a `README.md` describing every field and the deploy steps, and the validation workflow.
- **`validate` CI** on every pull request: the document parses and passes the wallet's own type checks (the same rules, ported to a small script), `version` is greater than on the base branch, `network` matches the file name, and a deploy smoke test confirms that, for every feature switched on, the accounts and contracts it needs exist on their chains and its URLs answer their health routes. A typo fails the pull request before any wallet reads it, while values can still be staged ahead of a deploy with their switches off.

### Document

```json
{
  "network": "testnet",
  "version": 1,
  "evm": { "chainId": 11155111 },
  "agglayer": {
    "l1Bridge": "0x1348947e282138d8f377b467f7d9c2eb0f335d1f",
    "midenBridge": "0x3b66e20b5088f25133b69216484652",
    "indexerUrl": "https://miden-testnet-bridge.dev.eu-north-3.gateway.fm/api"
  },
  "epoch": {
    "allocatorUrl": "https://testnet-dev.epochprotocol.xyz",
    "positionsUrl": "https://positions-testnet-dev.epochprotocol.xyz",
    "midenUsdcFaucet": "0x537c15a622074e91188aa894456c52",
    "evmUsdc": "0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69",
    "earnProtocol": "dummy-lending"
  },
  "features": { "earn": true, "fastBridge": true, "bridgeIn": true, "bridgeOut": true }
}
```

- These are the only values nothing else can tell the wallet. Each changes only when that particular thing is redeployed or moves host.
- `agglayer` and `epoch` are optional. A missing section, or a missing field inside one, makes the features that need it **not configured**. `devnet.json` starts with both sections absent and every switch `false`, because devnet has no Epoch or Agglayer deployment today.
- `features` switches stop new starts only (see Product contract). A missing switch reads as `false`.
- Validation is strict on known fields and ignores unknown ones, so a field can be added before older wallets understand it:
  - `network` equals the network the wallet is on; `version` is a positive safe integer.
  - URLs are `https:`. E2E builds also accept `http://127.0.0.1` and `http://localhost`.
  - EVM addresses are 20-byte hex; Miden ids are 15-byte account-id hex. Both are normalized to lowercase.
  - `evm.chainId` must be a chain the wallet ships RPC and explorer definitions for (Sepolia today). `epoch.earnProtocol` must be a protocol the Earn code supports (`dummy-lending` today). Anything else makes the dependent features not configured.
  - Any other violation rejects the whole document, which is then ignored like a failed fetch.

### Publishing

1. Edit the values and bump `version` (a revert to old values is a new, higher version).
2. Open a pull request; `validate` runs; merge.
3. Healthy wallets pick it up within about an hour plus the raw CDN cache (about 5 minutes); wallets with a greyed-out screen open within a few minutes.

## Wallet runtime

New module `src/lib/remote-config/`:

| File | Responsibility |
|---|---|
| `schema.ts` | Types and hand-written guards for the document, in the style of `src/lib/update/guards.ts` |
| `source.ts` | URL for the effective network, bounded fetch (32 KB, 10 s, reusing `src/lib/remote-json.ts`), version floor, storage |
| `derive.ts` | Chain and service reads that turn the document into everything the consumers need |
| `availability.ts` | Feature states from the document, the derived values and the switches |
| `runtime.ts` | Poll scheduler, change subscription, and the `useBridgeConfig` / `useFeatureAvailability` hooks |

- **Network:** `getEffectiveNetworkName()`, so the Developer Settings network override is honoured. Localnet and mainnet have no document today; a 404 makes every feature not configured.
- **Accepting a document:** only after it validates and its `version` is at or above the stored floor for that network. The floor key is added to `PRESERVED_STORAGE_KEYS` so a wallet reset cannot reopen older documents.
- **Failure:** a fetch that fails, does not validate, or goes below the floor is logged and ignored; the last accepted document stays in use with no expiry.
- **Realms:** the accepted document and the derived snapshot are persisted in platform storage (`bridge_config_v1:<network>`, `bridge_config_derived_v1:<network>`); the derived snapshot records the document version it came from and is discarded when that version is replaced. Every realm (extension pages, service worker, offscreen, mobile, desktop) reads them from storage, re-validates once per load, and follows storage-change events. A realm that needs the config and finds no fresh copy fetches it itself, which covers the service worker matching a bridge-in note while no window is open. Writes go through `putToStorage` (and a module store registers its re-read with `registerStorageReread`), because mobile and desktop have no storage change event and a direct provider write leaves the hooks' cache stale.

### Polling

Only while the wallet is open; a closed wallet needs no config.

| State | When it fetches the document and re-runs the checks |
|---|---|
| Every feature available | Every 60 min, and on open or foreground when the copy is older than 15 min |
| A greyed-out control is on screen | Every 60 s |
| Some feature unavailable, none on screen | Every 5 min |
| Fetch errors | Exponential backoff, capped at 15 min |

"On screen" means the greyed-out control's page reports `usePageActive()`: tab panes and covered slide layers stay mounted while hidden, so mounting alone does not count. The raw CDN caches for about 5 minutes, so a new document reaches a wallet within one poll interval plus that.

## Derived values

| Value | Read from | Used by |
|---|---|---|
| Rollup id (86 on testnet) | Miden bridge account, value slot `agglayer::bridge::network_id` | `bridgeAsset` destination network; indexer `network_id` of Miden exits |
| Registered faucets: Miden faucet, origin token address and network, scale | Bridge account maps `agglayer::bridge::faucet_registry_map` and `faucet_metadata_map`, read whole with `getAccountProof` | Bridge out eligibility (as today), the native-ETH faucet for bridge-in matching and pricing |
| Bridge-in note sender | The registered faucet whose origin is native ETH on network 0, which mints and sends the delivery note (verified live) | Bridge-in matching, which stays ETH-only as today |
| EVM-side network id (0) | L1 bridge `networkID()` | Bridge out destination network; indexer `dest_net` |
| Contract existence | `eth_getCode` at `l1Bridge` and `evmUsdc`; Miden account lookup for `midenBridge` and `midenUsdcFaucet` | Not-deployed detection |
| Symbols and decimals | Miden faucet metadata (`fetchTokenMetadata`); ERC-20 `symbol()` and `decimals()` | Display and amount parsing |
| Earn market uid | The Epoch SDK's market-uid helper over `evm.chainId` and `evmUsdc` | Earn mandate and positions filter |
| Epoch collateral recipient and minimum reclaim | Allocator `/miden-recipient`, per intent (unchanged) | Fast bridge, Earn |
| Service health | Allocator `/health`, positions `/health`, indexer `/healthz` | Service-down detection |
| Miden virtual chain id (999999999) | Epoch SDK constant | Unchanged |

- The derived snapshot is computed after each accepted document and on the poll schedule, and persisted with the document's version.
- The bridge-out registry check for the faucet being sent stays a fresh single-entry read, as `isAgglayerFaucetAllowed` does today.
- Reading the maps whole works while they stay under the node's response limit (the bridge has 4 registered faucets; the large `ger_map` is never read). If the node refuses, derivation falls back to `syncStorageMaps`.
- Token lists stay as today: bridge out offers any faucet the registry approves; the deposit screen offers native ETH (Slow) and the configured USDC pair (Fast).
- Bridge-in matching keeps today's comparison. Its amount-scaling defect is #1326, fixed separately.

## Feature availability

Each feature resolves to `available` or one unavailable reason, in this order:

1. `off`: its switch is `false` (new-start features only).
2. `not-configured`: no accepted document, or a value it needs is absent or unsupported.
3. `not-deployed`: a contract has no code, a Miden account does not exist, or the registry lists no usable token. A confirmed absence, not an error.
4. `service-down`: an RPC or HTTP call it needs failed or timed out. Retried on the schedule.

| Feature | Needs |
|---|---|
| Earn deposit | `earn`; allocator healthy; `midenUsdcFaucet` exists; `evmUsdc` has code |
| Fast bridge out (Miden to EVM) | `fastBridge`; allocator healthy; `evmUsdc` has code |
| Fast bridge in (EVM to Miden) | `fastBridge`; allocator healthy; `evmUsdc` has code; `midenUsdcFaucet` exists |
| Bridge in | `bridgeIn`; `l1Bridge` has code; `midenBridge` exists and its registry lists at least one token; indexer healthy |
| Bridge out | `bridgeOut`; `midenBridge` exists and its registry lists the faucet being sent; the L1 bridge's `networkID()` was read (the note's destination network) |

`useFeatureAvailability(feature)` drives every entry point: the Earn deposit entry, the Fast and Slow route options in Send, Receive "Cross Chain", `/bridge/deposit` and the deposit screen's route options. `isBridgeDepositEnabled()` and `isBridgeableEvmTokenConfigured()` are replaced by it.

## Consumers

- Every value in the inventory below becomes a read from the accepted document or the derived snapshot. Duplicates are deleted: the Earn USDC faucet (2 copies), Miden USDC decimals (4), `999999999` (2), and the hand-copied bech32 note sender.
- The Epoch SDK receives `apiBaseUrl` from the document; an SDK instance is rebuilt when the URL changes.
- Values already stored on a row (faucet, destination network, market uid, source symbol) stay authoritative for that row. Earn positions and withdrawals read the configured market, as they read the compiled one today.
- The spending-limit price allowlist (`src/lib/miden/swap/tokens.ts`) keys the document's `midenUsdcFaucet` to USDC and the registry faucet whose origin is native ETH to ETH, matching today's two entries; other registered faucets stay unpriced, as today. Valuation awaits the stored config first. Known limitation: on a fresh install that has never fetched a document, the two bridged faucets are unpriced like any unknown token until the first fetch succeeds.
- `EPOCH_ALLOCATOR_URL` and `EPOCH_POSITIONS_URL` defines leave the Vite configs; E2E suites set those URLs through the served document instead. ABIs, the Sepolia RPC and explorer (resolved by chain id), WalletConnect setup and the greyed-out copy stay in code.

Inventory (from the 2026-10-03 survey): `src/lib/epoch/config.ts`, `bridgeable-token.ts`, `collateral.ts`, `earn.ts` constants; `src/lib/agglayer/constant.ts`, `b2agg/constant.ts`, `allowed-faucets.ts`, `status.ts`; `src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.tsx`; `src/screens/send-flow/bridge-networks.ts`; `src/lib/miden/swap/tokens.ts` (price allowlist entries for the bridged faucets); `src/lib/miden/activity/bridge-in.ts`, `bridge-receive.ts`; `src/lib/walletconnect/config.ts` (chain from `evm.chainId`).

## E2E and CI

Every Earn and bridge suite keeps running exactly where it runs today, with the features it exercises available. None is skipped or disabled. Workflow triggers are unchanged (the Earn job still runs on push and dispatch only; the iOS bridge-in step is still non-blocking); changing them is out of scope.

- **Config source in E2E:** E2E builds read the document from `MIDEN_REMOTE_CONFIG_URL` when it is set, defined in every Vite config and honoured only when `MIDEN_E2E_TEST` is set. Unset, an E2E build reads the published repo like production. A unit test proves production defines leave it undefined, and the define-parity test covers it.
- **Served document:** a new `playwright/e2e/helpers/fake-bridge-config.ts` serves `<network>.json` from the test, so a suite controls every value and switch.
- **Overrides on top of the document:** the existing E2E hooks stay for values a suite creates at runtime and cannot put in the document or on chain. Each now overrides the config getter instead of a constant, and availability reads the effective value after overrides.
- **Mocks match the real contracts:**
  - `MockAggLayerBridge` gains `networkID()` returning 0.
  - `MockUsdc` gains `symbol()` returning `USDC`, and its `decimals()` becomes 18 to match the Sepolia token at `0x2BB4...` (today it returns 6, while the wallet requires 18). The fakes that copy 6 are updated with it.
  - The Chrome fake allocator's `/health` returns the SDK's `HealthCheckResponse` shape. The iOS fake allocator gains `/health` and `/miden-recipient`.

| Suite | Document | Derived from | Overrides kept |
|---|---|---|---|
| Earn (`pr-e2e-earn.yml`, local node) | Served: allocator `:8548`, positions `:8549`, chain 11155111, `evmUsdc` at the Anvil mock, no `midenUsdcFaucet` (the hook supplies it), no `agglayer` section, `earn` and `fastBridge` on | Fake allocator, Anvil mock, local node | `__TEST_SET_EARN_FAUCET__` (the collateral faucet is created per test) |
| Guardian Fast bridge-out (`pr-e2e-bridge-guardian.yml`, local node) | Same as Earn | Same | None |
| Bridge-out (`e2e-bridge.yml`, testnet) | The published `testnet.json`, no override | Real testnet bridge account, real Sepolia | `__TEST_ALLOW_AGGLAYER_FAUCET__` (the CLI faucet is not in the real registry); it now supplies the faucet's whole registry entry, including origin token and scale |
| Bridge-in (`e2e-bridge-in.yml`, iOS, testnet plus Anvil) | Served: testnet `midenBridge`, indexer and `midenUsdcFaucet`, `l1Bridge` and `evmUsdc` at the Anvil mocks, allocator `:8548`, all switches on | Live testnet bridge account (rollup id 86, as the spec asserts), Anvil mocks | `__TEST_SET_AGGLAYER_SENDER__` (the delivering faucet is a CLI faucet) |
| `yarn e2e:real` | The published document | Real services throughout | None. Its preflight reads the document instead of its own address table (`scripts/e2e-real.mjs:35-38`) |

- On the local node, the Slow routes show "not configured", which no localnet spec exercises today. The node's genesis does create an Agglayer bridge account, but with a random id, network id 77 and an empty registry, and the harness does not use it.
- No E2E covers the L1 claim today; that stays with #1325.

## Threat model

- **A push to `main` of the config repo redirects funds for every wallet within the hour:** bridge-out notes to an attacker's Miden account, Earn collateral to an attacker-chosen allocator, ETH to an attacker's L1 contract. Who can push: the three writers (including a phished session or leaked token), the 0xMiden organization owners, and GitHub itself. Signing was considered and declined on 2026-10-03 as too much operational friction; the controls are the repo's access list and ruleset.
- **What the wallet still enforces:** strict typing, https-only URLs, supported chain and protocol sets, the version floor, and the not-deployed checks. These catch mistakes and half-finished deploys; they do not stop a malicious document that points at attacker-deployed contracts and accounts.
- **What a document cannot do:** disable Withdraw, Claim or Reclaim; change copy, navigation or code; alter values stored on rows; select an RPC endpoint for the Miden chain.
- **Out of the wallet's reach:** the Epoch SDK's own EVM contracts (Compact, arbiter, allocator, solvers) stay pinned in the SDK; a move there needs an SDK release. Ask Epoch for an address override (its code reserves one) and for the Miden USDC faucet in `/health`.

## Testing

- `schema.ts`: every field's accept and reject cases, https-only, network mismatch, unknown fields ignored, optional sections.
- `source.ts`: version floor (lower ignored, equal accepted, floor survives reset), last-good retained on fetch error and invalid document.
- `derive.ts`: against recorded testnet storage and responses (bridge maps, `networkID()`, ERC-20 reads), including the whole-map fallback.
- `availability.ts`: each reason for each feature.
- `runtime.ts`: the poll schedule with fake timers, including the greyed-out fast path and backoff.
- Each greyed-out entry point renders the copy and blocks interaction.
- Bridge-in matching takes its sender from the registry's native-ETH faucet.
- Every new test gets a mutation check.

## Rollout

1. Create `0xMiden/wallet-config` with `testnet.json` holding today's testnet values, `devnet.json` with no sections and every switch off, the README and `validate`.
2. Wallet change against `next`, reviewed with `/review-council:rev`, through CI.
3. Ships with the next release. Older wallets keep their compiled values, so the first redeploy after this ships still needs users on the new version.
4. When testnet relaunches on 0.17, the deploy updates `testnet.json`; no wallet release.

## Related

- #1325: Slow bridge-out never settles. Its fix uses the derived rollup id and EVM network id.
- #1326: Slow ETH bridge-in never matches its tracker (amount scaling).
