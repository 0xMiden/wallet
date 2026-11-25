# EVM relay

This Worker relays the EVM side of the deposit-address bridge. A user sends tokens to an EVM address that the wallet derives. The wallet signs an EIP-7702 batch for the Uniswap Calibur account at that address. The Worker builds the calls of the batch again from the request parameters, simulates the batch, and submits it from its relayer account, which pays the gas. In `deduct` mode, the batch also pays a fixed token fee to a fee recipient.

This Worker is separate from `services/wallet-api`. The wallet-api Worker stores encrypted backups, and it must not share a deploy with a funded key.

## State of this service

The service contains the config parse, the router, CORS, the error bodies, the rate limits, `/healthz` and the account read. It derives the relayer address from its key but does not sign. It has no Durable Object and no deploy workflow.

| Route | State |
| --- | --- |
| `GET /healthz` | Implemented |
| `GET /v1/account` | Implemented |
| `POST /v1/relay` | Registered and rate limited. Answers `501 not_implemented` |
| `GET /v1/relay/{id}` | Registered and rate limited. Answers `501 not_implemented`, or `404 not_found` when `{id}` is not `0x` and 64 hex characters |

Later PRs implement the two relay routes to the contract below.

## Source layout

| File | Responsibility |
| --- | --- |
| `src/index.ts` | The entry: CORS gate, `handleRequest`, the default `fetch` |
| `src/router.ts` | Typed route match, the method check, the rate limit and the dispatch |
| `src/config.ts` | Strict parse of `GAS_MODE`, `ALLOWED_ORIGINS` and `RELAY_CONFIG` into `RelayConfig` |
| `src/rate-limit.ts` | The read and relay rate limits per caller IP, and the read limit per address |
| `src/secrets.ts` | The relayer address from `RELAYER_PRIVATE_KEY`, and the `RPC_URL_<chainId>` of a chain |
| `src/chain.ts` | The chain reader: the reads of one account in JSON-RPC batches |
| `src/routes/health.ts` | `/healthz` |
| `src/routes/account.ts` | `GET /v1/account` |
| `src/http.ts` | Responses, body read with the 64 KiB cap, CORS |
| `src/errors.ts` | `ApiError` and its helpers |
| `src/types.ts` | `Env`, `RequestContext`, `ErrorCode` and the wire shapes |

The source is TypeScript. Wrangler bundles it directly, with no build step. Request bodies and variables enter as `unknown`, and runtime checks narrow them to the typed shapes. The code uses no `any` and no type assertion.

## Environment and secrets

| Name | Kind | Purpose |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | Worker variable | JSON array of exact allowed origins, no wildcard. `[]` refuses every request that sends an `Origin` header |
| `DEPLOYMENT_REVISION` | Worker variable | The source commit that `/healthz` reports |
| `GAS_MODE` | Worker variable | `sponsor`: the relayer pays the gas. `deduct`: each token pays a fixed fee to `feeRecipient` |
| `RELAY_CONFIG` | Worker variable | JSON of the chains, below |
| `READ_RATE_LIMIT` | Rate limit binding | About 60 requests per caller IP per 60 seconds, on the key `read:<CF-Connecting-IP>`. Counts `GET /v1/account` and `GET /v1/relay/{id}`. `GET /v1/account` also counts on the key `read-address:<address>`, so all callers of one address share one budget |
| `RELAY_RATE_LIMIT` | Rate limit binding | About 10 requests per caller IP per 60 seconds, on the key `relay:<CF-Connecting-IP>`. Counts `POST /v1/relay` |
| `RELAYER_PRIVATE_KEY` | Worker secret | The key of the relayer account, `0x` and 64 hex characters. The relayer executes the batches and pays the gas. Today the Worker only derives the `executor` address from it. The Worker never logs it |
| `RPC_URL_<chainId>` | Worker secret | The HTTP(S) JSON-RPC URL of each chain in `RELAY_CONFIG`, for example `RPC_URL_8453`. It is a paid URL: the Worker sends it only the reads of `GET /v1/account` and never forwards a caller's RPC request |

The committed `wrangler.jsonc` holds placeholders: `ALLOWED_ORIGINS` is `[]`, `DEPLOYMENT_REVISION` is `unknown`, `GAS_MODE` is `sponsor` and `RELAY_CONFIG` has no chains. The rate limits use the namespace ids 189405 and 189406; 189401 to 189404 belong to the other Workers of the account.

`RELAY_CONFIG` has this shape:

```json
{ "chains": { "<chainId as decimal string>": {
    "calibur": { "address": "0x<40 hex>", "runtimeHash": "0x<64 hex>", "domainName": "Calibur", "domainVersion": "1.0.0" },
    "feeRecipient": "0x<40 hex>",
    "agglayer": { "bridgeAddress": "0x<40 hex>", "midenNetworkId": 1, "forceUpdateGlobalExitRoot": true },
    "tokens": { "0x<token address, zero address = native coin>": { "minAmount": "<positive decimal integer>", "fee": "<non-negative decimal integer>" } }
} } }
```

The parse is strict. It refuses an unknown field and a missing field, and it lower-cases every address and hash.

- A chain id is a positive safe integer.
- An address is 20 bytes of hex. Only a token key can be the zero address, which means the native coin.
- A hash is 32 bytes of hex. `domainName` and `domainVersion` are non-empty strings.
- `midenNetworkId` is an integer from 0 to 2^32-1. `forceUpdateGlobalExitRoot` is a boolean.
- `minAmount` and `fee` are decimal strings below 2^256. `minAmount` is above 0.
- `feeRecipient` and `agglayer` are optional. When `GAS_MODE` is `deduct`, every chain needs `feeRecipient`, and every token needs a `fee` above 0 and a `minAmount` above its `fee`.
- An empty `chains` object is valid.

`/healthz` answers `200 {"ok":true,"revision":"<DEPLOYMENT_REVISION>"}` when the variables parse, both rate limit bindings are present, `RELAYER_PRIVATE_KEY` is a valid key and each chain in `RELAY_CONFIG` has a valid `RPC_URL_<chainId>`. Else it answers `503` with `ok: false`. It never puts a variable or a secret in its body.

The Worker writes logs, with invocation logs off. `GET /v1/account` writes one line when the chain does not hold the pinned Calibur code or the signing domain is not the expected one; the line has no request data. Later PRs write one line when the relayer account has no funds. The Worker never logs a request body.

## Account read

`GET /v1/account` charges the caller IP, checks the query, then charges the address. Then it reads the chain in two JSON-RPC batches, with one time budget of 8 seconds for both:

1. The code of the address, its pending transaction count, the balance of each configured token (`eth_getBalance` for the native coin, `balanceOf` for an ERC-20) and, when the memory cache has none, the code at the Calibur address. The Worker checks that the keccak256 of the Calibur code is `runtimeHash`, and keeps the verified code in isolate memory for 5 minutes per chain.
2. `getSeq(nonceKeyOf(kind))` for each relay kind of the chain and `eip712Domain()`, both on the address. When the address does not delegate to the pinned Calibur, both calls send a state override that puts the Calibur code on the address, because the storage of an earlier delegation stays. The Worker checks that the domain has the configured name and version, the chain id, the address as verifying contract, and the Calibur address in the last 20 bytes of the salt.

One call thus makes two HTTP requests to the RPC, cold or warm. A failed request, an RPC error in the batch or a time-out gives `502 rpc_unavailable`. A wrong Calibur code or domain gives `503 service_unavailable`.

The 200 response has `Cache-Control: private, max-age=5`, so the browser of the caller can reuse it for 5 seconds. The Worker keeps no shared cache of the response: the Cloudflare documentation does not confirm that the Cache API works on a `workers.dev` hostname ("Workers deployed to custom domains have access to functional `cache` operations").

## Local run

Use Wrangler 4.151.3. Every package resolves from the repository root: `yarn install` at the root installs `@cloudflare/workers-types` and TypeScript. Do not run `npm install` in this directory.

```sh
yarn install   # at the repository root, once
cd services/evm-relay
yarn build     # tsc --noEmit on the Worker and on its tests
yarn dev       # wrangler dev on port 8788
yarn test      # the Jest suites in test/
```

Local state goes to `.wrangler/`, and local secrets go to `.dev.vars`. Git ignores both. Requests without an `Origin` header, such as `curl`, pass the CORS gate.

## API contract

This section is the reference for the wallet client. `GET /v1/account` implements it; later PRs implement the two relay routes.

All amounts are decimal strings in token base units. Addresses and hashes are lower-case hex in responses. The zero address means the native coin.

`GET /v1/account?chainId=<int>&address=<0x40hex>` returns everything the wallet needs to sign:

```
200 { chainId, address,
      mode: "sponsor" | "deduct",
      executor: <address of the relayer; the only account that may execute the batch>,
      feeRecipient: <address> | null,
      needsAuthorization: <boolean; true when the address does not delegate to the pinned Calibur>,
      authorizationNonce: <number; the pending transaction count of the address>,
      salt: <0x64hex; the Calibur EIP-712 domain salt of the address>,
      kinds: { "agglayer-deposit": { sequence: "<decimal>" } },
      balances: [ { token, balance, minAmount, fee } ] }
```

- `kinds["agglayer-deposit"]` is present only when the chain has an `agglayer` config.
- `balances` lists every configured token of the chain in config order.
- In `sponsor` mode every `fee` is `"0"` and `feeRecipient` is `null`, whatever the config holds. In `deduct` mode they are the configured values.
- Errors: `invalid_request` for a bad `chainId` or `address`, or for the relayer's own address; `unsupported_chain` for a chain that is not in `RELAY_CONFIG`.

`POST /v1/relay` with

```
{ chainId, kind: "agglayer-deposit", evmAddress,
  params: { token, amount, midenAccountHex, fee },   // amount = bridged amount after the fee; fee = "0" in sponsor mode
  batchNonce: "<decimal>", salt, deadline: <unix seconds>,
  signature: <0x130hex>,
  authorization?: { address, chainId, nonce, r, s, yParity } }
→ 200 { id: <0x64hex, the EIP-712 digest of the batch>, state: "pending", txHash }
```

The server builds the calls again from `params`; it never accepts calldata. The request authenticates itself through the signature; there is no login. The same request sent again returns the same answer.

`GET /v1/relay/{id}` → `200 { id, state: "pending" | "succeeded" | "reverted", txHash }` or `404 not_found`.

An error body is `{ "error": "<code>", "message": "<text>", "retryAfter"?: <seconds> }`. Error codes and status:

| Code | Status | Meaning |
| --- | --- | --- |
| `invalid_request` | 400 | The request is malformed |
| `unsupported_chain` | 400 | The chain is not in `RELAY_CONFIG` |
| `unsupported_kind` | 400 | The kind is not known |
| `token_not_allowed` | 400 | The token is not in the chain's tokens |
| `below_minimum` | 400 | The amount is below `minAmount` |
| `fee_too_low` | 400 | The fee is below the configured fee |
| `bad_signature` | 400 | The signature or the authorization does not verify |
| `stale_request` | 409 | A nonce, the salt or the authorization is out of date: read `/v1/account` and sign again |
| `simulation_failed` | 409 | The batch fails in simulation |
| `busy` | 409 | Another relay is open for the address; the body also carries its `id` |
| `relayer_unfunded` | 503 | The relayer account cannot pay the gas |
| `rpc_unavailable` | 502 | The chain RPC does not answer |
| `rate_limited` | 429 | Too many requests. The response has `Retry-After: 60` and `retryAfter: 60` |
| `origin_not_allowed` | 403 | The `Origin` is not in `ALLOWED_ORIGINS`, or a preflight asks for a method or header the API does not allow |
| `not_found` | 404 | The route or the relay does not exist |
| `method_not_allowed` | 405 | The route does not allow the method. The `Allow` header names the method |
| `payload_too_large` | 413 | The body is over 64 KiB |
| `not_implemented` | 501 | The route is not implemented yet |

Two more codes report a broken deployment, not a bad request: `service_unavailable` 503 (a variable does not parse or a binding is missing) and `internal_error` 500 (an unexpected failure).
