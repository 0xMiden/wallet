# Miden Name (`.miden` names)

Wallet integration of [Miden Name](https://docs.miden.name) (Digine Labs, contract v0.16).
A name such as `alice.miden` is a deterministic non-fungible asset (NFA). The account that
holds the exact NFA owns the name. This folder holds everything that talks to the protocol.
The screens live in `src/screens/miden-name/`, the Settings page in
`src/app/templates/MidenNameSettings.tsx`, and the transaction type in
`src/lib/miden/transaction/` (`register-name`).

Testnet only. `MIDEN_NAME_DEPLOYMENTS` in `src/lib/miden-chain/networks-config.ts` is the
per-network map; a network without an entry hides the feature (`isMidenNameSupported()`).

## Protocol facts the code relies on

All of these were verified against the Testnet deployment.

| Item | Value |
| --- | --- |
| Domain network account (faucet + registry, one public account) | `0xead81800958e7a112d45bdcf852fa6`, created at block 61768 |
| Payment and fee token | native MIDEN `0x18101fa522c174b165efd4f70a0385`, 6 decimals |
| Price by label length 1 / 2 / 3 / 4 / 5+ | 375 / 200 / 120 / 55 / 20 MIDEN, read live from the `prices` map |
| Sponsorship the registry charges per register note | 210 base units, read live from `fee_schedule[scriptRoot]` = `[210, 0, 0, 1]` |
| Register note script | root `0xdbac2a36…b6a2`, vendored as base64 in `register-domain-script.ts` (16 810 bytes), present on the registry's `allowed_note_scripts` allowlist |
| Label rules | `[a-z0-9]{1,21}`; `a–z → 1..26`, `0–9 → 27..36`; 7 codes per felt, 8 bits each, little endian |
| Domain word | `[chars14..20, chars7..13, chars0..6, length]` |
| Commitment | `Poseidon2(TAG ‖ domainWord ‖ [0, 0, registry.suffix, registry.prefix])`, `TAG = [31013299120531821, 30803248544050529, 54383671667041, 20]` |
| Status / token key | `[c0, c1, 0, 0]` into `domain_faucet::domain_faucet::asset_status` (0 free, 1 issued) and `…::token_to_domain` (value = domain word) |
| Price key | `[min(len, 5), 0, token.suffix, token.prefix]` into `domain_faucet::domain_faucet::prices` |
| Registry maps | `domain_registry::domain_registry::domain_to_account` and `…::account_to_domain`; account key `[0, 0, acct.suffix, acct.prefix]`; the domain-side key is NOT verified (both maps have zero writes on chain) |
| Reclaim window | the register note commits `reclaimHeight = tip + 300` |

The register note is PUBLIC, tagged `NoteTag.withAccountTarget(registry)`, carries a
`NetworkAccountTarget(registry)` attachment and exactly one `FungibleAsset(MIDEN, price)`.
Its storage is seven felts, in this order:
`[registry.prefix, registry.suffix, dw0, dw1, dw2, dw3, reclaimHeight]`.

The note holds the price only. The 210 base-unit sponsorship is NOT in the note: the
sender's own auth fee payment (`miden-standards` `fee::pay_fee` →
`pay_network_note_sponsorships`) creates a second FEE_SPONSORSHIP output note for every
network output note, priced by an FPI call into the registry's fee policy. The request
declares no foreign account, which matches the reference miden.name client and its 1 000+
successful registrations. If a testnet run ever fails with a sponsorship-estimate / FPI
error, add `withForeignAccounts(ForeignAccount.public(registry, requirements for the
fee_schedule key))` in `note.ts`.

Registration lifecycle:

1. Wallet submits the register note (through the guardian for multisig accounts).
2. The registry consumes it (`getNetworkNoteStatus` → `NullifierCommitted`), marks the label
   issued (`asset_status` = 1), mints the NFA and sends it back in a public P2ID note.
3. The wallet consumes that P2ID note. The NFA is now in the vault: the name is owned.
4. NOT built (see "Remaining work"): publishing the registry record that makes the name
   resolvable by other wallets.

## Reads: no WASM client, no lock

Every read is a bare `RpcClient.getAccountProof(registry, AccountStorageRequirements)` with
the exact map keys we need. The node returns a partial SMT with only those keys, proven
against the account commitment, in about one second. NEVER call `getAccountDetails` or
`importAccountById` on the registry: the node refuses the full account because the
`token_to_domain` map is too large, and a full copy has no business in the wallet's store.

Every RPC call goes through `withRpcTimeout`, and every wasm argument (`Word`,
`SlotAndKeys`, `NoteTag`, `NoteId`) is built INSIDE the retried closure because the call
moves it into Rust.

## Module map

| File | Purpose |
| --- | --- |
| `config.ts` | `getMidenNameConfig()`, `isMidenNameSupported()`, the storage slot names (`MIDEN_NAME_SLOTS`), the pinned script root and protocol constants. |
| `encoding.ts` | Pure bigint code, no SDK import: label validation and normalisation, domain word encode/decode, commitment preimage, map-key felts, `registerNoteInputs`. Fully unit tested with on-chain fixtures (`miden` → `[0, 0, 60213692685, 5]`). |
| `sdk-words.ts` | The only SDK glue for felts: `Word` conversions, `Poseidon2` commitment, `decodeAccountWord`. Makes NEW wasm objects on every call. |
| `reads.ts` | `fetchMidenNameQuote` (availability + price + allowlist + fee in ONE proof, 30 s cache, `fresh` bypass), `fetchMidenNameIssued`, `fetchRegistrationNoteState` (network-note status; a not-found id is reported as `unknown`), `findRegistryDeliveryNoteIds` (`syncNotes` cursor scan for notes the registry sent us), `getChainTip`. |
| `resolver.ts` | `resolveMidenName(label)` → bech32 or null, accepted only when the forward map and the reverse map agree; `reverseResolveMidenName(account)`. 60 s cache. RPC errors are thrown, not cached. Always on where the network has a deployment: the send flow and the reverse check gate on `isMidenNameSupported()` only. Until the registry maps have records, a name gives "Name not found" (`midenNameNotFound`). |
| `register-domain-script.ts` | GENERATED. The serialized register script and its root. Do not edit by hand. |
| `script.ts` | `loadRegisterDomainScript()`: deserializes the script and refuses a root mismatch. |
| `note.ts` | `buildRegisterNameRequest()`: fresh chain tip, reclaim height, random fee salt, then under `withWasmClientLock` (`assertWasmHoldCurrent` after the account read) builds the note and serializes the request. Build ONCE per tap and keep the bytes on the row: the serial and the salt are random, and a rebuild changes the note id. |
| `guard.ts` | `assertRegistrationPreconditions()` before the tap and `assertMidenNameRegistrationLive()` immediately before every submit (both pipeline branches): fresh status, price, allowlist, fee, script root, and `tip < reclaimHeight - 20`. RPC only. |
| `registrations.ts` | Dexie live queries over `register-name` rows: `phaseOf`, `uiStateOf`, `useMidenNameRegistrations`, `useOwnedMidenName`. A `Completed` row still at phase `requested` counts as `submitted`. |
| `tracker.ts` | `reconcileMidenNameRegistrations()`: one pass over the non-terminal rows (see "State machine"). RPC and Dexie only; the only WASM entry is `initiateConsumeTransactionFromId`. |
| `MidenNameWatcher.tsx` | Mounted in `src/lib/miden/front/provider.tsx`. Runs the tracker every 10 s while a wallet UI is open, skips when the document is hidden, single-flight through `navigator.locks` (`ifAvailable`). |
| `useMidenNameResolvesHere.ts` | Reverse check for the "resolves to this account" pill. Runs where the network has a deployment; false until the registry has a reverse record for the account. |
| `nfa.ts` | Stubs for the parts that need the SDK NFA binding: `accountHoldsDomainNfa` → `'unsupported'`, `publishRegistryRecord` throws, `REGISTRY_PUBLISHING_SUPPORTED = false`. The UI binds its disabled "Publish" / "Clear" controls to this flag. |
| `errors.ts` | Typed errors (`MidenNameTakenError`, `MidenNamePriceChangedError`, `MidenNameScriptNotAllowedError`, …). |
| `test-support/fake-sdk.ts` | Typed fake of the SDK classes for the unit tests. |

## State of record

The `register-name` transaction row (`RegisterNameTransaction`,
`IRegisterNameExtraInputs` in `src/lib/miden/db/types.ts`) is the single source of truth.
Dexie live queries update every realm and platform; key/value storage does not fire change
events on mobile and desktop, which is why it was not used.

`extraInputs.phase` moves `requested → submitted → issued → claiming → owned`, with `failed`
terminal (`failure ∈ tx-failed | discarded | taken | expired | claim-failed`).
`patchRegisterNameExtraInputs` in `transaction/complete.ts` enforces the order: no move back
except `claiming → issued` (a failed claim re-queues), and nothing moves `failed` or `owned`.

## State machine (tracker)

Per row on the current network that is not `restoredFromBackup`:

| Row state | Read | Result |
| --- | --- | --- |
| status `Failed` | – | `failed / tx-failed` |
| `Completed` + `submitted` (or `requested`) | `fetchRegistrationNoteState(registrationNoteId)` | `consumed` and `asset_status` = 1 → `issued`; `discarded` → `failed / taken` if the label is issued by someone else, else `failed / discarded`; `pending`/`inflight`/`unknown` with `tip > reclaimHeight` → `failed / expired` |
| `issued` | `findRegistryDeliveryNoteIds` from `builtAtBlock` (cursor in `deliveryScanFrom`) | first note with no live consume row → `initiateConsumeTransactionFromId` → `tagConsumeAsMidenNameClaim` → `claiming`, then kick processing; a "not found" (local store not synced yet) retries next tick |
| `claiming` | the claim row | `Completed` → `owned` (the consume completion also writes this); `Failed` → back to `issued` with `lastError` |

The delivery note carries ONLY the NFA. The wallet's normal claimable-notes paths drop
notes without a fungible asset (`sync-manager.ts`, `front/claimable-notes.ts`), which is why
the tracker finds it by RPC and consumes it by note id. `completeConsumeTransaction` was
relaxed to complete such a note with no amount (`'Name received'`).

## Pipeline

`register-name` is a pre-built-bytes type like `earn-deposit`: the request bytes live on the
row and are reused for every attempt. Non-guardian accounts write through
`midenClientProxy.newTransaction`; guardian accounts go through
`createCustomProposal(bytes, 'register_name')` and `signAndCreateTransactionRequest` with
the same bytes. The guard runs before the write in both branches. The type is in
`REQUEUEABLE_ON_PENDING_CONFLICT` and `OUTGOING_TYPES` (spending limits) and is left out of
`REQUEUEABLE_TYPES`, `NODE_VERIFIED_RETRY_TYPES`, `REBUILT_REQUEST_TYPES` and the offscreen
guardian route.

## Remaining work

### 1. Registry records (the part that makes a name usable for sending)

Owning the NFA does not make `alice.miden` resolvable. Resolution reads the registry's
`domain_to_account` map, and that map is written only when the owner sends a PUBLIC
`registry-note` to the domain account with action `3` (`update_registry_records`), carrying
the NFA as the note asset. The registry verifies the NFA, writes both records and returns
the NFA in a new P2ID note that the wallet must consume again. Actions `4`–`6` clear the
records and carry no asset.

Registry-note storage layout (from the Digine handoff):
`[target_prefix, target_suffix, domain_0..3, reclaim_height, action]`.

Blocked on two external items:

- **The `registry-note` script bytes.** Not released by Digine Labs. Only 13 script roots
  are on the registry's allowlist, so a script compiled locally is rejected. Ask for the
  reviewed serialized builder (their generated `domain-v016.json` has the register scripts
  but not this one).
- **Non-fungible assets in the web SDK.** `NoteAssets` accepts only `FungibleAsset` and
  `AssetVault` exposes only fungible assets in SDK 0.16.x, so the wallet cannot put the
  NFA into a note nor enumerate owned NFAs. Once the binding exists, implement
  `accountHoldsDomainNfa` and `publishRegistryRecord` in `nfa.ts`, flip
  `REGISTRY_PUBLISHING_SUPPORTED`, and add a `publish-name-record` transaction type
  modelled on `register-name` (the returned NFA P2ID is consumed like the delivery note).

When both land: run the publish step automatically after `owned` (with the user's consent
shown once on the claim screen), enable the fourth step of the status page, and verify the
domain-side key derivation of `domain_to_account` on chain (the resolver tries the
commitment key first, then the raw domain word). Resolution in the send flow is already on
for every network with a deployment; until records exist it gives "Name not found".

### 2. Exact ownership

"Owned" is currently derived from wallet-recorded registrations (register tx landed,
registry consumed it, label issued on chain, delivery note consumed). It is not a vault
read. With the NFA binding, `useOwnedMidenName` should list names from the vault:
enumerate NFAs of the registry faucet, read `token_to_domain[[c0, c1, 0, 0]]`, decode the
domain word, and recompute the commitment to compare all four limbs.

### 3. Pay-to-name

P2N / P2NE notes let a sender pay a name without resolution. They need the receiving
account to carry the `DomainOwnership` component, existing immutable accounts cannot be
retrofitted, and the Testnet packages are mis-pinned. Out of scope by decision.

### 4. Smaller follow-ups

- Payment reclaim after the 300-block window when the registry never consumes the request
  (the note has the branch; the flow is unvalidated even by Digine).
- Run the tracker from the service worker's periodic alarm, so a closed extension popup
  does not pause an in-flight claim.
- A devnet deployment, so the E2E harness can cover the flow.
- Referral registration (second bundled script, `register_domain_with_referral`).
