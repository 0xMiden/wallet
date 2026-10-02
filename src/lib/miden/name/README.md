# Miden Name (`.miden` names)

Wallet integration of [Miden Name](https://docs.miden.name) (Digine Labs, contract v0.16
with auto-publication). A name such as `alice.miden` is a deterministic non-fungible asset
(NFA). The account that holds the exact NFA owns the name, and the registry writes the
records that make the name resolve in the same transaction that mints the NFA. This folder
holds everything that talks to the protocol.
The screens live in `src/screens/miden-name/`, the Settings page in
`src/app/templates/MidenNameSettings.tsx`, and the transaction type in
`src/lib/miden/transaction/` (`register-name`).

Testnet only. `MIDEN_NAME_DEPLOYMENTS` in `src/lib/miden-chain/networks-config.ts` is the
per-network map; a network without an entry hides the feature (`isMidenNameSupported()`).

## Protocol facts the code relies on

All of these were verified against the Testnet deployment.

| Item                                                           | Value                                                                                                                                                                                                       |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain network account (faucet + registry, one public account) | `0xe8249fe7070657110980da14461d78`, created at block 632095 (the auto-publication deployment; the earlier account `0xead81800958e7a112d45bdcf852fa6` needed a separate publish note)                          |
| Payment and fee token                                          | native MIDEN `0x18101fa522c174b165efd4f70a0385`, 6 decimals                                                                                                                                                 |
| Price by label length 1 / 2 / 3 / 4 / 5+                       | 375 / 200 / 120 / 55 / 20 MIDEN, read live from the `prices` map                                                                                                                                            |
| Sponsorship the registry charges per register note             | 210 base units per script root, read live from `fee_schedule[scriptRoot]` = `[210, 0, 0, 1]` (verify live before every sign; the quote does)                                                                 |
| Register note script (standard registration)                   | root `0x70cea652…2286`, vendored as base64 in `public/miden-name/note-scripts.json` (17 253 bytes), present on the registry's `allowed_note_scripts` allowlist                                              |
| Referral registration script                                   | root `0x33f7daab…e531`. Not vendored and not used: referral registration is a follow-up                                                                                                                      |
| Label rules                                                    | `[a-z0-9]{1,21}`; `a–z → 1..26`, `0–9 → 27..36`; 7 codes per felt, 8 bits each, little endian                                                                                                               |
| Domain word                                                    | `[chars14..20, chars7..13, chars0..6, length]`                                                                                                                                                              |
| Commitment                                                     | `Poseidon2(TAG ‖ domainWord ‖ [0, 0, registry.suffix, registry.prefix])`, `TAG = [31013299120531821, 30803248544050529, 54383671667041, 20]`                                                                |
| Status / token key                                             | `[c0, c1, 0, 0]` into `domain_faucet::domain_faucet::asset_status` (0 free, 1 issued) and `…::token_to_domain` (value = domain word)                                                                        |
| Price key                                                      | `[min(len, 5), 0, token.suffix, token.prefix]` into `domain_faucet::domain_faucet::prices`                                                                                                                  |
| Registry maps                                                  | `domain_registry::domain_registry::domain_to_account`, keyed by the raw domain word on Testnet (the resolver also tries the commitment key). The auto-publication deployment writes NO `account_to_domain` entry the wallet can find (eight key layouts probed on 2026-10-02), so the wallet reads the forward map only |
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

Registration lifecycle (one wallet write, one registry transaction, one claim):

1. Wallet submits the public register note with the payment (through the guardian for
   multisig accounts).
2. The registry network account consumes it. The registration script calls `mint_domain`
   (or `mint_domain_with_referral`) and then `intent_domain_ownership`: the mint, the forward
   publication (`domain_to_account`) and the P2ID delivery of the
   NFA commit atomically. `getNetworkNoteStatus` → `NullifierCommitted`, `asset_status` = 1.
3. The wallet discovers the delivered P2ID note and consumes it. The NFA is now in the vault:
   the name is owned, and it already resolves in every wallet's send flow.

There is NO separate publish step any more. The earlier deployment needed the owner to send
the NFA back to the registry in a registry note with action `3`; that flow
(`publish-name-record` rows, the `registry` script, the return-note tracking) was removed
when the auto-publication contract went live on Testnet.

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

| File                          | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`                   | `getMidenNameConfig()`, `isMidenNameSupported()`, the storage slot names (`MIDEN_NAME_SLOTS`), the pinned script root and protocol constants.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `encoding.ts`                 | Pure bigint code, no SDK import: label validation and normalisation, domain word encode/decode, commitment preimage, map-key felts, `registerNoteInputs`. Fully unit tested with on-chain fixtures (`miden` → `[0, 0, 60213692685, 5]`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `sdk-words.ts`                | The only SDK glue for felts: `Word` conversions, `Poseidon2` commitment, `decodeAccountWord`. Makes NEW wasm objects on every call.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `reads.ts`                    | `fetchMidenNameQuote` (availability + price + allowlist + fee in ONE proof, 30 s cache, `fresh` bypass), `fetchMidenNameIssued`, `fetchRegistrationNoteState` (network-note status; a not-found id is reported as `unknown`), `findRegistryDeliveryNoteIds` (`syncNotes` cursor scan for notes the registry sent us), `getChainTip`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `resolver.ts`                 | `resolveMidenName(label)` → bech32 or null from the forward map alone (`domain_to_account`); `fetchDomainRecord(label)` / `fetchDomainRecordAccount(label)` are the same read with no cache. 60 s cache. RPC errors are thrown, not cached. Always on where the network has a deployment: the send flow and the record check gate on `isMidenNameSupported()` only. Until the registry maps have records, a name gives "Name not found" (`midenNameNotFound`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `note-script-roots.ts`        | The pinned MAST root and byte size of the register-domain script, and the path of the asset.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `script.ts`                   | `loadRegisterDomainScript()`: fetch `public/miden-name/note-scripts.json` once per realm (cached, a failed fetch is retried), check the declared root and size against the pins, deserialize, and refuse a MAST root mismatch. Async: `note.ts` loads the script BEFORE it takes the WASM lock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `note.ts`                     | `buildRegisterNameRequest()`: fresh chain tip, reclaim height, random fee salt, then under `withWasmClientLock` (`assertWasmHoldCurrent` after the account read) builds the note and serializes the request. Build ONCE per tap and keep the bytes on the row: the serial and the salt are random, and a rebuild changes the note id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `guard.ts`                    | `assertRegistrationPreconditions()` before the tap and `assertMidenNameRegistrationLive()` immediately before every submit (both pipeline branches): fresh status, price, allowlist, fee, script root, and `tip < reclaimHeight - 20`. RPC only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `registrations.ts`            | Dexie live queries over `register-name` rows: `phaseOf`, `uiStateOf`, `useMidenNameRegistrations`, `useOwnedMidenName`. A `Completed` row still at phase `requested` counts as `submitted`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `tracker.ts`                  | `reconcileMidenNameRegistrations()`: one pass over the non-terminal rows (see "State machine"). RPC and Dexie only; the only WASM entry is `initiateConsumeTransactionFromId`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `MidenNameWatcher.tsx`        | Mounted in `src/lib/miden/front/provider.tsx`. Runs the tracker every 10 s while a wallet UI is open, skips when the document is hidden, single-flight through `navigator.locks` (`ifAvailable`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `useMidenNameResolvesHere.ts` | Forward check for the "resolves to this account" pill: true when `domain_to_account[label]` is the account. Runs where the network has a deployment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `nfa.ts`                      | The NFA side (SDK ≥ 0.16.2, `AssetVault.nonFungibleAssets`, `NoteAssets` with an NFA). `findDomainNfa` matches a label to a vault NFA (registry faucet, and the first two limbs of `vaultKey()` equal the first two felts of the domain commitment; any other layout is "not held", never a false positive). `accountHoldsDomainNfa` (vault only), `listOwnedDomainLabels` (vault keys → `token_to_domain` → decode → commitment check; for recovery with no local history), `buildPublishNameRecordRequest` (registry note with the NFA, storage `[registry.prefix, registry.suffix, dw0..dw3, reclaimHeight, 3]`, built ONCE like the register note, script fetched before the lock) and `publishRegistryRecord` (build + queue a `publish-name-record` row, returns its id). `REGISTRY_PUBLISHING_SUPPORTED = true`; `REGISTRY_CLEARING_SUPPORTED = false` keeps the "Clear" control disabled until the semantics of actions 4..6 are confirmed. |
| `errors.ts`                   | Typed errors (`MidenNameTakenError`, `MidenNamePriceChangedError`, `MidenNameScriptNotAllowedError`, …).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `test-support/fake-sdk.ts`    | Typed fake of the SDK classes for the unit tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

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

The delivery scan is PER LABEL: `findRegistryDeliveryNoteIds({ label })` fetches every
registry note of the range (`getNotesById`) and keeps only the public notes whose NFA
carries the domain commitment of that label (`nfasCarryLabel`, sdk-words.ts). The registry
can deliver the notes of two names in any order, and an unfiltered scan handed the first
free note to whichever row ran first. A consume row tagged `midenNameClaim` is linked to its
registration through `linkedRowIdOf`, so one delivery note is never claimed for two rows.

Because the scan is per label, a live consume row of a scanned note WITH NO TAG is a consume
of this name whose tag write was lost (the realm closed between
`initiateConsumeTransactionFromId` and `tagConsumeAsMidenNameClaim`). The tracker ADOPTS it
(`DeliveryNoteState` `untagged`): it writes the tag, and moves the row to `claiming` (live
consume) or straight to `owned` (Completed consume, whose completion hook could not move the
row without the tag). Without this a registration stayed `issued` for ever while the account
held the name, and the scan cursor passed the note.

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

### 1. Live validation of the auto-publication deployment

The code targets the auto-publication registry (`0xe8249fe7…1d78`, created at block 632095)
and the standard registration script root `0x70cea652…2286`. Checks that still need a live
Testnet run on this deployment:

- a full registration on a non-Guardian account, a Guardian account and the native platforms
  (the earlier deployment was validated on Guardian Testnet only);
- the NFA vault-key layout: `findDomainNfa` expects the first two limbs of `vaultKey()` to be
  the first two felts of the domain commitment. A different layout gives "not held", never a
  wrong note;
- the on-chain check of the domain-side key of `domain_to_account` (the resolver tries the
  commitment key first, then the raw domain word);
- the registry-record line in Settings (`useMidenNameRecord`): with auto-publication an
  owned name should read "Resolves to this account" as soon as the delivery note is
  consumed; `none` now only means the proof has not caught up yet.

Clearing records (the registry note actions `4`–`6`) is not wired: it needs the `registry`
note script, which is no longer vendored.

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
