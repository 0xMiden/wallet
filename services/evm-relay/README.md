# EVM relay

This Worker relays signed EVM batches for the relay addresses of the wallet. A relay address is an EOA that the wallet derives and that delegates to Uniswap Calibur through EIP-7702. The wallet puts the calls that it must send in a Calibur "signed batched call" and signs the batch with the key of the relay address. The Worker checks the batch, simulates it, and submits it from its relayer account, which pays the gas. In `deduct` mode, the last call of the batch pays a fixed token fee to a fee recipient.

This Worker is separate from `services/wallet-api`. The wallet-api Worker stores encrypted backups, and it must not share a deploy with a funded key.

## State of this service

The service contains the config parse, the router, CORS, the error bodies, the rate limits, `/healthz`, the account read, the relay routes and the Sender Durable Object with its timer. The deploy workflow is `.github/workflows/deploy-evm-relay.yml` (see Deployment).

| Route | State |
| --- | --- |
| `GET /healthz` | Implemented |
| `GET /v1/account` | Implemented |
| `POST /v1/relay` | Implemented |
| `GET /v1/relay/{id}` | Implemented |

## Source layout

| File | Responsibility |
| --- | --- |
| `src/worker.ts` | The Wrangler entry: exports the default `fetch` of `index.ts` and the Durable Object class |
| `src/index.ts` | CORS gate, `handleRequest`, the default `fetch` |
| `src/router.ts` | Typed route match, the method check, the rate limit and the dispatch |
| `src/config.ts` | Strict parse of `GAS_MODE`, `ALLOWED_ORIGINS` and `RELAY_CONFIG` into `RelayConfig` |
| `src/parse.ts` | The strict parse helpers of the config and the request bodies |
| `src/rate-limit.ts` | The read and relay rate limits per caller IP and per address |
| `src/secrets.ts` | The relayer address from `RELAYER_PRIVATE_KEY`, and the `RPC_URL_<chainId>` of a chain |
| `src/chain.ts` | The chain reader (the account reads and the relay read, in JSON-RPC batches), the receipt and fee reads of the Sender, and the broadcast |
| `src/sender.ts` | `RelaySender`: the nonce, the signature, the stored row, the broadcast and the timer. Also the route's Sender client |
| `src/sender-object.ts` | `RelaySenderObject`: the Durable Object that wraps `RelaySender` and runs its alarm |
| `src/routes/health.ts` | `/healthz` |
| `src/routes/account.ts` | `GET /v1/account` |
| `src/routes/relay.ts` | `POST /v1/relay` |
| `src/routes/relay-status.ts` | `GET /v1/relay/{id}` |
| `src/http.ts` | Responses, body read with the 64 KiB cap, CORS |
| `src/errors.ts` | `ApiError` and its helpers |
| `src/types.ts` | `Env`, `RequestContext`, `ErrorCode` and the wire shapes |

The source is TypeScript. Wrangler bundles it directly, with no build step. Request bodies and variables enter as `unknown`, and runtime checks narrow them to the typed shapes. The code uses no `any` and no type assertion.

## Environment and secrets

| Name | Kind | Purpose |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | Worker variable | JSON array of exact allowed origins, no wildcard. `[]` refuses every request that sends an `Origin` header |
| `DEPLOYMENT_REVISION` | Worker variable | The source commit that `/healthz` reports |
| `GAS_MODE` | Worker variable | `sponsor`: the relayer pays the gas. `deduct`: each batch pays a fixed token fee to `feeRecipient` |
| `RELAY_CONFIG` | Worker variable | JSON of the chains, below |
| `READ_RATE_LIMIT` | Rate limit binding | About 60 requests per caller IP per 60 seconds, on the key `read:<CF-Connecting-IP>`. Counts `GET /v1/account` and `GET /v1/relay/{id}`. `GET /v1/account` also counts on the key `read-address:<address>`, so all callers of one address share one budget |
| `RELAY_RATE_LIMIT` | Rate limit binding | About 10 requests per caller IP per 60 seconds, on the key `relay:<CF-Connecting-IP>`. Counts `POST /v1/relay`. A relay that passes the signature checks also counts on the key `relay-address:<evmAddress>` |
| `RELAY_SENDER` | Durable Object binding | The class `RelaySenderObject`, with SQLite storage (migration `v1`, `new_sqlite_classes`). One object per chain, named by the decimal chain id |
| `RELAYER_PRIVATE_KEY` | Worker secret | The key of the relayer account, `0x` and 64 hex characters. The relayer executes the batches and pays the gas. The Worker derives the `executor` address from it, and the Sender signs the relay transactions with it. The Worker never logs it |
| `RPC_URL_<chainId>` | Worker secret | The HTTP(S) JSON-RPC URL of each chain in `RELAY_CONFIG`, for example `RPC_URL_8453`. It is a paid URL: the Worker sends it only its own reads and signed relay transactions, and never forwards a caller's RPC request |

The committed `wrangler.jsonc` holds placeholders: `ALLOWED_ORIGINS` is `[]`, `DEPLOYMENT_REVISION` is `unknown`, `GAS_MODE` is `sponsor` and `RELAY_CONFIG` has no chains. The rate limits use the namespace ids 189405 and 189406; 189401 to 189404 belong to the other Workers of the account.

`RELAY_CONFIG` has this shape:

```json
{ "chains": { "<chainId as decimal string>": {
    "calibur": { "address": "0x<40 hex>", "runtimeHash": "0x<64 hex>", "domainName": "Calibur", "domainVersion": "1.0.0" },
    "feeRecipient": "0x<40 hex>",
    "fees": { "0x<token address; zero address = native coin>": "<positive decimal integer>" },
    "allowedTargets": ["0x<40 hex>"]
} } }
```

The parse is strict. It refuses an unknown field and a missing field, and it lower-cases every address and hash.

- A chain id is a positive safe integer.
- An address is 20 bytes of hex. Only a key of `fees` can be the zero address, which means the native coin.
- A hash is 32 bytes of hex. `domainName` and `domainVersion` are non-empty strings.
- `calibur` is required. `feeRecipient`, `fees` and `allowedTargets` are optional.
- `fees` maps a token to its fee in base units: a decimal string above 0 and below 2^256. A token occurs one time only, in any case. No `fees` is the same as `{}`. The Worker keeps the config order.
- `allowedTargets` is a non-empty list of distinct addresses that are not the zero address. Without it, a call can go to any address.
- When `GAS_MODE` is `deduct`, every chain needs `feeRecipient` and at least one entry in `fees`.
- An empty `chains` object is valid.

### No bridge code

The Worker does not know a bridge. A bridge flow in the wallet gives the transactions that it must send (`to`, `value`, `data`). The wallet puts them in a batch as calls, signs the batch and sends the calls in the relay request. The Worker relays the calls as the request sends them, in the same order, and never builds a call. It checks only rules that do not depend on a bridge: the signature, the nonce key, the deadline, the fee call in `deduct` mode, and `allowedTargets` when the chain has it. A new bridge thus needs no change to the Worker; if the chain has `allowedTargets`, add the contracts of the bridge to the list.

In `sponsor` mode a chain without `allowedTargets` pays the gas of any batch that a relay address signs, whatever its calls do. The rate limits are then the only bound on that cost. Set `allowedTargets` on a `sponsor` chain to limit the gas to the calls of known contracts.

`/healthz` answers `200 {"ok":true,"revision":"<DEPLOYMENT_REVISION>"}` when the variables parse, both rate limit bindings and the `RELAY_SENDER` binding are present, `RELAYER_PRIVATE_KEY` is a valid key and each chain in `RELAY_CONFIG` has a valid `RPC_URL_<chainId>`. Else it answers `503` with `ok: false`. It never puts a variable or a secret in its body.

The Worker writes logs, with invocation logs off. `GET /v1/account` writes one line when the chain does not hold the pinned Calibur code or the signing domain is not the expected one; the line has no request data. `POST /v1/relay` writes `evm-relay: the relayer account cannot pay the gas on chain <chainId>.` when it answers `relayer_unfunded`. The Sender timer writes `evm-relay: replaced the fee of nonce <nonce> on chain <chainId>, attempt <n>.` for each fee replacement, and `evm-relay: a Sender tick failed on chain <chainId>.` when a tick fails. The Worker never logs a request body, a signature, an authorization, signed transaction bytes or an RPC URL.

## Account read

`GET /v1/account` charges the caller IP, checks the query, then charges the address. Then it reads the chain in two JSON-RPC batches, with one time budget of 8 seconds for both:

1. The code of the address, its pending transaction count, the balance of each token of the `tokens` query (`eth_getBalance` for the native coin, `balanceOf` for an ERC-20) and, when the memory cache has none, the code at the Calibur address. The Worker checks that the keccak256 of the Calibur code is `runtimeHash`, and keeps the verified code in isolate memory for 5 minutes per chain.
2. `getSeq(RELAY_NONCE_KEY)` and `eip712Domain()`, both on the address. When the address does not delegate to the pinned Calibur, both calls send a state override that puts the Calibur code on the address, because the storage of an earlier delegation stays. The Worker checks that the domain has the configured name and version, the chain id, the address as verifying contract, and the Calibur address in the last 20 bytes of the salt.

One call thus makes two HTTP requests to the RPC, cold or warm. A failed request, an RPC error in the batch or a time-out gives `502 rpc_unavailable`. A wrong Calibur code or domain gives `503 service_unavailable`.

The 200 response has `Cache-Control: private, max-age=5`, so the browser of the caller can reuse it for 5 seconds. The Worker keeps no shared cache of the response: the Cloudflare documentation does not confirm that the Cache API works on a `workers.dev` hostname ("Workers deployed to custom domains have access to functional `cache` operations").

## Relay

`POST /v1/relay` runs its checks from the cheapest to the most expensive. A failed check stops the request.

1. The caller IP is charged on `relay:<CF-Connecting-IP>`. The body is read with the 64 KiB cap, and every field is parsed strictly. An unknown field is refused. `calls` has 1 to 8 calls; a call has a `to` that is not the zero address, a decimal `value` below 2^256 and `data` of whole bytes of hex (`0x` is valid).
2. The chain (`unsupported_chain`).
3. The envelope: `evmAddress` is not the relayer (`invalid_request`), `isRelayNonce(batchNonce)` is true, so the top 192 bits are `RELAY_NONCE_KEY` (`invalid_request`), and the deadline is more than 60 seconds and at most 24 hours and 5 minutes after now (`stale_request`).
4. The fee rule. `sponsor` mode has none. In `deduct` mode the batch needs a call before the fee call (`invalid_request`), and the last call must be a fee call that `readFeeCall` reads, to the chain's `feeRecipient`, in a token of `fees`, of at least the configured fee of that token (`fee_too_low`). A fee call is an ERC-20 `transfer(recipient, amount)` with no value, or a native transfer of `amount` with no data.
5. The target rule: when the chain has `allowedTargets`, every call must go to an address in the list (`target_not_allowed`). In `deduct` mode the fee call that step 4 checked is not in this rule.
6. The Worker builds the batch from the calls exactly as the request sends them, in the same order. It recovers the batch signer and compares it with `evmAddress` (`bad_signature`). The `id` is the EIP-712 digest of the batch.
7. An authorization must name the pinned Calibur and the chain, have an `s` of at most secp256k1n/2, and recover to `evmAddress` (`bad_signature`).
8. The address is charged on `relay-address:<evmAddress>`.
9. When the Sender already holds a relay with this `id`, the route answers it and reads nothing from the chain.
10. One JSON-RPC batch reads the code and the pending nonce of the address, the pending nonce and the balance of the relayer, `eth_feeHistory` (the base fee of the next block), `eth_maxPriorityFeePerGas`, `eth_estimateGas` from the relayer to the address with the `execute` calldata, and `getSeq(RELAY_NONCE_KEY)` on the address. The estimate includes the authorization list when the request has an authorization: a plain `eth_call` on an address that does not delegate executes nothing and succeeds, so it checks nothing. The `getSeq` call sends a state override that puts the EIP-7702 delegation to the pinned Calibur (`0xef0100` and the Calibur address) on the address, because the storage of an earlier delegation stays. For an address that delegates to the pinned Calibur, the override is its own code and changes nothing. The account read puts the verified Calibur code itself on the address; the relay read cannot, because that code is in the memory of some isolates only, and a second request to read it would cost one more HTTP request.
11. An address that does not delegate to the pinned Calibur needs an authorization whose nonce is its pending nonce (`stale_request`). An address that delegates gets no authorization list; the route ignores a supplied one.
12. The low 64 bits of `batchNonce` must be the sequence that `getSeq` read (`stale_request`). A lower sequence was used by an earlier batch, and a higher one is not reached yet. This check comes before the estimate is judged, because the simulation of such a batch reverts: a stale batch never gives `simulation_failed`.
13. A revert of the estimate gives `409 simulation_failed`. An RPC failure of any call of the batch, `getSeq` included, gives `502 rpc_unavailable`.
14. The gas limit is the estimate plus 20 %. `maxPriorityFeePerGas` is the node's value and `maxFeePerGas` is twice the base fee plus that value. A relayer balance below `gasLimit × maxFeePerGas` gives `503 relayer_unfunded` and one log line.
15. The route hands the job to the Sender of the chain and answers its result.

One new relay thus makes two HTTP requests to the RPC: the read batch and the broadcast. A repeated request makes none.

When the address delegates already and the request still has an authorization, the estimate includes that authorization but the transaction does not. A node skips an authorization that does not apply, so the gas limit is then a little higher than needed, never too low.

### Sender

The Sender is the Durable Object `RelaySenderObject` (binding `RELAY_SENDER`, SQLite storage). The route reaches the object of a chain with `idFromName(String(chainId))`, so one object owns the relayer nonce of one chain. The logic is the plain class `RelaySender` in `src/sender.ts`; the object only gives it the SQL storage, the alarm (`getAlarm`, `setAlarm` and the `alarm()` handler), the relayer key and its address, the RPC reads and the broadcast, and the clock. The Jest tests run `RelaySender` on `node:sqlite` with a fake chain and a fake alarm.

Its storage has two tables, created in the constructor:

- `meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)`: `next_nonce` (the nonce after the last stored transaction), `chain_id` (the Sender refuses a job of another chain) and `relayer` (the address of the key that `next_nonce` counts for).
- `inflight`: `id` (primary key, the batch digest), `evm_address`, `relayer` (the address of the key that signed the row), `tx_hash` (the current hash; the mined hash once final), `sent_hashes` (JSON array of every hash broadcast for the row, the current one last), `raw_tx` and `request` (the signed bytes, and JSON of `to`, `data`, `gas` and `authorization` for a fee replacement; `data` is the `execute` calldata, which holds every call of the batch in the signed order; both null once the row is final, because both hold the user's signature), `nonce`, `max_fee`, `max_priority_fee` (decimal text), `deadline` (unix seconds), `state` (`pending`, `succeeded` or `reverted`), `attempts` (signatures of the row), `nonce_used` (1 when a node said that a mined transaction holds the nonce), `created_at`, `signed_at` (the last signature), `updated_at` (milliseconds). A check refuses a `pending` row without `raw_tx` or `request`. Two partial unique indexes allow one `pending` row per `evm_address` and one `pending` row per `(relayer, nonce)`.

No Sender is deployed yet, so the schema has no migration: `CREATE TABLE IF NOT EXISTS` builds it in a new object.

`submit(job)` does this:

1. Delete the final rows whose `updated_at` is more than 24 hours ago (the cleanup).
2. A row with the `id` exists: return it.
3. A `pending` row of the address exists: the route answers `409 busy` with that row's `id`.
4. Read the address of the current relayer key. When it is not `meta.relayer`, delete `next_nonce` and store the new address (see the key change below).
5. `nonce = max(the relayer's pending nonce that the route read, next_nonce)`.
6. Sign with `RELAYER_PRIVATE_KEY`: type 4 (EIP-7702) when the job has an authorization, else type 2. The transaction hash is the keccak256 of the signed bytes.
7. In one storage transaction, insert the row with the signed bytes and set `next_nonce = nonce + 1`.
8. When a pending row exists and no alarm is armed after now, arm the alarm 30 seconds ahead.
9. Only then broadcast with `eth_sendRawTransaction`. "already known" counts as success. A failed broadcast does not fail the request and does not delete the row; the timer sends the same bytes again.
10. Return `{ id, state: "pending", txHash }`.

Steps 1 to 8 run in an exclusive section: a promise queue in the object lets one task at a time run them, and the next one starts only after the row of the one before is committed (or its signature failed). So two submits never get the same nonce, even when the signer yields to the event loop. The section has only one `await` besides the alarm calls, the signature, which does no I/O; storage calls are synchronous. A nonce is written only in the transaction that stores its signed bytes, so no nonce is reserved without a stored transaction. The unique index on the pending nonce is a second guard. The broadcast runs after the section, so a slow RPC does not hold other submits. The Durable Object output gate also holds the outgoing broadcast until the storage write is durable.

`get(id)` returns `{ id, state, txHash }` or null.

#### Timer

The alarm runs one tick. A tick does this:

1. Delete the final rows whose `updated_at` is more than 24 hours ago. A pending row stays whatever its age.
2. Read every pending row, lowest nonce first, and read the receipt of every hash in `sent_hashes` of every row with `eth_getTransactionReceipt`, in one JSON-RPC batch.
3. When a replacement is due for a row without a receipt (below), read the fees once: `eth_feeHistory` and `eth_maxPriorityFeePerGas` in one batch. A failed fee read only stops the replacements of this tick.
4. In the exclusive section, read the pending rows again (a submit can have stored one since step 2) and, for each row:
   - A receipt with status 1 for any of its hashes: state `succeeded`. Status 0: state `reverted`. `tx_hash` becomes the mined hash; `raw_tx` and `request` become null; `updated_at` is now. One `UPDATE` statement.
   - No receipt and a replacement is due: sign the stored request again at the same nonce with new fees, and store the new hash, bytes and fees, the hash in `sent_hashes`, `attempts + 1` and `signed_at` in one `UPDATE` statement. Write one log line. A failed signature keeps the old bytes.
   - No receipt otherwise: keep the stored bytes.
5. After the section, broadcast the bytes of every row without a receipt, lowest nonce first: the same bytes again, or the replacement. A node can have lost a broadcast or dropped the transaction; the same bytes bring it back. "already known" is a success. "nonce too low" means that a mined transaction holds the nonce: the Sender sets `nonce_used` and the receipt read of a later tick finds the receipt. Any other failure changes nothing.
6. In the exclusive section, arm the next alarm 30 seconds ahead while a pending row remains. With no pending row, the Sender arms nothing, so an idle service costs nothing.

A tick never changes `next_nonce`. A failure of the receipt read changes no row: the tick writes `evm-relay: a Sender tick failed on chain <chainId>.` and still arms the next alarm.

One tick makes one HTTP request for the receipts, one more for the fees when a replacement is due, and one `eth_sendRawTransaction` request per pending row without a receipt.

**Fee replacement.** A replacement is due when the row has no receipt 3 minutes after its last signature (`REPLACE_AFTER_MS`), its batch deadline has not passed, `nonce_used` is 0, and the row was signed by the current relayer key. The new `maxPriorityFeePerGas` is the larger of the node's `eth_maxPriorityFeePerGas` and the old value plus 15 % (rounded up). The new `maxFeePerGas` is the larger of `2 × base fee + priority fee` (the rule of the relay route) and the old value plus 15 %. Nodes refuse a replacement that raises the fees by less than about 10 to 12.5 %. The request (`to`, `data`, `gas`, the authorization list) and the nonce stay the same. There is no fee ceiling and no budget. After a replacement, either transaction can be mined, so the tick reads the receipt of every hash in `sent_hashes`.

**Deadline.** After the batch deadline, `execute` reverts, so the Sender does not replace the fee. It keeps sending the same bytes until a receipt comes, because an empty nonce stops every later relay of the chain.

**Cleanup.** A tick and a submit delete a final row 24 hours after its `updated_at`. No alarm runs only for the cleanup. After the cleanup, `GET /v1/relay/{id}` answers `404` for the row, and the same request sent again is a new relay: a batch that succeeded then fails its simulation, because its Calibur nonce is used.

**Key change.** `next_nonce` counts the nonces of one relayer account. When `RELAYER_PRIVATE_KEY` changes, the next submit sees another address than `meta.relayer`, deletes `next_nonce` and stores the new address, so its nonce is the pending count of the new account that the route read. Each row stores the address that signed it, and the pending nonce index is per relayer, so a pending row of the old key and a row of the new key can have the same nonce. The timer follows a pending row of an old key to its receipt and sends its bytes again, but never replaces its fee: the Sender has no old key to sign with.

**Known limits.**

- A row past its deadline whose `maxFeePerGas` is below the base fee stays pending until the base fee falls below it. Its nonce stops every later relay of the chain for that time. The relay route caps a deadline at 24 hours and 5 minutes, and the last replacement can happen just before the deadline, so the stall starts at most about 24 hours after the request, but its length has no bound. A cancel transaction (a 0-value transfer to the relayer at the same nonce, with current fees) after the deadline would bound it; this service has none.
- A nonce that another transaction of the relayer account took (the key used outside this service) never gets a receipt for the row: the row stays pending and its address stays busy.
- A pending row of an old relayer key can stall the same way, since the Sender cannot replace its fee.
- The Sender records a receipt at once and keeps no signed bytes after that. A reorganisation that drops the mined transaction leaves the row final.
- All receipt reads of one tick go in one JSON-RPC batch. A provider with a small batch limit can refuse a tick with many pending rows and many replacements.

## Local run

Use Wrangler 4.151.3. Every package resolves from the repository root: `yarn install` at the root installs `@cloudflare/workers-types` and TypeScript. Do not run `npm install` in this directory.

```sh
yarn install   # at the repository root, once
cd services/evm-relay
yarn build     # tsc --noEmit on the Worker and on its tests
yarn dev       # wrangler dev on port 8788
yarn test      # the Jest suites in test/
```

The tests of the Sender run its SQL on `node:sqlite`, which Node 22.13 and later load without a flag (Node prints an `ExperimentalWarning`). The Jest tests do not load `src/sender-object.ts` and `src/worker.ts`, because `cloudflare:workers` exists only in the Workers runtime.

Local state goes to `.wrangler/`, and local secrets go to `.dev.vars`. Git ignores both. Requests without an `Origin` header, such as `curl`, pass the CORS gate.

## API contract

This section is the reference for the wallet client. The three routes implement it.

All amounts are decimal strings in token base units. Addresses and hashes are lower-case hex in responses. The zero address means the native coin.

`GET /v1/account?chainId=<int>&address=<0x40hex>[&tokens=<comma list of 1 to 16 addresses; zero address = native coin>]` returns everything the wallet needs to sign:

```
200 { chainId, address,
      mode: "sponsor" | "deduct",
      executor: <address of the relayer; the only account that may execute the batch>,
      feeRecipient: <address> | null,
      needsAuthorization: <boolean; true when the address does not delegate to the pinned Calibur>,
      authorizationNonce: <number; the pending transaction count of the address>,
      salt: <0x64hex; the Calibur EIP-712 domain salt of the address>,
      sequence: "<decimal; getSeq(RELAY_NONCE_KEY) of the address>",
      fees: [ { token, fee } ],
      allowedTargets: [ <address> ] | null,
      balances: [ { token, balance } ] }
```

- The wallet signs with `batchNonce = batchNonceOf(sequence)`.
- `fees` lists the configured fees of the chain in config order in `deduct` mode. In `sponsor` mode `fees` is `[]` and `feeRecipient` is `null`, whatever the config holds.
- `allowedTargets` is the chain's list, or `null` when a call can go to any address. The wallet can check its calls against it before it signs.
- `balances` has one entry for each token of the `tokens` query, in query order, and is `[]` without `tokens`. The tokens need not be in `fees`.
- Errors: `invalid_request` for a bad `chainId` or `address`, for the relayer's own address, and for a bad `tokens` value: an empty value, a value that is not an address, a token that occurs two times (in any case), more than 16 tokens, or a second `tokens` parameter. `unsupported_chain` for a chain that is not in `RELAY_CONFIG`.

`POST /v1/relay` with

```
{ chainId: <number>, evmAddress,
  calls: [ { to: <0x40hex>, value: "<decimal string>", data: "<0x hex, even length, may be 0x>" } ],
  batchNonce: "<decimal; the FULL Calibur nonce: RELAY_NONCE_KEY << 64 | sequence>",
  salt: <0x64hex>, deadline: <JSON number; unix seconds>,
  signature: <0x130hex>,
  authorization?: { address, chainId: <number>, nonce: <number>, r: <0x64hex>, s: <0x64hex>, yParity: 0 | 1 } }
→ 200 { id, state: "pending" | "succeeded" | "reverted", txHash }
```

- `calls` has 1 to 8 calls. `to` is not the zero address. `value` is below 2^256. Addresses and data can be in any case.
- `id` is the EIP-712 digest of the batch, lower case. `txHash` is always present.
- The server builds the batch from `calls` exactly as the request sends them, in the same order, and never adds, removes or changes a call. The request authenticates itself through the signature; there is no login.
- In `deduct` mode the last call is the fee call: `buildFeeCall({ token, recipient: feeRecipient, amount })` with a token of `fees` and an amount of at least its fee. A batch needs at least one other call before it.
- When `allowedTargets` is not null, every call goes to an address in it, except the fee call in `deduct` mode.
- The same request sent again returns the stored relay in its current state (any of the three), not a new transaction. The id is the digest, so a request with another signature encoding of the same batch also returns it.
- A `batchNonce` whose key is not `RELAY_NONCE_KEY` is `invalid_request`. A deadline 60 seconds or less from now, or more than 24 hours and 5 minutes from now, is `stale_request`.
- Send `authorization` when `/v1/account` says `needsAuthorization`, with `nonce` = `authorizationNonce`. For an address that delegates already, the server ignores it.

`GET /v1/relay/{id}[?chainId=<int>]` → `200 { id, state: "pending" | "succeeded" | "reverted", txHash }` or `404 not_found`.

- `{id}` is `0x` and 64 hex characters, in any case. Another value is `404 not_found`, before the rate limit.
- The caller IP is charged on `read:<CF-Connecting-IP>`.
- The id does not name its chain, so the route asks the Sender of each chain of `RELAY_CONFIG` in config order until one knows the id. With `chainId`, it asks only that chain: an unknown chain is `unsupported_chain`, a bad value `invalid_request`.
- The route reads the Sender storage only, never the chain. The timer of the Sender updates `state` and `txHash` (the hash that was mined, which can be an earlier hash than the one `POST /v1/relay` answered, after a fee replacement).
- A final relay is deleted 24 hours after it became final; the route then answers `404`.

An error body is `{ "error": "<code>", "message": "<text>", "retryAfter"?: <seconds> }`. Error codes and status:

| Code | Status | Meaning |
| --- | --- | --- |
| `invalid_request` | 400 | The request is malformed |
| `unsupported_chain` | 400 | The chain is not in `RELAY_CONFIG` |
| `target_not_allowed` | 400 | A call goes to an address that is not in the chain's `allowedTargets` |
| `fee_too_low` | 400 | In `deduct` mode, the last call is not a fee call to `feeRecipient` in a token of `fees`, or it pays less than the configured fee |
| `bad_signature` | 400 | The signature or the authorization does not verify |
| `stale_request` | 409 | The deadline is too near or too far, the authorization is missing or has an old nonce, or the sequence in `batchNonce` is not the current `getSeq(RELAY_NONCE_KEY)` of the address (an earlier batch used it, or the chain has not reached it): read `/v1/account` and sign again |
| `simulation_failed` | 409 | The batch fails in simulation |
| `busy` | 409 | Another relay is open for the address; the body also carries its `id` |
| `relayer_unfunded` | 503 | The relayer account cannot pay the gas |
| `rpc_unavailable` | 502 | The chain RPC does not answer |
| `rate_limited` | 429 | Too many requests. The response has `Retry-After: 60` and `retryAfter: 60` |
| `origin_not_allowed` | 403 | The `Origin` is not in `ALLOWED_ORIGINS`, or a preflight asks for a method or header the API does not allow |
| `not_found` | 404 | The route or the relay does not exist |
| `method_not_allowed` | 405 | The route does not allow the method. The `Allow` header names the method |
| `payload_too_large` | 413 | The body is over 64 KiB |

Two more codes report a broken deployment, not a bad request: `service_unavailable` 503 (a variable does not parse or a binding is missing) and `internal_error` 500 (an unexpected failure).

## Deployment

Every deploy is `.github/workflows/deploy-evm-relay.yml`, started by hand from the Actions tab. The workflow has only a `workflow_dispatch` trigger. Run it with a published release tag (`deployment_source: published-release` and `release_tag`), or with `deployment_source: main` from `main`. A published release or a merge into `main` deploys nothing. The job runs in the GitHub environment `evm-relay-production`, and one deploy runs at a time.

The job does these steps in this order:

1. It checks out the chosen source and installs the dependencies.
2. It type-checks the Worker.
3. `prepare-deployment.mjs` checks the release values (below). Then it writes a release copy of `wrangler.jsonc` with the real variables and a secrets file, both to `RUNNER_TEMP` with mode 0600. The committed `wrangler.jsonc` does not change, and no file goes into the repository or an artifact.
4. `wrangler deploy --config <release copy> --secrets-file <secrets file>` deploys the Worker. The Durable Object migration (`v1`, `new_sqlite_classes`) is in `wrangler.jsonc`, so the deploy applies it. There is no database step.
5. `check-deployment.mjs` probes the deployment (below).
6. The last step removes the two files, also when a step before it fails.

### Secrets and variables

The workflow reads these from the repository's Actions secrets and variables, or from the GitHub environment `evm-relay-production` when an admin creates one with required reviewers. The workflow names that environment, so GitHub creates it without rules on the first run.

| Name | Kind | Value |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret | A token with Workers Scripts: Edit and Account Settings: Read on the Cloudflare account of the Worker. The wallet-api deploy uses the same name |
| `CLOUDFLARE_ACCOUNT_ID` | secret | That account's id |
| `EVM_RELAY_RELAYER_PRIVATE_KEY` | secret | The key of the relayer account, `0x` and 64 hex characters. It becomes the Worker secret `RELAYER_PRIVATE_KEY` |
| `EVM_RELAY_RPC_URLS` | secret | One JSON object of decimal chain id to the `https:` JSON-RPC URL of that chain, for example `{"8453":"https://base.example/v2/<key>"}`. Each entry becomes the Worker secret `RPC_URL_<chainId>` |
| `EVM_RELAY_ALLOWED_ORIGINS` | variable | JSON array of exact wallet origins, no wildcard: each store extension origin `chrome-extension://<id>`, iOS `capacitor://localhost`, Android `http://localhost`, desktop `http://tauri.localhost` and `tauri://localhost`. It becomes `ALLOWED_ORIGINS` |
| `EVM_RELAY_GAS_MODE` | variable | `sponsor` or `deduct`. It becomes `GAS_MODE` |
| `EVM_RELAY_CONFIG` | variable | The `RELAY_CONFIG` JSON (shape above) with at least one chain. It becomes `RELAY_CONFIG` |
| `EVM_RELAY_URL` | variable | The base URL of the deployed Worker, `https:` and no trailing slash, for example `https://miden-evm-relay.<subdomain>.workers.dev` |

The workflow sets `DEPLOYMENT_REVISION` to the deployed commit. The RPC URLs are one secret, so a new chain needs no change to the workflow: add the chain to `EVM_RELAY_CONFIG` and its URL to `EVM_RELAY_RPC_URLS`. GitHub masks a secret only as a whole value, not each URL in it. The scripts never print a secret or a part of one, and Wrangler prints each secret as `(hidden)`.

### Release check

`prepare-deployment.mjs` stops the job before the deploy when a value is wrong. Its message names the setting, and never the value of a secret. It checks that:

- every setting in the table is set;
- `EVM_RELAY_GAS_MODE` is `sponsor` or `deduct`;
- `EVM_RELAY_RELAYER_PRIVATE_KEY` is `0x` and 64 hex characters, and a valid secp256k1 key;
- `EVM_RELAY_ALLOWED_ORIGINS` is a nonempty JSON array of strings with no wildcard;
- `EVM_RELAY_URL` is `https:` with no credentials, query, fragment or trailing slash;
- `EVM_RELAY_CONFIG` is JSON with at least one chain, and the Worker's own `parseConfig` (`src/config.ts`) accepts it with the gas mode and the origins. esbuild bundles that parse in memory, so the deploy refuses a config that the live Worker would refuse;
- `EVM_RELAY_RPC_URLS` is a JSON object with an `https:` URL for every chain of the config, and with no URL for a chain that the config does not name;
- `wrangler.jsonc` has the two rate limit bindings (60 and 10 per 60 seconds, two namespaces) and binds `RELAY_SENDER` to `RelaySenderObject` with its SQLite migration.

The step log then prints `Relayer address (executor): 0x…`, the address that the key derives. The address is public.

### Deploy probe

After the deploy, `check-deployment.mjs` checks that:

- `GET /healthz` answers `200` with `ok: true`, the deployed revision and `Cache-Control: no-store`. It tries 5 times, 2 seconds apart. `ok: true` means that the variables parse, the bindings exist, the key is valid and each chain has an RPC URL;
- a CORS preflight of `POST /v1/relay` from the first configured origin answers `204` with that origin, `Vary: Origin`, the methods `GET` and `POST` and the header `content-type`;
- `GET /healthz` from an unknown origin answers `403` with no `Access-Control-Allow-Origin`;
- `GET /v1/account` with no query, from the first configured origin, answers `400 invalid_request`. The route parses the config before it checks the query, so this proves that the router and the config are live. It reads no chain.

The probe sends no relay and writes no data. Run it by hand with `EVM_RELAY_URL`, `EVM_RELAY_ALLOWED_ORIGINS` and `EVM_RELAY_REVISION` set: `yarn check-deployment` in this folder.

### One-time setup

1. Choose the Cloudflare account. The rate limit bindings need no resource: their `namespace_id` (189405 and 189406) is an integer that no other rate limit binding of the account may use. If the account uses those ids already, choose two free ids in `wrangler.jsonc`.
2. Create a new relayer key for this service only. Do not reuse a key of another service.
3. Set the secrets and the variables in the table.
4. Run the workflow. The step log prints the relayer address.
5. Fund the relayer address on each chain of the config with a small amount of the native coin. The relayer pays the gas of every relay in both gas modes. `/healthz` does not check the balance, so a deploy passes with no funds. After the deploy, `GET /v1/account?chainId=<id>&address=<any address>` also gives the address as `executor`.
6. Set the `relay` section of the `0xMiden/wallet-config` document. The wallet reads the service URL, the executor address and the Calibur pin from that section. The executor there must be the address of the deployed key: the wallet signs batches that only that executor can run.

### Change the gas mode or the config

`GAS_MODE`, `ALLOWED_ORIGINS` and `RELAY_CONFIG` are variables of the deploy. Change `EVM_RELAY_GAS_MODE`, `EVM_RELAY_ALLOWED_ORIGINS` or `EVM_RELAY_CONFIG` (and `EVM_RELAY_RPC_URLS` for a new chain), then run the workflow again. A change in the dashboard does not last: each deploy sets the variables again. `deduct` mode needs a `feeRecipient` and at least one entry in `fees` on every chain, and the release check refuses a config without them. Update the wallet-config `relay` section when it names a value that changed.

`--secrets-file` adds and replaces secrets, and it does not delete one. When a chain leaves the config, its `RPC_URL_<chainId>` secret stays on the Worker, unused. Delete it with `npx wrangler@4.151.3 secret delete RPC_URL_<chainId>`.

### Rotate the relayer key

Each Sender stores the address of the relayer key with `next_nonce`. When a submit finds another address, the Sender drops `next_nonce`, so the next nonce is the pending count of the new account on the chain. Each row records the relayer that signed it. The timer follows a pending row of the old key to its receipt and sends its stored bytes again, but it cannot replace its fee, because it cannot sign for the old key. Thus:

1. Wait until no relay is `pending`, so no row of the old key waits for a fee replacement.
2. Set `EVM_RELAY_RELAYER_PRIVATE_KEY` to the new key, fund the new address, update the executor in the wallet-config `relay` section, and run the workflow.
3. Move the remaining funds out of the old account.

A batch that a wallet signed for the old executor is refused after the change, because the batch names its executor. The wallet reads the account again and signs for the new executor.

### Read the `relayer_unfunded` log

`POST /v1/relay` answers `503 relayer_unfunded` when the relayer balance is below `gasLimit × maxFeePerGas` of the relay. Then the Worker writes one line to the Workers logs (Cloudflare dashboard, the Worker, Observability or Logs):

```
evm-relay: the relayer account cannot pay the gas on chain <chainId>.
```

The line names only the chain. Fund the relayer address on that chain. No deploy is necessary: the next relay reads the balance again.
