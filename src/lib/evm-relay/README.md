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
submitter.check(job: RelayJobRef): Promise<RelayJobCheck>
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
| `invalid_request`, `unsupported_chain`, `target_not_allowed`, `fee_too_low` (`RelayFeeTooLowError` with `required` and `token`), `fee_token_not_accepted`, `fee_not_needed`, `bad_signature` (400) | refused | Passes on the error |
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

### `check(job)`

`check` reads a job that an earlier submit gave to `onJob` ONCE, with no wait. It signs nothing: it is one
`GET /v1/relay/{id}?chainId=` with the guard `assertRelayJobMatches`. A caller that must not wait (a reconcile pass)
uses it; a caller that can wait uses `resume`.

```ts
type RelayJobCheck =
  | { state: 'succeeded'; hash: Hash } // the mined hash
  | { state: 'reverted'; hash: Hex } // the mined hash
  | { state: 'expired'; hash: Hex } // the relayer's cancel transaction; the batch never executes
  | { state: 'pending'; hash: Hex } // the last hash
  | { state: 'unknown'; cause: unknown }
  | { state: 'not-submitted' };
```

- found: its state and hash. An answer for another job id is a failed read;
- `not_found`, and now is at most `deadline + 120 s` (`RELAY_RESUME_GRACE_SECONDS`): `unknown`. The outcome is still
  not known; read again later;
- `not_found`, and now is more than `deadline + 120 s`: `not-submitted`. The batch can no longer execute: the relay
  refuses a deadline less than 60 seconds ahead, and Calibur refuses a batch after its deadline;
- any other failed read: `unknown`, with the error as `cause`.

A job reference for another chain, an id that is not a hash or a deadline that is not a safe integer of 0 or more
throws a `TypeError` before the read.

### `resume(job)`

`resume` follows a job that an earlier submit gave to `onJob`. It signs nothing. It is `check` and then the wait of
`submit`, so the two share one rule:

- found: it follows the job to its final state, with the same results and errors as `submit`;
- `unknown`: `RelayUnknownOutcomeError` (its `cause` is the cause of the check);
- `not-submitted`: `RelayNotSubmittedError`.

### Open jobs (`open-jobs.ts`)

A `submit` that rejects with `RelayUnknownOutcomeError` or `RelayStillPendingError` also reports the job to each open
watch of its chain and address. A flow whose relay error does not come back to it as a typed error (the Epoch SDK
gives a send error back as a new error with the text alone) starts a watch before it sends and reads it after:

```ts
watchOpenRelayJobs(chainId, address): OpenRelayJobWatch // { jobs(): RelayJobRef[]; stop(): void }
openRelayJobError(error): RelayUnknownOutcomeError | RelayStillPendingError | undefined // errors.ts
```

`openRelayJobError` walks the `cause` chain (at most 16 links), as viem keeps a provider error as a `cause`. A watch
sees only the reports of its own chain and address while it is open, in this realm.

### What a caller stores, and when a new review is safe

- Store the `RelayJobRef` of `onJob` before the POST (the hook runs then). A reload, a lost answer or a closed page
  then leaves a reference that `resume` can follow.
- After `RelayUnknownOutcomeError` or `RelayStillPendingError`, call `resume(job)` later. Do not start a new review
  for the same funds: the batch can still execute.
- A new review is safe after `RelayNotSubmittedError`, `RelayExpiredError`, `RelayRevertedError`, and after a refusal
  that the submitter passes on (the job was not stored). `relayErrorAction` gives `review-again` for the first three
  and for `stale_request`, `simulation_failed`, `fee_too_low` and `fee_not_needed`.
- Known limit: the relay deletes a final job 24 hours after it became final (`RELAY_FINAL_JOB_RETENTION_SECONDS`). A
  `resume` or `check` more than 24 hours after the job became final can thus read `not_found` and report
  `RelayNotSubmittedError` (`not-submitted`) for a job that executed. Resume a stored reference within 24 hours of its
  deadline. A caller that knows a time before the POST (the creation of its row) trusts `not-submitted` only until that
  time plus 24 hours.

### The fee rule (`deduct` mode)

The service is not trusted for anything that decides where funds go or what they cost. In `deduct` mode the relay
quotes the fee of each batch from its simulation of the calls: the simulated gas cost, priced in the fee token, with
a margin. There is no fixed fee table. In `sponsor` mode there is no fee, no quote and no fee call.

- The remote config names one fee recipient for every chain (`relay.feeRecipient`). Without it the wallet does not
  take `deduct` mode. In `deduct` mode `assertRelayAccountMatches` requires the account's `feeRecipient` to be the
  configured one. The config `relay.maxFee` is the highest fee that the wallet accepts for each token; a token without
  an entry is not accepted as a fee.
- `GET /v1/account` gives `feeTokens`: the tokens that the relay takes a fee in (the native coin first), empty in
  `sponsor` mode. It gives no fee amount.

How a caller reviews a fee:

1. Quote: `quoteRelayFee(source or address, chainId, calls, feeToken)` (`quote.ts`) sends `POST /v1/quote` with the
   calls of the batch WITHOUT the fee call, and checks the answer (`assertRelayQuoteMatches`): the chain, the
   configured fee recipient, the asked token, a fee above 0 and at most the config `maxFee` of the token
   (`fee-not-accepted`), and a `validUntil` after now (`quote-expired`). A refusal of the relay goes to the caller as it
   is: `fee_not_needed` (the relay is in `sponsor` mode), `fee_token_not_accepted`, `simulation_failed` (the calls
   revert), `price_unavailable`.
2. Show: the review shows `quote.fee` of `quote.token`. The caller can apply its own review limit here. A caller whose
   typed amount pays the fee too uses `amountAfterRelayFee(amount, quote.fee)`: the part of the amount that is left for
   the bridge calls, or null when the fee is not below the amount. The calls that the caller quoted with and the calls
   that it submits can differ in the amount only: the gas of the batch does not depend on it.
3. Submit: `submit(calls, { fee: relayQuoteFee(quote) })`. The signed fee call is exactly
   `buildFeeCall({ token: fee.token, recipient: <configured feeRecipient>, amount: fee.amount })`, as the LAST call.
   Before any signature the submitter requires `options.fee` (`no-reviewed-fee`), and refuses a token that is not in
   the account's `feeTokens` (`no-fee`) and an amount of 0 or above the config `maxFee` of the token, or a token without
   that entry (`fee-not-accepted`). It never asks for a quote and never signs a higher fee by itself.

The relay does not store or sign a quote. When it gets the signed batch, it simulates it again and accepts a fee of at
least its requirement for the real gas estimate, less a tolerance. Else it answers `400 fee_too_low`, which the client
reads as `RelayFeeTooLowError` with `required` (the fee that the relay would quote now) and `token`. The job was not
stored; `relayErrorAction` gives `review-again`. The caller shows the new fee in a new review (step 1 again) and
submits again only after the user accepts it. A `fee_too_low` body without a valid `required` and `token` stays a
`RelayApiError` with that code and the same action.

`submit` in `sponsor` mode refuses a supplied `fee` (`unexpected-fee`): the review and the service disagree.

#### Several relays for one user action

A flow that sends several transactions for one user action through the provider (the Epoch SDK sends `approve`, then
`deposit`) makes one relay for each, and in `deduct` mode each relay pays its own fee. The provider option `feeFor`
gives that fee: the provider calls `feeFor(calls)` with the calls of each send before the submit, and passes the
result as `fee`. The caller implements it with `quoteRelayFee` and its own review limit, for example:

```ts
const feeFor: RelaySendFee = async calls => {
  const quote = await quoteRelayFee(source, chainId, calls, feeToken);
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

## Using the relay as a bridge source

A bridge-in flow can use the account's relay address as its source wallet in the place of an external wallet. The
relay modules stay bridge-agnostic: the Epoch seam lives in `lib/epoch`, and the Agglayer calls stay with the deposit
screen.

### The relay source (`source.ts`)

```ts
interface RelaySource { accountPublicKey: string; address: Address }  // address in lower case
relaySourceOf(account): RelaySource | null          // null: no valid relayEvmAddress, or the relay is off
findRelaySource(address: string): RelaySource | null // an account of the store whose relay address it is (case ignored)
relayServesChain(chainId: number): boolean           // relay entry + base URL + a wallet chain definition with an RPC
buildRelayProvider(source, chainId, hooks?): RelayProvider
buildRelayWalletClient(source, chainId, hooks?): WalletClient
buildRelaySubmitter(source, chainId): RelaySubmitter  // for `check` and `resume` of a stored job
```

- The relay is off when `getRelayConfig()` or `getRelayBaseUrl()` is null. These read the realm's config snapshot as
  it is: a path that runs with no user action awaits `initBridgeConfig()` first.
- `sign` is the store's `signRelay(source.accountPublicKey, request)`, the same pattern as `buildVaultEvmWalletClient`
  (`lib/epoch/evm-account.ts`) for the other derived address. The chain and its RPC come from the wallet's chain
  definitions with the wallet's RPC (`evmRpcChain` in `lib/evm/rpc-chain.ts`, which `lib/epoch/client.ts` also uses).
- `hooks` (`beforeSign`, `onJob`, `fee`, `feeFor`) go to each send, as in `createRelayProvider`.
- A chain that the relay does not serve throws `RelayUnavailableError` (`not_configured`).

### Epoch (Fast bridge-in)

- `buildEpochWalletClient(address, opts)` (`lib/epoch/client.ts`) chooses the transport: the relay provider when
  `address` is a relay source, else the native Reown shim on mobile, else the wagmi wallet. A relay address never
  falls back to an external wallet.
- `getEvmSourceConnection(sourceAddress, chainId)` gives a relay connection (`isRelay: true`, on `chainId`) for a relay
  source that the relay serves, else the connected external wallet. `executeEVMToMiden`, `quoteEVMToMiden`, `poll`
  and `connectSponsorSdk` (locked-deposit recovery) read the source through it, so they skip every wallet chain
  switch for a relay source. Every identity check keeps its meaning: the source address must still be the reviewed
  `evmAddress` (`assertOwnedCurrent`) and the sponsor of the lock.
- `getEpochSdk({ account })` builds an SDK for a relay source with no wallet connection, cached under its own key
  (address, chain, allocator and the relay entry of the config). It is null when the relay does not serve the chain.

The EVM-collateral deposit of `solveIntent` (Epoch SDK 2.0.1) calls these on the wallet client:

| Call | How the relay answers |
| --- | --- |
| `walletClient.chain` (id, default RPC), `walletClient.account` (address, type `json-rpc`) | Fields of the client: the source chain with the wallet's RPC, and the relay address |
| `shouldUseGaslessRelay` (account type) | `json-rpc`, not `local`: the SDK does not take the gasless path, so it asks for no `signTypedData` (sponsor signature) and no `signAuthorization` |
| `getCapabilities` → `wallet_getCapabilities` (only for approve + deposit) | Refused with 4200, so the SDK picks `sequential-tx` and sends no `wallet_sendCalls` |
| `sendTransactionSync` for each deposit call (approve, then `depositERC20AndRegister`; one call for native) | `eth_chainId` (the source chain), `eth_sendTransaction` (one relay batch, resolves with the mined hash), then `eth_getTransactionReceipt` through the chain RPC |
| `switchChain` (only in the no-lock execution path) | `wallet_switchEthereumChain` to its own chain is `null`; another chain is refused with 4200 |
| Reads (`allowance`, `getCode`, forced-withdrawal status, lock balances, receipt wait with 3 confirmations) | The SDK's own HTTP public clients on `walletClient.chain.rpcUrls.default`, not the wallet client |

The SDK gives a send error back as a new `CompactSDKError` with the text alone, so the typed relay error does not
reach `executeEVMToMiden`. The store starts a watch of the open jobs of the relay source (`watchOpenRelayJobs`) before
the solve, and reads the cause chain too (`openRelayJobError`). A solve that failed with an open relay job and with no
deposit in the lock (the stranded rule of `buildEVMToMidenIntent`) does not fail an untagged row: the row stays
`submitting` and the store writes the job on it (`relayJob`). A tagged row takes its existing `uncertain` source
attempt. The store status is `failed` with the SDK text in both cases, as before. The reconciler then reads the job
(see below), and the locked-funds scan of Settings finds a deposit in a lock of The Compact.

Recovery (`initateDepositWithdrawal`, `disableForcedWithdrawal`, `withdrawToken`, the `register` of a retry) uses
`writeContract`, which is `eth_chainId` and one `eth_sendTransaction`. No call of these paths needs a signature that
the relay key cannot give. The relay does not answer EIP-5792 on purpose: after a failed `wallet_sendCalls` the SDK
sends the same calls again one by one, which can run a deposit twice when the batch outcome is not known.

The Compact, the deposit token and the Compact's `register` are targets of the batch: a chain whose `allowedTargets`
is not null must name them.

### The reconciler and a stored job (`lib/miden/activity/bridge-receive.ts`)

A `bridged-receive` row in `submitting` with a `relayJob` and no `evmTxHash` (Agglayer: the deposit screen wrote the
job in `onJob`; Epoch: the store wrote it, see above) is not failed as interrupted. Each reconcile pass reads the job
ONCE with `check` (never `resume`: a pass does not wait), through `buildRelaySubmitter`, and only when:

- no deposit flow holds the submission lock (the screen follows its own job while it is open);
- the row is not restored from a backup (the reconciler fails such a row before any read) and is inside its delivery
  window;
- the row's `sourceAddress` is the relay address of an account of this wallet (`findRelaySource`, after the pass's
  `initBridgeConfig()`), and the job is for the row's source chain.

Nothing is signed. A write lands only while the row still holds the same job and no hash (`canUpdate`).

| Job (`check`) | Agglayer row | Epoch row |
| --- | --- | --- |
| `succeeded` | `evmTxHash` = the mined hash, phase stays `submitting` (the screen's own write after a mined deposit); the next pass follows the hash path (receipt, then the indexer) | `failed`, "interrupted before an intent was recorded": the SDK never asked for an allocation; a deposit that executed is in a lock of The Compact, which the Settings scan finds |
| `reverted` | `failed`, `depositFlowRelayReverted` | same as Agglayer |
| `expired` | `failed`, `depositFlowRelayExpired` | same as Agglayer |
| `not-submitted`, row younger than 24 hours | `failed`, `depositFlowRelayExpired` (the screen's text for `RelayNotSubmittedError`) | same as Agglayer |
| `not-submitted`, row 24 hours old or more | no change: the job can have executed and been deleted | no change |
| `pending`, `unknown` | no change | no change |

A failure has the screen's `errorId` (`raw_bridge_deposit_failed`) and failure source (`wallet_deposit`, request
client `relay`, the typed relay error as `cause`). A row that no pass settles ends at its delivery window
(`BRIDGE_DELIVERY_TIMED_OUT`).

Known limit: the Agglayer indexer lists the deposits of a destination by their source hash only, and the reconciler has
no other way to find a deposit. A row whose job the relay deleted (24 hours after it became final) and whose hash was
never written thus waits for its delivery window, also when the deposit landed.

### One batch for several calls (`sendCalls`)

A flow that must send `approve` and then the bridge call (Agglayer) calls `provider.sendCalls([approve, bridgeCall])`:
one Calibur batch, one relay job, one fee in `deduct` mode. It resolves with the mined transaction hash of a job that
`succeeded`. Calibur runs the batch with `revertOnFailure: true`, so a failed inner call reverts the whole
transaction. The relay sets the job state from the receipt status of the mined transaction, so a receipt read of the
hash through a normal public client shows `success` for a good batch and `reverted` for a failed one. A `reverted`
job rejects `sendCalls` with `RelayRevertedError`, whose `txHash` is that mined hash; `sendCalls` never resolves with
the hash of a reverted batch. The relay also simulates the batch before it sends it, so a batch that would revert is
usually refused (`simulation_failed`) before it is mined.

### The pending deposit (`pending-deposit.ts`)

A deposit that the user reviewed and did not fund yet. It is a storage record, not a transaction row.

```ts
pendingRelayDepositsKey(accountPublicKey)      // 'relay_pending_deposits_v1:<key>'
usePendingRelayDeposits(accountPublicKey | undefined): PendingRelayDeposit[]  // storage hook; suspends on first read
savePendingRelayDeposit(deposit): Promise<void>    // TypeError for a record that does not parse
removePendingRelayDeposit(accountPublicKey, id): Promise<void>
readPendingRelayDeposits(accountPublicKey): Promise<PendingRelayDeposit[]>
createPendingRelayDepositId(): string
```

- Writes go only through `putToStorage`, in one `inStorageTurn` of the key (read, change, write). Reads go through
  `useStorage` or `fetchFromStorage`. Every read parses strictly and drops an entry that does not parse (another
  account, a bad address, a base amount of 0, ...). The list keeps at most 5 entries for each account, newest first
  (`createdAt`), one for each id.
- Every wallet wipe (`lib/miden/reset.ts`) removes the key, since it is not in `PRESERVED_STORAGE_KEYS`, and re-reads
  the hooks' cache.

### The deposit watch (`use-deposit-arrival.ts`)

`useDepositArrival(deposit)` reads the balance of the deposit's one token at its relay address on its chain through
`useRelayAccount` (every 10 seconds while the page is on screen) and gives `waiting` (balance null before a read that
passed, or 0), `partial` (more than 0, less than the reviewed amount) or `arrived` (at least the reviewed amount),
with `needsAuthorization`, `mode` and the error of the last read. The state keeps the last read that passed. The rule
has no baseline: a balance that was at the address before the deposit counts. It starts nothing.

### Payment links (`lib/evm/payment-links.ts`)

`evmPaymentLinks({ chainId, token, to, amountBaseUnits, decimals })` gives the Trust, MetaMask and Rainbow links of a
transfer (token null or the zero address: the native coin), and an empty list for a chain with no mapping (Ethereum,
Base, Arbitrum and Optimism have one). The 1Click links (`lib/one-click/payment-links.ts`) use the same builder.

## Account poll (`use-relay-account.ts`)

`useRelayAccount({ chainId, address, tokens })` reads `GET /v1/account` every 10 seconds while the page is on screen
and the relay is on for the chain (`selectRelayChain`: the switch is on and the document lists the chain in
`supportedEvmChains`), and gives `{ account, error, isLoading, refresh }`. Off screen its SWR key is null. A chain
that the service does not serve fails with `unsupported_chain`.
An answer must pass `assertRelayAccountMatches`. A page uses it to see when funds arrive at the deposit address. The
minimum amount of a deposit is the rule of the bridge flow, not of the relay.

A read of `GET /v1/account` reads the balance of the deposit address. The Deposit flow reads it only on the address
step of a deposit whose address the user already has (and the Home row and the arrival watcher, for such a deposit).
What it needs before that step comes from the service read below.

## Service read (`use-relay-service.ts`)

`useRelayService(enabled)` reads `GET /v1/chains` (`fetchRelayService`) one time while the page is on screen and
`enabled`, and keeps the answer for `RELAY_SERVICE_CACHE_MS` (60 s). Its SWR key holds the base URL and the configured
executor, never an address. It gives `{ status: 'off' }` (not asked, or the relay is off), `loading`,
`{ status: 'ready', service }` or `{ status: 'unreachable', error }`. An answer must pass `assertRelayServiceMatches`
(the executor is the configured one). A failed read is not tried again on its own: a network failure, a timeout, a
refused or malformed answer and the `404 not_found` of an older service with no such route are all `unreachable`, and
the Deposit flow then offers no relay route. The flow offers a relay route only on a chain in `service.chains`, and
none while `service.mode` is `deduct`.

## Base URL (`base-url.ts`)

- `getRelayBaseUrl(): string | null`: the `MIDEN_EVM_RELAY_URL` build define when it is a loopback
  `http://localhost` or `http://127.0.0.1` URL (a local Worker), else the document's `relay.baseUrl`, else null
  (relay off). Every `vite.*.config.ts` defines `MIDEN_EVM_RELAY_URL`, empty by default.

## Client (`client.ts`)

Each call awaits `initBridgeConfig()` (it does not wait for the network), reads the base URL, has a 10 s timeout
(`RELAY_TIMEOUT_MS`) and reads at most 64 KiB (`MAX_RELAY_RESPONSE_BYTES`). The last argument is optional
`{ fetch }` for tests.

- `fetchRelayService()`: `GET /v1/chains`, `{ mode, executor, chains }` (chain ids strictly ascending; a field of the
  wrong type refuses the answer, unknown fields are ignored). It reads no address.
- `fetchRelayAccount({ chainId, address, tokens? })`: `GET /v1/account`. `tokens` (1 to 16 distinct addresses, the
  zero address is the native coin) asks for balances; the answer must give one balance for each distinct token, in
  the order of the query.
- `fetchRelayQuote({ chainId, evmAddress, calls, feeToken, authorization? })`: `POST /v1/quote`, the
  `RelayQuote` `{ chainId, token, recipient, fee, gas, validUntil }`. `calls` are 1 to 7 calls
  (`MAX_RELAY_QUOTE_CALLS`) without the fee call; a target that is the zero address or the relay address, a value that
  is not a uint256 and calldata that is not whole bytes are a `TypeError`. `authorization` is sent only when given.
  `relayQuoteBody(query)` is the pure JSON body. The caller checks the answer with `assertRelayQuoteMatches`
  (`quoteRelayFee` does).
- `submitRelay(request: RelaySubmission)`: `POST /v1/relay`. The service answers the same request with the same
  job.
- `fetchRelayJob({ id, chainId? })`: `GET /v1/relay/{id}`.
- `relaySubmissionBody(request)`: the pure JSON body of `POST /v1/relay`. The calls are sent exactly as signed, call
  values and the batch nonce are decimal strings, and `deadline` is a number.

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
- `RelayFeeTooLowError` (a `RelayApiError` with code `fee_too_low`): `required` (base units) and `token`, the fee that
  the relay asks for now.
- `RelayUnavailableError`: `reason` is `not_configured`, `network`, `timeout` or `bad_response`.
- `RelayMismatchError`: a guard refused the answer, or the backend signed something that the submitter did not ask
  for.
- `RelayRefusedError`: the wallet refused a quote or refused to sign. `reason` is `no-reviewed-fee`,
  `unexpected-fee`, `no-fee`, `fee-not-accepted`, `quote-expired`, `target-not-allowed` or `too-many-calls`.
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
    `fee_too_low` (show `required` in the new review), `fee_not_needed` (the relay sponsors the gas now), and the
    refusal `quote-expired`.
  - `stop`: every other error (`fee_token_not_accepted` included).

## Guards (`guards.ts`)

- `assertRelayAccountMatches(account, chain, address)`: the account echoes the asked chain and address, its executor
  is the configured `chain.executor`, a `sponsor` account has no fee recipient and no fee tokens, and a `deduct`
  account names the configured `chain.feeRecipient` (`deductFeeRecipient`). Else it throws `RelayMismatchError`.
- `assertRelayServiceMatches(service, relay)`: the service names the configured `relay.executor` (letter case
  ignored). Else it throws `RelayMismatchError`.
- `assertRelayQuoteMatches(quote, chain, feeToken, nowSeconds)`: see the fee rule. `assertFeeWithinCap` (the config
  `maxFee`), `assertRelayTakesFeeToken` (the account's `feeTokens`) and `relayFeeToken` are the parts that `submit`
  also uses.
- `assertRelayJobMatches(job, expectedId)`: the job id is the EIP-712 digest that the wallet computed. Else it
  throws `RelayMismatchError`.

## The vault rule (`lib/miden/relay-key/sign-rules.ts`)

The relay key signs only what the backend builds from a structured `RelaySignRequest`: an EIP-7702 authorization to
the pinned Calibur of the remote config (the request sets only the chain and the nonce), or a batch of 1 to 8 calls
(`to` not the zero address and not the relay address itself, a uint256 `value`, `data` of at most 32 KiB) with the
configured executor, a batch nonce under `RELAY_NONCE_KEY`, the Calibur domain salt and a deadline at most 24 hours
ahead. It never signs a raw digest, a message or a transaction. The vault cannot tell a fee call from another call,
so the fee rule is the submitter's check.
