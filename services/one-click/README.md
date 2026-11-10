# 1Click partner proxy

This Worker keeps the 1Click partner credential on the server. It accepts only bounded token, quote, status, deposit-submit, and optional Miden receipt requests, then forwards them to the fixed `https://1click.chaindefuser.com` API. It never accepts a caller-supplied upstream URL.

The wallet uses this Worker for the "Near Intents" tab of the Receive page: the user selects an origin chain and token, the configuration sets the Miden token, and the wallet shows a 1Click deposit address and its QR code. The tab needs no wallet connection.

## Wallet configuration

The wallet shows the tab only when `features.nearIntents` is exactly `true` and the document has a top-level `nearIntents` section. The wallet reads the section on mainnet only (and on localnet under the hermetic E2E gate below). A `swap.oneClick` section is not read any more.

```json
"nearIntents": {
  "serviceUrl": "https://<worker host>",
  "appFees": [{ "recipient": "wallet.near", "fee": 25 }],
  "midenAssets": {
    "usdcx": { "assetId": "nep141:miden-0x….omft.near", "faucetId": "0x…", "decimals": 6 }
  },
  "chains": {
    "eth": {
      "name": "Ethereum",
      "addressKind": "evm",
      "tokens": {
        "USDC": { "assetId": "nep141:eth-0x….omft.near", "decimals": 6, "contractAddress": "0x…", "miden": ["usdcx"] }
      }
    }
  }
}
```

The order of the keys is the display order. The rules (an invalid section rejects the whole document):

- `serviceUrl`: HTTPS base URL of this Worker, with no credentials, query or fragment. `appFees`: at most 3 entries, each 0 to 1000 basis points, 1000 in total at most.
- `midenAssets`: 1 to 64 entries. Key `^[a-z][a-z0-9-]*$`. `assetId` 1 to 256 characters, no control character. `faucetId` a 15-byte hex account id. `decimals` 0 to 38. No asset id or faucet twice.
- `chains`: 1 to 32 entries. Key is the 1Click blockchain name, `^[a-z][a-z0-9-]{0,31}$`, never `miden`. `name` 1 to 64 characters, no control character. `addressKind` is `evm`, `solana`, `bitcoin` or `near`.
- `tokens`: 1 to 64 per chain. Key is the symbol, 1 to 32 characters, no control character. `assetId` 1 to 256 characters, unique in the section and different from every Miden asset id. `decimals` 0 to 38. `contractAddress` optional, 1 to 256 characters. `miden`: 1 to 8 different keys of `midenAssets`.

Use the exact 1Click asset ids. Never use token symbol matching to make a mapping. Existing persisted tracking and history continue independently of this gate.

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

Use Wrangler **4.151.3** with `services/one-click/wrangler.jsonc`. Set the Worker secrets and reviewed variables in the protected deployment environment, configure Cloudflare hostname and rate limiting, deploy, then publish that URL under `nearIntents.serviceUrl` in the mainnet wallet config. Keep `features.nearIntents` false until the rollout is intentionally enabled in wallet config. Configure the optional receipt adapter before enabling automatic incoming completion. There is no partner credential in the wallet bundle or remote config.

The `swap` place rules also cover the Near Intents tab. Deploy a feature-eligibility service that reads the `nearIntents` section before activation, so that it recognizes an enabled NEAR Intents configuration.

## Hermetic E2E gate

The local fake service is available only in the dedicated E2E build when all of these values match:

| Build/config value | Required value |
| --- | --- |
| `MIDEN_NETWORK` | `localhost` |
| `MIDEN_E2E_TEST` | `true` |
| `MIDEN_E2E_ONE_CLICK_TESTNET` | `true` |
| Remote config document network | `localnet` |
| `features.nearIntents` | `true` |
| `nearIntents.serviceUrl` | Loopback HTTP or HTTPS |
| `MIDEN_E2E_ONE_CLICK_MANAGER_PUBLIC_KEY` | The fake service's exported public key |

Missing or mismatched values hide NEAR Intents outside mainnet and keep the production signer pinned. Ordinary extension/background builds default the dedicated flag to `false` and the test key to empty. Testnet and other network documents cannot enable this local path.

The hermetic OneClick E2E uses a dedicated Reown project whose allowed origins include `chrome-extension://dfkbipcpggpmndndboecmjgjdgcncbhl`. Set `WALLETCONNECT_PROJECT_ID` for the local extension build and `WC_COUNTERPARTY_PROJECT_ID` for the Node counterparty runtime. CI supplies both from the `WALLETCONNECT_ONE_CLICK_E2E_PROJECT_ID` secret. The stable manifest key is injected only when both `MIDEN_E2E_TEST` and `MIDEN_E2E_ONE_CLICK_TESTNET` are `true`; ordinary and production builds are unchanged. Do not put the Project ID value in this guide or commit it.

The official SDK API/signature reference was fetched from `@defuse-protocol/one-click-sdk-typescript@0.1.25`. The npm registry's SHA-512 integrity is `y8fm8V7bPKYfJrhJOUWMG5/IFb1aMcIFHiM5PRDQngd33enhcDGGYJCNwM6y5o4pZZtlU1FroHB8OlA3NkxhzQ==`; the downloaded archive matched that integrity before inspection. The SDK signs a selected flattened payload. Its signature excludes `appFees`, partner ID, session ID, connected wallets, and deposit mode, so those fields are checked against fixed service configuration independently.
