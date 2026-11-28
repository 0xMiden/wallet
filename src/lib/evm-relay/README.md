# EVM relay

This folder is the wallet side of the deposit-address relay (`services/evm-relay`). Each account has a second EVM
key, the relay key. Its address (`relayEvmAddress`) is a deposit address that delegates to Uniswap Calibur through
EIP-7702. The wallet signs a Calibur batch with the relay key, and the relay service submits it and pays the gas. In
`deduct` mode the batch pays the relayer back with a fee call (see the fee rule). The batch module (`batch/`) has its
own README. The relay knows no bridge.

The folder has two layers. The submitter (`submit.ts`) is the core: it applies every relay rule. The EIP-1193
provider (`provider.ts`) is a thin adapter over it, for a flow that sends its own transactions.

## The core: the relay submitter (`submit.ts`)

A bridge flow gives the calls that it must send. The submitter puts them in ONE Calibur batch, has the backend sign
the batch, relays it and follows the job until it is final. Do not build the calls of a bridge here, and do not write
a transaction row here: the bridge flow does both.

```ts
createRelaySubmitter({ chain, address, sign }): RelaySubmitter
submitter.submit(calls: BatchCall[], options?: RelaySubmitOptions): Promise<RelayResult> // { id, hash }
submitter.resume(job: RelayJobRef): Promise<RelayResult>
```

- `chain` is the relay values of the remote config for one chain (`getRelayChain`), `address` is the account's
  `relayEvmAddress`,
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
- `fee`: `deduct` mode only. The fee that the user reviewed, from a checked quote (see the fee rule). Each attempt and
  each retry signs exactly this fee.

### Retries

Each retry reads the account again, runs the guards again, awaits `beforeSign`, signs a new batch, awaits `onJob`
and posts. A retry signs the same reviewed fee as the first attempt, and never asks for a quote. A retry happens only
after a POST that the relay refused (the job was not stored):

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
| `invalid_request`, `unsupported_chain`, `target_not_allowed`, `fee_too_low`, `invalid_fee_quote`, `fee_token_not_accepted`, `fee_not_needed`, `bad_signature` (400) | refused | Passes on the error |
| `stale_request`, `simulation_failed`, `busy` (409) | refused | Retries as above, else passes on the error |
| `relayer_unfunded` (503) | refused | Passes on the error |
| `rate_limited` (429), `origin_not_allowed` (403), `not_found` (404), `method_not_allowed` (405), `payload_too_large` (413), `not_implemented` (501) | refused | Passes on the error |
| `RelayUnavailableError` `not_configured` | refused (no request was sent) | Passes on the error |
| `RelayUnavailableError` `network`, `timeout`, `bad_response` | unknown | Reads the job |
| `price_unavailable` (503), `rpc_unavailable` (502), `service_unavailable` (503), `internal_error` (500) | unknown | Reads the job |
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
  and for `stale_request`, `simulation_failed`, `fee_too_low`, `invalid_fee_quote` and `fee_not_needed`.
- Known limit: the relay deletes a final job 24 hours after it became final. A `resume` more than 24 hours after the
  job became final can thus read `not_found` and report `RelayNotSubmittedError` for a job that executed. Resume a
  stored reference within 24 hours of its deadline.

### The fee rule (`deduct` mode)

The service is not trusted for anything that decides where funds go or what they cost. In `deduct` mode the relay
uses the batch simulation, the expected gas price and a 15% buffer to quote the fee in the fee token. There is no fixed fee table. In `sponsor` mode there is no fee, no quote and no fee call.

- The wallet pays a fee to one recipient only, for every chain: the `relay.feeRecipient` of the remote config, else
  its `relay.executor` (`configuredFeeRecipient`). The executor is the relayer, which pays the gas. In `deduct` mode
  `assertRelayAccountMatches` requires the account's `feeRecipient` to be that address.
- The config `relay.maxFee` is the highest fee that the wallet accepts for one batch, as a USD value: `maxFee.l1` for
  Ethereum and Sepolia (`RELAY_L1_CHAIN_IDS`), `maxFee.l2` for every other chain. The defaults are 0.50 USD and
  0.05 USD. The limit is a USD value, so it applies to every fee token, and the config names no token.
- The wallet values the fee itself (`relayFeeMicroUsd`): the amount, the decimals that the caller gives for the token,
  and the wallet's own price of the token (`relayFeeTokenPriceMicroUsd` in `fee-price.ts`: the token is found by its
  chain and contract in the wallet config, and priced by the wallet's feed, Binance then Kraken). The value is
  rounded up. No price from the relay service is used. A token that the wallet cannot price cannot pay a fee
  (`fee-price-unavailable`).
- `GET /v1/account` gives `feeTokens`: the tokens that the relay takes a fee in (the native coin first), empty in
  `sponsor` mode. It gives no fee amount.

How a caller reviews a fee:

1. Quote: `quoteRelayFee(source or address, chainId, calls, { address, decimals })` (`quote.ts`) reads the wallet's
   price of the fee token first; without a fresh price it throws `fee-price-unavailable` and does not ask the relay.
   Then it sends `POST /v1/quote` with the calls of the batch WITHOUT the fee call, and checks the answer
   (`assertRelayQuoteMatches`): the chain, the configured fee recipient, the asked token, a fee above 0 whose USD
   value is at most the fee limit of the chain (`fee-not-accepted`), and a `validUntil` after now (`quote-expired`).
   The checked quote carries `tokenValue`: the decimals and the price that the check used. A refusal of the relay goes to the caller as it
   is: `fee_not_needed` (the relay is in `sponsor` mode), `fee_token_not_accepted`, `simulation_failed` (the calls
   revert), `price_unavailable`.
2. Show: the review shows `quote.fee` of `quote.token`. The caller can apply its own review limit here. A caller whose
   typed amount pays the fee too uses `amountAfterRelayFee(amount, quote.fee)`: the part of the amount that is left for
   the bridge calls, or null when none of the deposit remains. The final batch must fit the signed quote's gas allowance.
3. Submit: `submit(calls, { fee: relayQuoteFee(quote) })`. The signed fee call is exactly
   `buildFeeCall({ token: fee.token, recipient: <configured feeRecipient>, amount: fee.amount })`, as the LAST call.
   Before any signature the submitter requires `options.fee` (`no-reviewed-fee`), and refuses a token that is not in
   the account's `feeTokens` (`no-fee`) and an amount of 0 or with a USD value above the fee limit of the chain
   (`fee-not-accepted`). It values the amount with the `tokenValue` of the reviewed fee, and reads no price itself. It
   never asks for a quote and never signs a higher fee by itself.

The submitter sends the relayer's quote signature and checks that the quote is valid for the current relay sequence before it signs. The relay checks the quoted fee terms and the signed batch's gas estimate. The relayer pays any extra gas cost due to a price increase. An expired or mismatched quote, or a batch that exceeds its gas allowance, gives `invalid_fee_quote` with the action `review-again`.

`submit` in `sponsor` mode refuses a supplied `fee` (`unexpected-fee`): the review and the service disagree.

#### Several relays for one user action

A flow that sends several transactions for one user action through the provider (the Epoch SDK sends `approve`, then
`deposit`) makes one relay for each, and in `deduct` mode each relay pays its own fee. The provider option `feeFor`
gives that fee: the provider calls `feeFor(calls)` with the calls of each send before the submit, and passes the
result as `fee`. The caller implements it with `quoteRelayFee` and its own review limit, for example:

```ts
const feeFor: RelaySendFee = async calls => {
  const quote = await quoteRelayFee(source, chainId, calls, { address: feeToken, decimals });
  if (quote.fee > reviewedLimit) throw new Error('the fee is above the review'); // nothing is signed
  return relayQuoteFee(quote);
};
buildRelayWalletClient(source, chainId, { beforeSign, onJob, feeFor });
```

The quote of the second send runs after the first send is final, so the relay simulates it on the state after the
first one (for example with the allowance of the `approve`). A throw of `feeFor` ends that send before any read or
signature. `fee` and `feeFor` together are a `TypeError`. A flow that can put all calls in one batch
(`sendCalls([approve, bridgeCall])`) pays one fee and needs no `feeFor`.

## The integration point of a flow that sends its own transactions: the relay provider (`provider.ts`)

A bridge flow that sends its own transactions through an EIP-1193 provider (the Agglayer helpers of
`lib/bridge/providers`) or a viem `WalletClient` (the Epoch SDK) gets the relay provider in the place of the
WalletConnect provider. The provider is a thin adapter over the submitter: it adds no relay rule of its own.

- `createRelayProvider({ chain, address, rpcUrl, sign, beforeSign?, onJob?, fee?, feeFor? })` gives
  `{ chainId, address, request, sendCalls, submitter }`. It builds one submitter from the same options (tests also
  inject the submitter's dependencies and `readRpc`). `beforeSign`, `onJob` and `fee` go to EACH `submit`, so a flow
  that uses the provider also gets the review check and the durable job reference. With `feeFor`, each send gets its
  own reviewed fee (see "Several relays for one user action"). `submitter.resume(job)` follows a job that `onJob`
  recorded.
- `request` fits viem's `Pick<EIP1193Provider, 'request'>` with no cast (an overload gives the caller's result type):
  - `eth_accounts`, `eth_requestAccounts`: the relay address. `eth_chainId`: the hex chain id.
    `wallet_switchEthereumChain`: `null` for its own chain.
  - `eth_sendTransaction`: `from` must be the relay address (else 4100), `to` is required, `data` or `input` and
    `value` are read, a `chainId` must be the provider's chain, and the gas fields are ignored (the relayer sets the
    gas). Bad parameters give -32602. It calls `submitter.submit([{ to, value, data }])` and resolves with the mined
    hash.
  - The read methods of `RELAY_READ_METHODS` (`rpc.ts`) go to `rpcUrl`, as in the native Reown shim. An RPC error
    keeps its code and data. A later change should share this read forwarding with `buildNativeReownProvider`
    (`lib/walletconnect/native.ts`).
  - Every other method (`personal_sign`, `eth_signTypedData_v4`, `wallet_sendCalls`, a switch to another chain, ...)
    rejects with an EIP-1193 error of code 4200.
- `sendCalls(calls)` relays several calls in one batch and gives the mined hash. A `TypeError` of the submitter or of
  `feeFor` (a call that it cannot take) becomes -32602.
- Every relay error goes to the caller as it is. viem wraps a provider error in its own RPC error types; the typed
  relay error (`RelayUnknownOutcomeError` with its `job`, `RelayRefusedError`, ...) is in the `cause` chain.
- `createRelayWalletClient(provider, chain)` gives a viem `WalletClient` over the provider. Its account is the relay
  address as a JSON-RPC account, so `sendTransaction` and `writeContract` send `eth_chainId` and then one
  `eth_sendTransaction`, which is one `POST /v1/relay`.

A flow that wants one batch of several calls (for example `approve` and the bridge call, which pays one fee in
`deduct` mode) calls `sendCalls` or the submitter directly.

## Account poll (`use-relay-account.ts`)

`useRelayAccount({ chainId, address, tokens })` reads `GET /v1/account` every 10 seconds while the page is on screen
and the relay is on for the chain (`selectRelayChain`: the switch is on and the document lists the chain in
`supportedEvmChains`), and gives `{ account, error, isLoading, refresh }`. Off screen its SWR key is null. A chain
that the service does not serve fails with `unsupported_chain`.
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
- `fetchRelayQuote({ chainId, evmAddress, calls, feeToken, authorization? })`: `POST /v1/quote`, the
  `RelayQuote` `{ chainId, token, recipient, fee, gas, sequence, validUntil, signature }`. `calls` are 1 to 7 calls
  (`MAX_RELAY_QUOTE_CALLS`) without the fee call; a target that is the zero address or the relay address, a value that
  is not a uint256 and calldata that is not whole bytes are a `TypeError`. `authorization` is sent only when given.
  `relayQuoteBody(query)` is the pure JSON body. The caller checks the answer with `assertRelayQuoteMatches`
  (`quoteRelayFee` does).
- `submitRelay(request: RelaySubmission)`: `POST /v1/relay`. The service answers the same request with the same
  job.
- `fetchRelayJob({ id, chainId? })`: `GET /v1/relay/{id}`.
- `relaySubmissionBody(request)`: the pure JSON body of `POST /v1/relay`. The calls are sent exactly as signed, call
  values and the batch nonce are decimal strings, and `deadline` is a number. In deduct mode the body includes the signed quote.

A bad argument (a chain id, an address, a token, a job id or a deadline that is not valid) throws a `TypeError`
before any request.

## Parse (`parse.ts`, types in `types.ts`)

`parseRelayAccount`, `parseRelayQuote`, `parseRelayJob` and `parseRelayError` read the body as `unknown`. Amounts, the
sequence and the gas become `bigint`, and addresses and hashes become lower case. A job `state` is `pending`,
`succeeded`, `reverted` or `expired`. A body that does not match throws `RelayUnavailableError` (`bad_response`); there
is no partial result. Unknown fields are ignored (also the `fees` table of an older service). An account must have
`feeTokens`, and one token two times in it is refused.

## Errors (`errors.ts`)

- `RelayApiError`: an error body. `code` (the contract's codes, `service_unavailable`, `internal_error`, or
  `unknown_error` for a code this build does not know), `status`, `message`, `retryAfter` (seconds, from the body,
  else from a delta-seconds `Retry-After` header, at most one hour) and `id` (the open relay, on `busy`).
- `RelayFeeTooLowError` is a fee refusal with a new fee when the relay supplies `required` and `token`.
- `RelayUnavailableError`: `reason` is `not_configured`, `network`, `timeout` or `bad_response`.
- `RelayMismatchError`: a guard refused the answer, or the backend signed something that the submitter did not ask
  for.
- `RelayRefusedError`: the wallet refused a quote or refused to sign. `reason` is `no-reviewed-fee`,
  `unexpected-fee`, `no-fee`, `fee-not-accepted`, `fee-price-unavailable`, `quote-expired`, `target-not-allowed` or
  `too-many-calls`.
- `RelayRevertedError`, `RelayExpiredError` (`id`, `txHash`): a final job that did not succeed.
- `RelayStillPendingError` (`job`, `id`, `txHash`), `RelayUnknownOutcomeError` (`job`, `id`, `cause`): follow the job
  with `resume(job)`.
- `RelayNotSubmittedError` (`job`, `id`): the job was never stored and can no longer execute.
- `RelayProviderRpcError`: an EIP-1193 error of the provider, with a numeric `code` (and `data` for an RPC read).
- `relaySubmitFailure(error): 'refused' | 'unknown'`: the table above.
- `relayErrorAction(error): 'review-again' | 'wait' | 'stop'`:
  - `wait`: try again later. `RelayUnknownOutcomeError` and `RelayStillPendingError` (call `resume(job)`), every
    `RelayUnavailableError`, and `rate_limited`, `busy`, `relayer_unfunded`, `price_unavailable`,
    `rpc_unavailable`, `service_unavailable`, `internal_error`, `unknown_error` with status 429 or 5xx (submit again
    later; `beforeSign` checks the review again).
  - `review-again`: this attempt is over and no batch of it can execute, so a new review can start.
    `RelayNotSubmittedError`, `RelayExpiredError`, `RelayRevertedError`, `stale_request`, `simulation_failed`,
    `fee_too_low`, `invalid_fee_quote`, `fee_not_needed`, and the
    refusal `quote-expired`.
  - `stop`: every other error (`fee_token_not_accepted` included).

## Guards (`guards.ts`)

- `assertRelayAccountMatches(account, chain, address)`: the account echoes the asked chain and address, its executor
  is the configured `chain.executor`, a `sponsor` account has no fee recipient and no fee tokens, and a `deduct`
  account names the configured fee recipient, which is `chain.feeRecipient`, else `chain.executor`
  (`deductFeeRecipient`). Else it throws `RelayMismatchError`.
- `assertRelayQuoteMatches(quote, chain, feeToken, tokenValue, nowSeconds)`: see the fee rule. `assertFeeWithinCap`
  (the USD value of the fee against `chain.maxFeeMicroUsd`, the config `maxFee.l1` or `maxFee.l2`),
  `assertRelayTakesFeeToken` (the account's `feeTokens`) and `relayFeeToken` are the parts that `submit` also uses.
- `assertRelayJobMatches(job, expectedId)`: the job id is the EIP-712 digest that the wallet computed. Else it
  throws `RelayMismatchError`.

## The vault rule (`lib/miden/relay-key/sign-rules.ts`)

The relay key signs only what the backend builds from a structured `RelaySignRequest`: an EIP-7702 authorization to
the pinned Calibur of the remote config (the request sets only the chain and the nonce), or a batch of 1 to 8 calls
(`to` not the zero address and not the relay address itself, a uint256 `value`, `data` of at most 32 KiB) with the
configured executor, a batch nonce under `RELAY_NONCE_KEY`, the Calibur domain salt and a deadline at most 24 hours
ahead. It never signs a raw digest, a message or a transaction. The vault cannot tell a fee call from another call,
so the fee rule is the submitter's check.
