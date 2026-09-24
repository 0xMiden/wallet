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

| Item                                                           | Value                                                                                                                                                                                                       |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain network account (faucet + registry, one public account) | `0xead81800958e7a112d45bdcf852fa6`, created at block 61768                                                                                                                                                  |
| Payment and fee token                                          | native MIDEN `0x18101fa522c174b165efd4f70a0385`, 6 decimals                                                                                                                                                 |
| Price by label length 1 / 2 / 3 / 4 / 5+                       | 375 / 200 / 120 / 55 / 20 MIDEN, read live from the `prices` map                                                                                                                                            |
| Sponsorship the registry charges per register note             | 210 base units, read live from `fee_schedule[scriptRoot]` = `[210, 0, 0, 1]`                                                                                                                                |
| Register note script                                           | root `0xdbac2a36…b6a2`, vendored as base64 in `public/miden-name/note-scripts.json` (16 810 bytes), present on the registry's `allowed_note_scripts` allowlist                                              |
| Registry note script (set / clear records)                     | root `0xb862b950…ca05`, vendored in the same asset (23 180 bytes), on the allowlist. Sent by the publish flow (`nfa.ts`); the clear actions are not wired                                                                                     |
| Label rules                                                    | `[a-z0-9]{1,21}`; `a–z → 1..26`, `0–9 → 27..36`; 7 codes per felt, 8 bits each, little endian                                                                                                               |
| Domain word                                                    | `[chars14..20, chars7..13, chars0..6, length]`                                                                                                                                                              |
| Commitment                                                     | `Poseidon2(TAG ‖ domainWord ‖ [0, 0, registry.suffix, registry.prefix])`, `TAG = [31013299120531821, 30803248544050529, 54383671667041, 20]`                                                                |
| Status / token key                                             | `[c0, c1, 0, 0]` into `domain_faucet::domain_faucet::asset_status` (0 free, 1 issued) and `…::token_to_domain` (value = domain word)                                                                        |
| Price key                                                      | `[min(len, 5), 0, token.suffix, token.prefix]` into `domain_faucet::domain_faucet::prices`                                                                                                                  |
| Registry maps                                                  | `domain_registry::domain_registry::domain_to_account` and `…::account_to_domain`; account key `[0, 0, acct.suffix, acct.prefix]`; the domain-side key is NOT verified (both maps have zero writes on chain) |
| Reclaim window                                                 | the register note commits `reclaimHeight = tip + 300`                                                                                                                                                       |

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
4. Publish (Settings → Miden Name → "Publish"): the wallet sends a public registry note that
   carries the NFA with action `3`. The registry writes `domain_to_account` and
   `account_to_domain` and returns the NFA in a new P2ID note, which the tracker consumes.
   The name now resolves in every wallet's send flow.

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

| File                          | Purpose                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`                   | `getMidenNameConfig()`, `isMidenNameSupported()`, the storage slot names (`MIDEN_NAME_SLOTS`), the pinned script root and protocol constants.                                                                                                                                                                                                                                                                    |
| `encoding.ts`                 | Pure bigint code, no SDK import: label validation and normalisation, domain word encode/decode, commitment preimage, map-key felts, `registerNoteInputs`. Fully unit tested with on-chain fixtures (`miden` → `[0, 0, 60213692685, 5]`).                                                                                                                                                                         |
| `sdk-words.ts`                | The only SDK glue for felts: `Word` conversions, `Poseidon2` commitment, `decodeAccountWord`. Makes NEW wasm objects on every call.                                                                                                                                                                                                                                                                              |
| `reads.ts`                    | `fetchMidenNameQuote` (availability + price + allowlist + fee in ONE proof, 30 s cache, `fresh` bypass), `fetchMidenNameIssued`, `fetchRegistrationNoteState` (network-note status; a not-found id is reported as `unknown`), `findRegistryDeliveryNoteIds` (`syncNotes` cursor scan for notes the registry sent us), `getChainTip`.                                                                             |
| `resolver.ts`                 | `resolveMidenName(label)` → bech32 or null, accepted only when the forward map and the reverse map agree; `reverseResolveMidenName(account)`. 60 s cache. RPC errors are thrown, not cached. Always on where the network has a deployment: the send flow and the reverse check gate on `isMidenNameSupported()` only. Until the registry maps have records, a name gives "Name not found" (`midenNameNotFound`). |
| `note-script-roots.ts`        | The pinned MAST roots and byte sizes of the register-domain and registry scripts, and the path of the asset.                                                                                                                                                                                                                                                                                                     |
| `script.ts`                   | `loadRegisterDomainScript()` / `loadRegistryNoteScript()`: fetch `public/miden-name/note-scripts.json` once per realm (cached, a failed fetch is retried), check the declared root and size against the pins, deserialize, and refuse a MAST root mismatch. Async: `note.ts` loads the script BEFORE it takes the WASM lock.                                                                                     |
| `note.ts`                     | `buildRegisterNameRequest()`: fresh chain tip, reclaim height, random fee salt, then under `withWasmClientLock` (`assertWasmHoldCurrent` after the account read) builds the note and serializes the request. Build ONCE per tap and keep the bytes on the row: the serial and the salt are random, and a rebuild changes the note id.                                                                            |
| `guard.ts`                    | `assertRegistrationPreconditions()` before the tap and `assertMidenNameRegistrationLive()` immediately before every submit (both pipeline branches): fresh status, price, allowlist, fee, script root, and `tip < reclaimHeight - 20`. RPC only.                                                                                                                                                                 |
| `registrations.ts`            | Dexie live queries over `register-name` rows: `phaseOf`, `uiStateOf`, `useMidenNameRegistrations`, `useOwnedMidenName`. A `Completed` row still at phase `requested` counts as `submitted`.                                                                                                                                                                                                                      |
| `tracker.ts`                  | `reconcileMidenNameRegistrations()`: one pass over the non-terminal rows (see "State machine"). RPC and Dexie only; the only WASM entry is `initiateConsumeTransactionFromId`.                                                                                                                                                                                                                                   |
| `MidenNameWatcher.tsx`        | Mounted in `src/lib/miden/front/provider.tsx`. Runs the tracker every 10 s while a wallet UI is open, skips when the document is hidden, single-flight through `navigator.locks` (`ifAvailable`).                                                                                                                                                                                                                |
| `useMidenNameResolvesHere.ts` | Reverse check for the "resolves to this account" pill. Runs where the network has a deployment; false until the registry has a reverse record for the account.                                                                                                                                                                                                                                                   |
| `nfa.ts`                      | The NFA side (SDK ≥ 0.16.2, `AssetVault.nonFungibleAssets`, `NoteAssets` with an NFA). `findDomainNfa` matches a label to a vault NFA (registry faucet, and the first two limbs of `vaultKey()` equal the first two felts of the domain commitment; any other layout is "not held", never a false positive). `accountHoldsDomainNfa` (vault only), `listOwnedDomainLabels` (vault keys → `token_to_domain` → decode → commitment check; for recovery with no local history), `buildPublishNameRecordRequest` (registry note with the NFA, storage `[registry.prefix, registry.suffix, dw0..dw3, reclaimHeight, 3]`, built ONCE like the register note, script fetched before the lock) and `publishRegistryRecord` (build + queue a `publish-name-record` row, returns its id). `REGISTRY_PUBLISHING_SUPPORTED = true`; `REGISTRY_CLEARING_SUPPORTED = false` keeps the "Clear" control disabled until the semantics of actions 4..6 are confirmed.                                                                                                                                                                      |
| `errors.ts`                   | Typed errors (`MidenNameTakenError`, `MidenNamePriceChangedError`, `MidenNameScriptNotAllowedError`, …).                                                                                                                                                                                                                                                                                                         |
| `test-support/fake-sdk.ts`    | Typed fake of the SDK classes for the unit tests.                                                                                                                                                                                                                                                                                                                                                                |

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

| Row state                                  | Read                                                                             | Result                                                                                                                                                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| status `Failed`                            | –                                                                                | `failed / tx-failed`                                                                                                                                                                                                           |
| `Completed` + `submitted` (or `requested`) | `fetchRegistrationNoteState(registrationNoteId)`                                 | `consumed` and `asset_status` = 1 → `issued`; `discarded` → `failed / taken` if the label is issued by someone else, else `failed / discarded`; `pending`/`inflight`/`unknown` with `tip > reclaimHeight` → `failed / expired` |
| `issued`                                   | `findRegistryDeliveryNoteIds` from `builtAtBlock` (cursor in `deliveryScanFrom`) | first note with no live consume row → `initiateConsumeTransactionFromId` → `tagConsumeAsMidenNameClaim` → `claiming`, then kick processing; a "not found" (local store not synced yet) retries next tick                       |
| `claiming`                                 | the claim row                                                                    | `Completed` → `owned` (the consume completion also writes this); `Failed` → back to `issued` with `lastError`                                                                                                                  |

Per `publish-name-record` row (`IPublishNameRecordExtraInputs`, phase
`requested → submitted → recorded → returning → done`, `failed ∈ tx-failed | discarded |
expired | return-failed`, `patchPublishNameRecordExtraInputs` enforces the order with the one
move back `returning → recorded`):

| Row state | Read | Result |
| --- | --- | --- |
| status `Failed` | – | `failed / tx-failed` |
| `Completed` + `submitted` (or `requested`) | `fetchRegistrationNoteState(registryNoteId)` | `consumed` and `fetchDomainRecord(label)` points to the account → `recorded`; `discarded` → `failed / discarded`; not consumed with `tip > reclaimHeight` → `failed / expired` |
| `recorded` | `findRegistryDeliveryNoteIds` from `builtAtBlock` (cursor in `returnScanFrom`) | first note with no live consume row → `initiateConsumeTransactionFromId` → `tagConsumeAsMidenNameReturn` → `returning` |
| `returning` | the return row | `Completed` → `done` (the consume completion also writes this, message "Name returned"); `Failed` → back to `recorded` with `lastError` |

The delivery scan is shared: a consume row tagged for either flow (`midenNameClaim` or
`midenNameReturn`) is linked through `linkedRowIdOf`, so a return note is never claimed as
a delivery note and the reverse.

The delivery note carries ONLY the NFA. The wallet's normal claimable-notes paths drop
notes without a fungible asset (`sync-manager.ts`, `front/claimable-notes.ts`), which is why
the tracker finds it by RPC and consumes it by note id. `completeConsumeTransaction` was
relaxed to complete such a note with no amount (`'Name received'`).

## Pipeline

`register-name` and `publish-name-record` are pre-built-bytes types like `earn-deposit`: the
request bytes live on the row and are reused for every attempt. The publish row moves no
fungible asset (it is inserted directly, not through the spending-limit queue), its guard is
`assertMidenNamePublishLive` (registry script allowlist, root, reclaim height; custody of
the NFA is not re-checked, the execution fails without it), and its guardian proposal type
is `publish_name_record`. Everything below applies to both types. Non-guardian accounts write through
`midenClientProxy.newTransaction`; guardian accounts go through
`createCustomProposal(bytes, 'register_name')` and `signAndCreateTransactionRequest` with
the same bytes. The guard runs before the write in both branches. The type is in
`REQUEUEABLE_ON_PENDING_CONFLICT` and `OUTGOING_TYPES` (spending limits) and is left out of
`REQUEUEABLE_TYPES`, `NODE_VERIFIED_RETRY_TYPES`, `REBUILT_REQUEST_TYPES` and the offscreen
guardian route.

## Remaining work

### 1. Registry records: validated on Guardian Testnet

Resolution reads the registry's `domain_to_account` map, and that map is written only when
the owner sends a PUBLIC registry note to the domain account with action `3`
(`update_registry_records`), carrying the NFA as the note asset. The registry verifies the
NFA, writes both records and returns the NFA in a new P2ID note that the wallet consumes
again. Actions `4`–`6` clear the records and carry no asset. The publish flow (`nfa.ts`, the
`publish-name-record` type, the tracker) is built on:

- the vendored `registry` script (`public/miden-name/note-scripts.json`, root
  `0xb862b950…ca05`, from the `noteScripts` artifact of the miden.name bundle, confirmed by
  Digine Labs as the v0.16 registry script; only 13 roots are on the allowlist, so a script
  compiled locally is rejected — keep the vendored bytes);
- the NFA surface of web-sdk ≥ 0.16.2 (`AssetVault.nonFungibleAssets`, `NonFungibleAsset`,
  `NoteAssets` with an NFA), tracked in
  [web-sdk#415](https://github.com/0xMiden/web-sdk/issues/415). The wallet is linked to a
  local web-sdk build until that release lands (see `.linked-web-sdk-pr.json`).

A Guardian Testnet publish completed the full round trip: the name resolved, the return
note was consumed, and the exact NFA was back in the local vault. The SDK reported a
post-submit note-screener error during local apply; the tracker still reached `done`.
Non-Guardian accounts and native platforms still need live validation. These checks apply:

- The registry-note storage starts with the registry account prefix and suffix. The
  note metadata identifies the sender, who gets the record and the returned NFA. A
  Testnet note built with the sender as the storage target remained pending with an
  execution error. Changing the builder does not repair an existing note; the sender
  must reclaim its NFA after the committed reclaim height.
- the NFA vault-key layout: `findDomainNfa` expects the first two limbs of `vaultKey()` to
  be the first two felts of the domain commitment. A different layout gives "not held"
  (the Publish tap fails with `MidenNameNotHeldError`), never a wrong note.

Still open: the clear actions (`REGISTRY_CLEARING_SUPPORTED`), an automatic publish after
`owned` (with consent shown once on the claim screen), and the on-chain check of the
domain-side key of `domain_to_account` (the resolver tries the commitment key first, then
the raw domain word). The fourth step of the status page (`screens/miden-name/steps.ts`,
`publishStepState`) is derived from the newest publish row OF THE SAME LABEL (publish rows
are not linked to their register row by id) plus the on-chain record (`useMidenNameRecord`):
`active` while a publish is in flight, `complete` when the record points to the account
(also with no local row: published from an other device), `failed` for a failed publish with
no record, else `pending` with a Publish button and an explainer that says a publish reveals
the owner. The Publish button waits for the first record read (`record !== 'checking'`), so
a tap cannot publish twice.

### 2. Exact ownership

"Owned" in the UI is still derived from wallet-recorded registrations. The vault read
exists (`listOwnedDomainLabels` in `nfa.ts`: registry NFAs → `token_to_domain` → decode →
commitment check) but nothing calls it yet. Wire it into `useOwnedMidenName` (or a restore
step) once the key layout is confirmed by a live registration.

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
