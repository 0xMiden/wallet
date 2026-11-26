# EVM relay

This folder is the wallet side of the deposit-address relay (`services/evm-relay`). Each account has a second EVM
key, the relay key. Its address (`relayEvmAddress`) is a deposit address that delegates to Uniswap Calibur through
EIP-7702. The wallet signs a Calibur batch with the relay key, and the relay service submits it and pays the gas.
The batch module (`batch/`) has its own README. The relay knows no bridge.

## The one integration point: the relay provider (`provider.ts`)

A bridge flow sends its own transaction through an EIP-1193 provider, for example the WalletConnect provider that a
deposit flow of `lib/bridge/providers` takes, or the viem `WalletClient` that the Epoch SDK takes. The relay provider plugs in at
that seam, in the place of the WalletConnect provider. Do not build the calls of a bridge here, and do not write a
transaction row here: the bridge flow does both, as it does with any other wallet.

- `createRelayProvider({ chain, address, rpcUrl, feeToken?, sign })` gives `{ chainId, address, request, sendCalls }`.
  `chain` is the relay entry of the remote config (`getRelayChain`), `address` is the account's `relayEvmAddress`,
  and `sign` reaches the vault through the `signRelay` action, for example
  `request => signRelay(accountPublicKey, request)` from `useMidenContext()`. Tests also inject the service calls,
  the RPC read, the clock and the wait.
- `request` fits viem's `Pick<EIP1193Provider, 'request'>`:
  - `eth_accounts`, `eth_requestAccounts`: the relay address. `eth_chainId`: the hex chain id.
    `wallet_switchEthereumChain`: `null` for its own chain.
  - `eth_sendTransaction`: one transaction becomes a batch of one call. `from` must be the relay address (else 4100),
    `to` is required, `data` or `input` and `value` are read, a `chainId` must be the provider's chain, and the gas
    fields are ignored (the relayer sets the gas). Bad parameters give -32602. It resolves with the final hash.
  - The read methods of `RELAY_READ_METHODS` (`rpc.ts`) go to `rpcUrl`, as in the native Reown shim. An RPC error
    keeps its code and data.
  - Every other method (`personal_sign`, `eth_signTypedData_v4`, `wallet_sendCalls`, a switch to another chain, ...)
    rejects with an EIP-1193 error of code 4200.
- `sendCalls(calls)` relays several calls in one batch. A flow uses it to put `approve` and the bridge call in one
  batch, which pays one fee in `deduct` mode.
- `createRelayWalletClient(provider, chain)` gives a viem `WalletClient` over the provider. Its account is the relay
  address as a JSON-RPC account, so `sendTransaction` and `writeContract` send `eth_chainId` and then one
  `eth_sendTransaction`.

One relay, in order: read `GET /v1/account` and check it (`assertRelayAccountMatches`); in `deduct` mode add the fee
call last (`buildFeeCall`, in `feeToken`, at most the config `maxFee`, else `RelayRefusedError`); refuse more than 8
calls and a target outside `allowedTargets`; have the backend sign the EIP-7702 authorization when
`needsAuthorization`; sign the batch with `batchNonceOf(sequence)` and a deadline 30 minutes ahead; check that the
backend signed the digest that the provider computed; `POST /v1/relay`; check that the job id is that digest; read
`GET /v1/relay/{id}` every 5 seconds. `succeeded` gives the final hash, `reverted` rejects with `RelayRevertedError`,
and no final state after 10 minutes rejects with `RelayStillPendingError` (the job can still land before its
deadline). The provider runs one relay at a time.

Retries are bounded: after `stale_request` it reads and signs again, at most 2 times; after `busy` it waits for the
open job (the `id` of the error) to become final or gone, then starts again once. A passing read failure during the
wait (`relayErrorAction` gives `wait`) does not end the wait. Every other error goes to the caller as it is. viem
wraps a provider error in its own RPC error types; the relay error is the `cause`.

## Account poll (`use-relay-account.ts`)

`useRelayAccount({ chainId, address, tokens })` reads `GET /v1/account` every 10 seconds while the page is on screen
and the relay serves the chain, and gives `{ account, error, isLoading, refresh }`. Off screen its SWR key is null.
An answer must pass `assertRelayAccountMatches`. A page uses it to see when funds arrive at the deposit address. The
minimum amount of a deposit is the rule of the bridge flow, not of the relay.

## Base URL (`base-url.ts`)

- `getRelayBaseUrl(): string | null`: the `MIDEN_EVM_RELAY_URL` build define when it is a loopback
  `http://localhost` or `http://127.0.0.1` URL (a local Worker), else the document's `relay.baseUrl`, else null
  (relay off). Every `vite.*.config.ts` defines `MIDEN_EVM_RELAY_URL`, empty by default.

## Client (`client.ts`)

Each call awaits `initBridgeConfig()` (it does not wait for the network), reads the base URL, has a 10 s timeout
(`RELAY_TIMEOUT_MS`) and reads at most 64 KiB (`MAX_RELAY_RESPONSE_BYTES`). The last argument is optional
`{ fetch }` for tests.

- `fetchRelayAccount({ chainId, address, tokens? })`: `GET /v1/account`. `tokens` (1 to 16 distinct addresses, the
  zero address is the native coin) asks for balances; the answer must give one balance for each distinct token, in
  the order of the query.
- `submitRelay(request: RelaySubmission)`: `POST /v1/relay`. The service answers the same request with the same
  job, so the caller can send it again after a timeout.
- `fetchRelayJob({ id, chainId? })`: `GET /v1/relay/{id}`.
- `relaySubmissionBody(request)`: the pure JSON body of `POST /v1/relay`. The calls are sent exactly as signed, call
  values and the batch nonce are decimal strings, and `deadline` is a number.

A bad argument (a chain id, an address, a token, a job id or a deadline that is not valid) throws a `TypeError`
before any request.

## Parse (`parse.ts`, types in `types.ts`)

`parseRelayAccount`, `parseRelayJob` and `parseRelayError` read the body as `unknown`. Amounts and the sequence
become `bigint`, and addresses and hashes become lower case. A body that does not match throws
`RelayUnavailableError` (`bad_response`); there is no partial result. Unknown fields are ignored. Two fees of one
token are refused.

## Errors (`errors.ts`)

- `RelayApiError`: an error body. `code` (the contract's codes, `service_unavailable`, `internal_error`, or
  `unknown_error` for a code this build does not know), `status`, `message`, `retryAfter` (seconds, from the body,
  else from a delta-seconds `Retry-After` header, at most one hour) and `id` (the open relay, on `busy`).
- `RelayUnavailableError`: `reason` is `not_configured`, `network`, `timeout` or `bad_response`.
- `RelayMismatchError`: a guard refused the answer, or the backend signed something that the provider did not ask
  for.
- `RelayRefusedError`: the provider refused to sign. `reason` is `no-fee-token`, `no-fee`, `fee-not-accepted`,
  `target-not-allowed` or `too-many-calls`.
- `RelayRevertedError`, `RelayStillPendingError`: the outcome of a submitted job, with its `id` and `txHash`.
- `RelayProviderRpcError`: an EIP-1193 error with a numeric `code` (and `data` for an RPC read).
- `relayErrorAction(error): 'sign-again' | 'wait' | 'stop'`:
  - `sign-again`: `stale_request`, `simulation_failed`.
  - `wait`: `rate_limited`, `busy`, `relayer_unfunded`, `rpc_unavailable`, `service_unavailable`,
    `internal_error`, `unknown_error` with status 429 or 5xx, every `RelayUnavailableError` and
    `RelayStillPendingError`.
  - `stop`: every other error.

## Guards (`guards.ts`)

The service is not trusted for anything that decides where funds go or what they cost.

- `assertRelayAccountMatches(account, chain, address)`: the account echoes the asked chain and address, its executor
  is the configured `chain.executor`, a `sponsor` account has no fee recipient and no fees, and a `deduct` account
  has a fee recipient that is not the zero address. Else it throws `RelayMismatchError`.
- `acceptedFee(account, chain, token): bigint | null`: 0 in `sponsor` mode. In `deduct` mode the relayer's fee of the
  token, or null when the relayer names no fee for it, the config has no `maxFee` entry for it, the fee is 0, or the
  fee is above that entry.
- `assertRelayJobMatches(job, expectedId)`: the job id is the EIP-712 digest that the wallet computed. Else it
  throws `RelayMismatchError`.

## The vault rule (`lib/miden/relay-key/sign-rules.ts`)

The relay key signs only what the backend builds from a structured `RelaySignRequest`: an EIP-7702 authorization to
the pinned Calibur of the remote config (the request sets only the chain and the nonce), or a batch of 1 to 8 calls
(`to` not the zero address and not the relay address itself, a uint256 `value`, `data` of at most 32 KiB) with the
configured executor, a batch nonce under `RELAY_NONCE_KEY`, the Calibur domain salt and a deadline at most 24 hours
ahead. It never signs a raw digest, a message or a transaction. The vault cannot tell a fee call from another call,
so the fee cap is the provider's check (`acceptedFee`).
