# EVM relay

This folder is the wallet side of the deposit-address relay (`services/evm-relay`). Each account has a second EVM
key, the relay key. Its address (`relayEvmAddress`) is a deposit address that delegates to Uniswap Calibur through
EIP-7702. The wallet signs a Calibur batch with the relay key, and the relay service submits it and pays the gas.
The batch module (`batch/`) has its own README. The relay knows no bridge.

## The core: the relay submitter (`submit.ts`)

A bridge flow gives the calls that it must send. The submitter puts them in ONE Calibur batch, has the backend sign
the batch, relays it and follows the job until it is final. Do not build the calls of a bridge here, and do not write
a transaction row here: the bridge flow does both.

```ts
createRelaySubmitter({ chain, address, sign }): RelaySubmitter
submitter.submit(calls: BatchCall[], options?: RelaySubmitOptions): Promise<RelayResult> // { id, hash }
submitter.resume(job: RelayJobRef): Promise<RelayResult>
```

- `chain` is the relay entry of the remote config (`getRelayChain`), `address` is the account's `relayEvmAddress`,
  and `sign` reaches the vault through the `signRelay` action, for example
  `request => signRelay(accountPublicKey, request)` from `useMidenContext()`. Tests also inject `fetchAccount`,
  `postRelay`, `fetchJob`, `now` (ms) and `sleep`.
- A bad argument (no call, a call to the zero address or to the relay address, a value that is not a uint256,
  calldata that is not whole bytes, a fee token or a job reference that is not valid) throws a `TypeError` before any
  read.
- The submitter runs one `submit` at a time: two batches of one address would read the same sequence.

### One attempt

1. Read `GET /v1/account` and check it (`assertRelayAccountMatches`).
2. Build the batch: the calls, and in `deduct` mode the fee call last (see the fee rule). Refuse more than 8 calls
   (the fee call counts) and a call outside `allowedTargets` (the fee call excepted).
3. Await `options.beforeSign()`.
4. Have the backend sign the EIP-7702 authorization when `needsAuthorization`, then the batch with
   `batchNonceOf(sequence)` and a deadline 30 minutes ahead. Check that the backend signed what the submitter asked
   for (the authorization of the pinned Calibur, chain and nonce, and the digest that the submitter computed).
5. Await `options.onJob(job)`. `job` is `{ chainId, id, deadline }`: `id` is the batch digest, which is the job id of
   the relay, and `deadline` is in unix seconds.
6. `POST /v1/relay`, and check that the job id is the digest.
7. Read `GET /v1/relay/{id}` every 5 seconds until the job is final, for at most 10 minutes. A passing read failure
   (`relayErrorAction` gives `wait`) does not end the wait.

### The hooks

- `beforeSign`: runs before EACH signature request, the first one and each one after a retry. It checks that the
  user's review (account, route, quote) still holds. A throw ends the submit, and nothing new is signed.
- `onJob`: runs after the batch is signed and BEFORE each POST, also before the POST of a retry (its id is new). The
  caller stores the job durably (for example on the transaction row). A throw ends the submit, and nothing is posted.
- `fee`: `deduct` mode only. The fee that the user reviewed (see the fee rule).

### Retries

Each retry reads the account again, runs the guards again, awaits `beforeSign`, signs a new batch, awaits `onJob`
and posts. A retry happens only after a POST that the relay refused (the job was not stored):

- `stale_request`: sign again.
- `simulation_failed`: sign again only when a fresh account read shows another `sequence` than the signed one
  (another batch of the address landed). Else, or when the read fails, the error goes to the caller.
- These two share one limit: at most 2 retries for one submit.
- `busy`: wait once for the open job that the error names to be final or gone, then start again. When that job is
  still pending after 10 minutes, the `busy` error goes to the caller.

Every other refusal goes to the caller as it is.

### The outcome of a POST

| POST failure | Class | What the submitter does |
| --- | --- | --- |
| `invalid_request`, `unsupported_chain`, `target_not_allowed`, `fee_too_low`, `bad_signature` (400) | refused | Passes on the error |
| `stale_request`, `simulation_failed`, `busy` (409) | refused | Retries as above, else passes on the error |
| `relayer_unfunded` (503) | refused | Passes on the error |
| `rate_limited` (429), `origin_not_allowed` (403), `not_found` (404), `method_not_allowed` (405), `payload_too_large` (413), `not_implemented` (501) | refused | Passes on the error |
| `RelayUnavailableError` `not_configured` | refused (no request was sent) | Passes on the error |
| `RelayUnavailableError` `network`, `timeout`, `bad_response` | unknown | Reads the job |
| `rpc_unavailable` (502), `service_unavailable` (503), `internal_error` (500) | unknown | Reads the job |
| `unknown_error` (a code that this build does not know, any status) | unknown | Reads the job |
| A 200 answer for another job id (`RelayMismatchError`), any other error | unknown | Reads the job |

`relaySubmitFailure(error)` (`errors.ts`) is this table. A refused class needs proof that the relay did not store the
job. The relay route (`services/evm-relay/src/routes/relay.ts`) answers each refused code before it hands the job to
the Sender, which stores it. `busy` comes from the Sender, but only when the Sender has no row with this id (it answers
a known id first) and so stores nothing. `relayer_unfunded` comes after the simulation and before the Sender. The
current route also answers `rpc_unavailable` and `service_unavailable` before the Sender, but the contract does not
promise that order for a 5xx, so the submitter treats them as unknown. That costs one read and, when the job is not
there, a wait for `resume`.

"Reads the job" means `GET /v1/relay/{id}?chainId=` with the id that the submitter computed. Found: the submitter
follows the job to its final state as usual. `not_found` or another failed read: the submitter rejects with
`RelayUnknownOutcomeError`, which carries the `RelayJobRef`. It never signs again after an unknown outcome.

### Final states

| Job | Result |
| --- | --- |
| `succeeded` | Resolves `{ id, hash }`; `hash` is the final (mined) hash |
| `reverted` | `RelayRevertedError` (`id`, `txHash`) |
| `expired` | `RelayExpiredError` (`id`, `txHash` = the relayer's cancel transaction). The batch never executes |
| `pending` after 10 minutes | `RelayStillPendingError` (`job`, `txHash`). Not a failure of the job: call `resume(job)` later |
| The relay no longer knows a job that it answered before | `RelayUnknownOutcomeError` (`job`) |

### `resume(job)`

`resume` follows a job that an earlier submit gave to `onJob`. It signs nothing. It reads the job by id:

- found: it follows the job to its final state, with the same results and errors as `submit`;
- `not_found`, and now is at most `deadline + 120 s` (`RELAY_RESUME_GRACE_SECONDS`): `RelayUnknownOutcomeError`. The
  outcome is still not known; try again later;
- `not_found`, and now is more than `deadline + 120 s`: `RelayNotSubmittedError`. The batch can no longer execute:
  the relay refuses a deadline less than 60 seconds ahead, and Calibur refuses a batch after its deadline;
- any other failed read: `RelayUnknownOutcomeError`.

A job reference for another chain, an id that is not a hash or a deadline that is not a safe integer of 0 or more
throws a `TypeError`.

### What a caller stores, and when a new review is safe

- Store the `RelayJobRef` of `onJob` before the POST (the hook runs then). A reload, a lost answer or a closed page
  then leaves a reference that `resume` can follow.
- After `RelayUnknownOutcomeError` or `RelayStillPendingError`, call `resume(job)` later. Do not start a new review
  for the same funds: the batch can still execute.
- A new review is safe after `RelayNotSubmittedError`, `RelayExpiredError`, `RelayRevertedError`, and after a refusal
  that the submitter passes on (the job was not stored). `relayErrorAction` gives `review-again` for the first three
  and for `stale_request` and `simulation_failed`.
- Known limit: the relay deletes a final job 24 hours after it became final. A `resume` more than 24 hours after the
  job became final can thus read `not_found` and report `RelayNotSubmittedError` for a job that executed. Resume a
  stored reference within 24 hours of its deadline.

### The fee rule

The service is not trusted for anything that decides where funds go or what they cost.

- The remote config names the fee recipient of a chain (`relay.chains.<key>.feeRecipient`). A chain without it does
  not take `deduct` mode. In `deduct` mode `assertRelayAccountMatches` requires the account's `feeRecipient` to be the
  configured one.
- The review shows the fee from `reviewRelayFee(account, chain, token)`: `{ mode: 'sponsor' }`, or
  `{ mode: 'deduct', fee: { token, amount } }` with the relayer's current fee of the token. It refuses
  (`RelayRefusedError`) a token for which the relayer names no fee (`no-fee`), and a fee of 0, a token without a config
  `maxFee` entry or a fee above that entry (`fee-not-accepted`).
- `submit` in `deduct` mode requires `options.fee` (`no-reviewed-fee`). The signed fee call is exactly
  `buildFeeCall({ token: fee.token, recipient: <configured feeRecipient>, amount: fee.amount })`, as the LAST call.
  Before any signature it refuses a token for which the relayer names no fee (`no-fee`), a relayer fee that is now
  above the reviewed amount (`fee-changed`: a new review is necessary), and a reviewed amount of 0 or above the config
  `maxFee` of the token, or a token without that entry (`fee-not-accepted`). A relayer fee below the reviewed amount
  is accepted: the batch pays the reviewed amount.
- `submit` in `sponsor` mode refuses a supplied `fee` (`unexpected-fee`): the review and the service disagree.

## Removed until a route needs them

The EIP-1193 adapter (`request`, the read forwarding to the chain RPC) and the Epoch wallet-client wrapper were
removed from this folder until a route uses them. A later RPC adapter must share its read forwarding with
`buildNativeReownProvider` (`lib/walletconnect/native.ts`), not copy it.

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
  job.
- `fetchRelayJob({ id, chainId? })`: `GET /v1/relay/{id}`.
- `relaySubmissionBody(request)`: the pure JSON body of `POST /v1/relay`. The calls are sent exactly as signed, call
  values and the batch nonce are decimal strings, and `deadline` is a number.

A bad argument (a chain id, an address, a token, a job id or a deadline that is not valid) throws a `TypeError`
before any request.

## Parse (`parse.ts`, types in `types.ts`)

`parseRelayAccount`, `parseRelayJob` and `parseRelayError` read the body as `unknown`. Amounts and the sequence
become `bigint`, and addresses and hashes become lower case. A job `state` is `pending`, `succeeded`, `reverted` or
`expired`. A body that does not match throws `RelayUnavailableError` (`bad_response`); there is no partial result.
Unknown fields are ignored. Two fees of one token are refused.

## Errors (`errors.ts`)

- `RelayApiError`: an error body. `code` (the contract's codes, `service_unavailable`, `internal_error`, or
  `unknown_error` for a code this build does not know), `status`, `message`, `retryAfter` (seconds, from the body,
  else from a delta-seconds `Retry-After` header, at most one hour) and `id` (the open relay, on `busy`).
- `RelayUnavailableError`: `reason` is `not_configured`, `network`, `timeout` or `bad_response`.
- `RelayMismatchError`: a guard refused the answer, or the backend signed something that the submitter did not ask
  for.
- `RelayRefusedError`: the submitter refused to sign. `reason` is `no-reviewed-fee`, `unexpected-fee`, `no-fee`,
  `fee-changed`, `fee-not-accepted`, `target-not-allowed` or `too-many-calls`.
- `RelayRevertedError`, `RelayExpiredError` (`id`, `txHash`): a final job that did not succeed.
- `RelayStillPendingError` (`job`, `id`, `txHash`), `RelayUnknownOutcomeError` (`job`, `id`, `cause`): follow the job
  with `resume(job)`.
- `RelayNotSubmittedError` (`job`, `id`): the job was never stored and can no longer execute.
- `relaySubmitFailure(error): 'refused' | 'unknown'`: the table above.
- `relayErrorAction(error): 'review-again' | 'wait' | 'stop'`:
  - `wait`: try again later. `RelayUnknownOutcomeError` and `RelayStillPendingError` (call `resume(job)`), every
    `RelayUnavailableError`, and `rate_limited`, `busy`, `relayer_unfunded`, `rpc_unavailable`,
    `service_unavailable`, `internal_error`, `unknown_error` with status 429 or 5xx (submit again later; `beforeSign`
    checks the review again).
  - `review-again`: this attempt is over and no batch of it can execute, so a new review can start.
    `RelayNotSubmittedError`, `RelayExpiredError`, `RelayRevertedError`, `stale_request`, `simulation_failed`.
  - `stop`: every other error.

## Guards (`guards.ts`)

- `assertRelayAccountMatches(account, chain, address)`: the account echoes the asked chain and address, its executor
  is the configured `chain.executor`, a `sponsor` account has no fee recipient and no fees, and a `deduct` account
  names the configured `chain.feeRecipient` (`deductFeeRecipient`). Else it throws `RelayMismatchError`.
- `reviewRelayFee(account, chain, token)`: see the fee rule. `relayerFeeOf`, `assertFeeWithinCap` and `relayFeeToken`
  are its parts, which `submit` also uses.
- `assertRelayJobMatches(job, expectedId)`: the job id is the EIP-712 digest that the wallet computed. Else it
  throws `RelayMismatchError`.

## The vault rule (`lib/miden/relay-key/sign-rules.ts`)

The relay key signs only what the backend builds from a structured `RelaySignRequest`: an EIP-7702 authorization to
the pinned Calibur of the remote config (the request sets only the chain and the nonce), or a batch of 1 to 8 calls
(`to` not the zero address and not the relay address itself, a uint256 `value`, `data` of at most 32 KiB) with the
configured executor, a batch nonce under `RELAY_NONCE_KEY`, the Calibur domain salt and a deadline at most 24 hours
ahead. It never signs a raw digest, a message or a transaction. The vault cannot tell a fee call from another call,
so the fee rule is the submitter's check.
