# 1Click partner proxy

This Worker keeps the 1Click partner credential on the server. It accepts only bounded token, quote, status, deposit-submit, and optional Miden receipt requests, then forwards them to the fixed `https://1click.chaindefuser.com` API. It never accepts a caller-supplied upstream URL.

The wallet enables the 1Click UI, catalog, and new funding only when `features.nearIntents` is explicitly `true`. A missing or false flag keeps the feature disabled even when `swap.oneClick.serviceUrl` and asset mappings are present. Mainnet is initially disabled; enabling it requires the wallet-config rollout in [PR #24](https://github.com/0xMiden/wallet-config/pull/24). Publish `swap.oneClick` on mainnet with the proxy `serviceUrl` and explicit Miden `assetId` / `faucetId` / `decimals` mappings, and set the rollout flag intentionally. Cross-chain starts also require at least one mapping to pass the wallet's on-chain faucet metadata check. Never use token symbol matching to create a mapping. Existing persisted tracking and history continue independently of this start gate.

## Routes

| Method and path | Purpose |
| --- | --- |
| `GET /v0/tokens` | Forward the provider's token catalog unchanged |
| `POST /v0/quote` | Validate and forward an exact-input chain quote |
| `GET /v0/status` | Query a status by deposit address and optional memo |
| `POST /v0/deposit/submit` | Submit an already broadcast transaction hash |
| `POST /v1/receipts/resolve` | Optional adapter lookup for exact Miden note IDs |

All responses use `Cache-Control: private, no-store`; logs and traces are disabled. The request body is capped at 32 KiB, provider/adapter responses at 1 MB, asset catalogs at 5,000 rows, and calls at 12 seconds. Configure Cloudflare edge rate limiting for the deployed hostname before publishing its URL. CORS accepts only exact entries in `ALLOWED_ORIGINS`; it is a browser boundary and does not replace edge rate limits.

## Bindings

| Name | Type | Purpose |
| --- | --- | --- |
| `ONE_CLICK_PARTNER_KEY` | Worker secret | Bearer credential for the official 1Click API |
| `ALLOWED_ORIGINS` | Worker variable | JSON array of exact wallet origins |
| `APP_FEES` | Worker variable | Fixed JSON array of `{ "recipient": "...", "fee": 25 }` values, or `[]` |
| `MIDEN_RECEIPT_ADAPTER_URL` | Worker variable | Optional fixed HTTPS adapter URL for exact destination note resolution |
| `MIDEN_RECEIPT_ADAPTER_TOKEN` | Worker secret | Optional bearer credential for that adapter |

Provider app fees are unsigned fields in the 1Click quote signature. Keep `APP_FEES` reviewed and synchronized with the mainnet remote config. The wallet and proxy reject quote requests whose fee list differs from the configured list; never treat the provider's fee fields as proof of payment authorization.

The receipt adapter must return only `{ "transactionHash": "...", "noteIds": ["..."] }` entries for requested hashes, after verifying the final Miden transaction and exact note IDs. The service validates that every hash was requested and caps each entry at 64 note IDs. If the adapter is absent or fails, the wallet continues to show incoming swaps as arriving. Do not map a destination hash to a note by amount or symbol.

## Deploy

Use Wrangler **4.151.3** with `services/one-click/wrangler.jsonc`. Set the Worker secrets and reviewed variables in the protected deployment environment, configure Cloudflare hostname and rate limiting, deploy, then publish that URL under `swap.oneClick.serviceUrl` in the mainnet wallet config. Keep `features.nearIntents` false until the rollout is intentionally enabled in wallet config. Configure the optional receipt adapter before enabling automatic incoming completion. There is no partner credential in the wallet bundle or remote config.

Deploy the matching feature-eligibility service before activation so it recognizes an enabled 1Click-only swap configuration. The wallet and eligibility service continue to enforce the configured wallet and swap place rules.

## Hermetic E2E gate

The local fake service is available only in the dedicated E2E build when all of these values match:

| Build/config value | Required value |
| --- | --- |
| `MIDEN_NETWORK` | `localhost` |
| `MIDEN_E2E_TEST` | `true` |
| `MIDEN_E2E_ONE_CLICK_TESTNET` | `true` |
| Remote config document network | `localnet` |
| `features.nearIntents` | `true` |
| 1Click service URL | Loopback HTTP or HTTPS |
| `MIDEN_E2E_ONE_CLICK_MANAGER_PUBLIC_KEY` | The fake service's exported public key |

Missing or mismatched values hide 1Click outside mainnet and keep the production signer pinned. Ordinary extension/background builds default the dedicated flag to `false` and the test key to empty. Testnet and other network documents cannot enable this local path.

The official SDK API/signature reference was fetched from `@defuse-protocol/one-click-sdk-typescript@0.1.25`. The npm registry's SHA-512 integrity is `y8fm8V7bPKYfJrhJOUWMG5/IFb1aMcIFHiM5PRDQngd33enhcDGGYJCNwM6y5o4pZZtlU1FroHB8OlA3NkxhzQ==`; the downloaded archive matched that integrity before inspection. The SDK signs a selected flattened payload. Its signature excludes `appFees`, partner ID, session ID, connected wallets, and deposit mode, so those fields are checked against fixed service configuration independently.
