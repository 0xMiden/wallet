# EVM relay client

This folder is the wallet side of the deposit-address relay (`services/evm-relay`). The API contract is in the
Worker's README. The batch that the wallet signs is in `batch/`, which has its own README.

## Base URL (`base-url.ts`)

- `getRelayBaseUrl(): string | null`: the `MIDEN_EVM_RELAY_URL` build define when it is a loopback
  `http://localhost` or `http://127.0.0.1` URL (a local Worker), else the document's `relay.baseUrl`, else null
  (relay off). Every `vite.*.config.ts` defines `MIDEN_EVM_RELAY_URL`, empty by default.

## Client (`client.ts`)

Each call awaits `initBridgeConfig()` (it does not wait for the network), reads the base URL, has a 10 s timeout
(`RELAY_TIMEOUT_MS`) and reads at most 64 KiB (`MAX_RELAY_RESPONSE_BYTES`). The last argument is optional
`{ fetch }` for tests.

- `fetchRelayAccount(chainId, address): Promise<RelayAccount>`: `GET /v1/account`.
- `submitRelay(request: RelaySubmission): Promise<RelayJob>`: `POST /v1/relay`. The service answers the same
  request with the same job, so the caller can send it again after a timeout.
- `fetchRelayJob(id): Promise<RelayJob>`: `GET /v1/relay/{id}`.
- `relaySubmissionBody(request): RelaySubmissionBody`: the pure JSON body of `POST /v1/relay`. Amounts and the batch
  nonce are decimal strings, `deadline` is a number, and `params.fee` is the fee amount (`"0"` when sponsored).

A bad argument (a chain id, an address, a job id or a deadline that is not valid) throws a `TypeError` before any
request.

## Parse (`parse.ts`, types in `types.ts`)

`parseRelayAccount`, `parseRelayJob` and `parseRelayError` read the body as `unknown`. Amounts become `bigint`, and
addresses and hashes become lower case. A body that does not match throws `RelayUnavailableError` (`bad_response`);
there is no partial result. Unknown fields and unknown kinds are ignored. Two balances of one token are refused.

## Errors (`errors.ts`)

- `RelayApiError`: an error body. `code` (the contract's codes, `service_unavailable`, `internal_error`, or
  `unknown_error` for a code this build does not know), `status`, `message`, `retryAfter` (seconds, from the body,
  else from a delta-seconds `Retry-After` header, at most one hour) and `id` (the open relay, on `busy`).
- `RelayUnavailableError`: `reason` is `not_configured`, `network`, `timeout` or `bad_response`.
- `RelayMismatchError`: a guard below refused the answer.
- `relayErrorAction(error): 'sign-again' | 'wait' | 'stop'`:
  - `sign-again`: `stale_request`, `simulation_failed`. Read the account and sign again.
  - `wait`: `rate_limited`, `busy`, `relayer_unfunded`, `rpc_unavailable`, `service_unavailable`,
    `internal_error`, `unknown_error` with status 429 or 5xx, and every `RelayUnavailableError`.
  - `stop`: every other error, a `RelayMismatchError` included.

## Guards (`guards.ts`)

The service is not trusted for anything that decides where funds go or what they cost.

- `assertRelayAccountMatches(account, chain, address)`: the account echoes the asked chain and address, its executor
  is the configured `chain.executor`, a `sponsor` account has no fee recipient and no fee, and a `deduct` account
  has a fee recipient that is not the zero address. Else it throws `RelayMismatchError`.
- `acceptedFee(account, chain, token): bigint | null`: the fee of the token, or null when the token is not in the
  balances, a `sponsor` account asks for a fee, or in `deduct` mode the config has no `maxFee` entry for the token,
  the fee is 0 or the fee is above that entry.
- `relayableAmount(balance, fee): bigint | null`: `balance - fee`, or null when the balance is below `minAmount`,
  the fee is negative, or the result is not positive.
- `assertRelayJobMatches(job, expectedId)`: the job id is the EIP-712 digest that the wallet computed. Else it
  throws `RelayMismatchError`.
