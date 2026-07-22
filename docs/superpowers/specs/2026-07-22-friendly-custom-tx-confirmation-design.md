# Human-readable custom-transaction & signature confirmation (design)

**Date:** 2026-07-22
**Repo:** `miden-wallet` (change is entirely here; `wallet-adapter` is untouched)
**Branch:** TBD — feature branch off `main` (the repo is currently on the unrelated
`fix-stress-conservation-measurement`; see *Rollout*)
**Status:** approved design, pre-implementation

## Problem

When a dApp requests a "custom" transaction, the confirm window shows only
boilerplate:

> **Payload** — *This dApp is requesting a custom transaction, please ensure you
> know the details of the transaction before proceeding.* — Recipient `0xfce0…edcb`

Reviewer feedback: *"We should better display what this custom tx is. Is this an
arbitrary signature request or is it a TxSummary? Right now, this arbitrary
signature request is extremely sketchy if this were with real assets."*

Two concrete defects:

1. **Indistinguishable kinds.** A custom transaction is a serialized SDK
   `TransactionRequest` that, when executed, yields a `TransactionSummary` — it is
   **not** an opaque arbitrary signature. But the UI presents it as if it were.
2. **The one detail shown is untrusted.** `Recipient` comes from
   `payload.recipientAddress` — a dApp-supplied string
   (`dapp.ts:1586 formatCustomTransactionPreview`), not derived from the request
   bytes. A malicious dApp can show a friendly recipient while the blob does
   something else.

Every *other* transaction kind already renders friendly details; only **custom**
falls through to boilerplate:

| Path | Confirm screen today | Source |
| --- | --- | --- |
| Send | faucet, amount, recipient, note type, recall | `dapp.ts:1559 formatSendTransactionPreview` |
| Consume | faucet, amount (+decimals), note type, note id | `dapp.ts:1575 formatConsumeTransactionPreview` |
| Sign → `TransactionSummary` | **full per-asset added/removed diff** + notes + storage | `ConfirmPage.tsx:359` `SigningInputsPayloadContent` |
| Sign → `word` / `Arbitrary` / `Blind` | one unstyled sentence, no warning | `ConfirmPage.tsx:123, 462, 466` |
| **Custom** | boilerplate + untrusted recipient | `dapp.ts:1586` |

## Goal / definition of done

1. A custom transaction's confirm screen shows a **human-readable asset-change
   summary** ("you send X, you receive Y", notes consumed/created, storage
   changed), derived by the wallet — never from a dApp-supplied description.
2. Full raw details are available under a collapsible **Advanced** disclosure
   (JSON).
3. The three genuinely-opaque signature requests (`word`, `Arbitrary`, `Blind`)
   are visually distinct — an explicit **"you are blind-signing"** warning banner —
   so the reviewer's "arbitrary vs TxSummary" ambiguity is resolved end-to-end.
4. When the wallet cannot decode a custom transaction, it says so honestly
   ("could not verify") rather than implying safety.
5. miden-wallet CI stays green: changelog, Test (lint + tsc + jest), **Coverage
   95%**, local-e2e + swap-e2e.

## Principle

**The wallet decodes the request itself and shows what it actually does. It never
trusts a dApp-supplied description.** Declared metadata (what the request *claims*)
is shown only when labelled as declared/unverified; the authoritative view is the
executed **vault delta**, which cannot be faked.

## Design decisions (confirmed)

- **Decode strategy: static-first, verify in background.** Render a fast
  client-side decode of the request's *declared* notes immediately (no
  side-effects), then run `executeForSummary` in the background and replace it with
  the ground-truth vault delta. Degrade to declared-only if simulation fails, then
  to today's boilerplate.
- **Pre-confirm simulation is allowed.** `executeForSummary` needs the payload's
  notes imported + the account synced, which today happen only *after* confirm.
  We allow a **local, non-submitting** import of `importNotes` + a state sync
  *before* the prompt so the simulation is accurate. Side-effects are local and
  reversible (orphan notes if the user cancels; a network read). No proving, no
  submission — a genuine dry run.
- **Scope: both screens.** Custom-tx decode **and** opaque-signature hardening.

## Why executeForSummary (not just static decode)

A `TransactionRequest`'s *declared* output notes (`expectedOutputOwnNotes()`) are
author-provided and **can misrepresent** what the actual transaction script does
(declare a harmless note, ship a script that drains the account). Only executing
the request produces a vault delta that reflects reality and cannot be faked. So
static decode is the fast *first paint* and honesty floor; the executed summary is
the *trusted* view. There is a working in-repo reference for `executeForSummary`:
the Guardian flow (`src/lib/miden/guardian/index.ts:418`).

## Classification — six request shapes → three buckets

| Bucket | Requests | Discriminator | Treatment |
| --- | --- | --- | --- |
| **Decoded transaction** | send, consume, **custom** | `payload.type === 'transaction' \| 'consume'` | asset-change summary |
| **Opaque signature** | `sign:word`, `sign:Arbitrary`, `sign:Blind` | `type:'sign'` + `kind`/`variantType` | ⚠ blind-sign warning banner + raw under Advanced |
| **Undecodable fallback** | custom tx we couldn't decode | `decodeStatus: 'undecodable'` | boilerplate framed as "could not verify" |

Note: send and custom are both `type:'transaction'` today, distinguished only by
`transactionMessages` content. We add an explicit discriminator (below) rather than
sniffing strings.

## Architecture

### Data flow (custom transaction)

```
dApp → adapter → window.midenWallet.requestTransaction(MidenTransaction{type:'custom'})
                                   │  payload: { address, recipientAddress,
                                   │            transactionRequest(b64), importNotes(b64[]), inputNoteIds }
                                   ▼
background generatePromisifyTransaction (dapp.ts ~973)   [async, already awaitable]
   1. build confirm payload WITHOUT executing:
        type:'transaction', kind:'custom', decodeStatus:'declared',
        requestBytes(b64), importNotes(b64[]), recipientAddress, address, origin…
   2. open confirm window
                                   ▼
ConfirmPage (React, direct static SDK via @miden-sdk/miden-sdk/lazy)
   A. INSTANT: TransactionRequest.deserialize(requestBytes)
        → expectedOutputOwnNotes() + expectedFutureNotes() + (Note.deserialize per importNotes)
        → <DeclaredTransactionView> ("declared by site — verifying…")
   B. fire intercom: simulateCustomTransaction(id)
                                   ▼
background handler (NEW: MidenMessageType.DAppSimulateTransactionRequest)   [withWasmClientLock]
   import importNotes locally → syncState(account) → executeForSummary(accountId, request)
      → TransactionSummary.serialize() → b64   (or { error })
                                   ▼
ConfirmPage
   C. TransactionSummary.deserialize(summaryBytes) → <TransactionSummaryView>  ("verified")
      on error → keep <DeclaredTransactionView> + "could not verify by simulation" caveat
```

Confirm itself is unchanged: it enqueues the tx exactly as today
(`requestCustomTransaction` → queued row → background processing). The summary is
preview-only; clicking Confirm before simulation returns is safe.

### 1. Payload type changes — `src/lib/miden/types.ts`

Extend `MidenDAppTransactionPayload` (line ~75) so the confirm UI receives the raw
material to decode + a state discriminator, and retire the dead `preview: any`:

```ts
export interface MidenDAppTransactionPayload {
  type: 'transaction';
  origin: string; networkRpc: string; appMeta: AppMeta;
  sourcePublicKey: string;
  transactionMessages: string[];        // kept for send + undecodable fallback
  // NEW:
  txKind: 'send' | 'custom';            // explicit discriminator (no string sniffing)
  requestBytes?: string;                // b64 serialized TransactionRequest (custom only)
  importNotes?: string[];               // b64 serialized notes carried by the request
  recipientAddress?: string;            // still shown, but labelled "declared by site"
  decodeStatus: 'declared' | 'undecodable';  // initial state; UI advances to verifying/verified
}
```

`preview: any` is removed from all payload types (it is never populated or read —
confirmed dead at `dapp.ts:434, 527, 644, 774, 861, 1048, 1188`).

### 2. Background — `src/lib/miden/back/dapp.ts`

- Replace `formatCustomTransactionPreview` boilerplate with a payload builder that
  attaches `requestBytes`, `importNotes`, `recipientAddress`, `txKind:'custom'`,
  `decodeStatus:'declared'`. No execution here — the window must open fast.
- Add a **simulate handler** wired through the existing intercom/store round-trip
  (mirror `DAppGetPayloadRequest` at `store/index.ts:380` / `dapp.ts:1447`): given
  the pending request `id`, under `withWasmClientLock` — import `importNotes`
  locally, `syncState`, `executeForSummary(accountId, TransactionRequest.deserialize(requestBytes))`,
  return `{ summaryBytes }` or `{ error }`. Client obtained via the existing
  singleton `getMidenClient()` (`sdk/miden-client.ts:230`); execute pattern mirrors
  Guardian (`guardian/index.ts:418`).
- Guard: simulate is best-effort and time-boxed; any throw → `{ error }` (UI shows
  the declared caveat, never blocks confirm).

### 3. Frontend — `src/app/ConfirmPage.tsx`

- **Refactor (improve code we're touching):** extract the `TransactionSummary`
  branch of `SigningInputsPayloadContent` (`:359-461`) into a shared
  `<TransactionSummaryView summary={TransactionSummary} />` — the account row,
  green/red per-asset `formatAmount`+`getTokenMetadata` rows, notes
  consumed/created, storage-changed. Sign flow and custom-tx flow both render it.
  No behaviour change to the Sign path.
- **New `<DeclaredTransactionView>`** — lightweight client-side decode of
  `TransactionRequest` declared output/future notes + `importNotes` assets, clearly
  labelled *"declared by site — not yet verified"*.
- **Custom-tx branch** (`case 'transaction'` when `txKind==='custom'`): state
  machine `declared → verifying → verified | undecodable`:
  - `declared`/`verifying`: `<DeclaredTransactionView>` + "verifying by simulation…"
  - `verified`: `<TransactionSummaryView>`
  - `undecodable`: today's boilerplate + "could not verify" caveat
  - drive the transition by calling `simulateCustomTransaction(id)` (SWR/effect).
- **Send branch** keeps its `transactionMessages` rendering (`txKind==='send'`).
- **Opaque-signature hardening** — the three leaves at `ConfirmPage.tsx:123`
  (`kind:'word'`), `:462` (`Arbitrary`), `:466` (`Blind`): add an
  `<Alert variant="warn">` banner ("Opaque signature request — the wallet cannot
  show what this authorizes. Only continue if you fully trust this site.") and move
  the raw word/felts into the **Advanced** disclosure (copyable). Reuses the
  existing unused `src/app/atoms/Alert.tsx`.
- **Advanced disclosure** — collapsible section (custom-tx: raw request + decoded
  notes as JSON; opaque-sign: raw value). One shared `<AdvancedDetails>` collapsible.

### UI — custom transaction (verified state)

```
Confirm Transaction
🌐 minizeke.b-cdn.net · Requests a transaction

This transaction will:
┌──────────────────────────────────────┐
│ Account               mtst1a…wr6w     │
│ ────────────────────────────────────  │
│ Asset changes                         │
│   − 10.00 miZK          (you send)    │  red
│   + 3.20 rETH           (you receive) │  green
│ ────────────────────────────────────  │
│ Notes consumed  1    created  1       │
│ Storage changed               No      │
└──────────────────────────────────────┘
▸ Advanced — raw request (JSON)

[ Cancel ]                   [ Confirm ]
```

Declared/verifying state shows the same card sourced from declared notes with a
"declared by site — verifying…" chip; undecodable falls back to boilerplate + a
"could not verify" line.

### UI — opaque signature (hardened)

```
Confirm Signature
🌐 somesite.xyz · Requests a signature

⚠  Opaque signature request
   This site asked you to sign a raw value. The wallet cannot
   show what it authorizes. Only continue if you fully trust
   this site.

▸ Advanced — raw value (0x1234…cdef, copyable)

[ Cancel ]                   [ Confirm ]
```

## Trust / security notes

- The authoritative asset view is `executeForSummary`'s vault delta. The declared
  view is always labelled as unverified so a fast first paint never reads as
  "safe."
- The dApp-supplied `recipientAddress` is still shown but demoted to a "declared by
  site" line — it is not treated as ground truth.
- Simulation is a dry run: import (local) + sync (read) + execute, **no prove, no
  submit**. It cannot move assets.

## Edge cases & failure modes

- **`expectedOutputOwnNotes()` empty** (dApp didn't declare notes): declared view is
  sparse; rely on simulation; if that also fails → undecodable.
- **Simulation throws** (invalid request, missing/unsyncable notes, VM error):
  `{ error }` → keep declared view + caveat; never block confirm.
- **User confirms before simulation returns:** allowed; confirm path is
  independent of the preview.
- **User cancels after pre-confirm import:** orphan notes may remain in the local
  store — benign; cleanup is out of scope for v1 (note as follow-up).
- **Slow simulation:** the "verifying…" state is non-blocking; a time-box on the
  handler prevents an indefinite spinner.
- **Non-fungible / storage-only deltas:** show notes/storage rows even when the
  fungible vault delta is empty (mirror existing `SigningInputsPayloadContent`).

## Files touched

| File | Change |
| --- | --- |
| `src/lib/miden/types.ts` | extend `MidenDAppTransactionPayload`; remove dead `preview` |
| `src/lib/miden/back/dapp.ts` | payload builder for custom (no exec); simulate handler |
| `src/lib/miden/store/index.ts` (+ message types) | `simulateCustomTransaction(id)` round-trip |
| `src/app/ConfirmPage.tsx` | extract `TransactionSummaryView`; `DeclaredTransactionView`; custom state machine; opaque-sign warnings; `AdvancedDetails` |
| `src/app/atoms/Alert.tsx` | reuse (no change expected) |
| `public/_locales/en/messages.json` (+ bundled locales) | new strings |
| tests | ConfirmPage render states; background simulate handler; decode helpers |

## Testing (95% coverage gate)

- **ConfirmPage** (jest + RTL): declared render; verifying→verified transition
  (mock `simulateCustomTransaction`); simulation-error → declared+caveat;
  undecodable → boilerplate; each opaque-sign leaf → warning banner + Advanced raw.
- **Background simulate handler:** success path returns summary bytes; import+sync
  invoked under lock; error path returns `{ error }` without throwing; no
  prove/submit called.
- **Decode helpers:** `TransactionRequest`/`TransactionSummary`/`Note` decode →
  view-model, incl. empty-notes and empty-vault cases.
- Verify local coverage clears 95% on lines/branches/functions/statements *before*
  pushing (per repo gate).

## Rollout

- Feature branch off `main` (not the current dirty `fix-stress-conservation-measurement`).
- `dapp.ts` has uncommitted unrelated changes on that branch — branch off `main` to
  avoid entangling this work; rebase/coordinate if the stress-conservation work
  lands first (both touch `dapp.ts`).
- Changelog entry required (repo gate).

## Out of scope

- Adapter (`wallet-adapter`) changes — none needed; it already forwards everything.
- Fiat pricing (the existing `~$` line is a placeholder; unchanged).
- Applying the executed-summary treatment to send/consume (they already show
  adequate structured detail).
- Orphan-note cleanup after cancel (follow-up).
- Non-fungible asset richness beyond what `SigningInputsPayloadContent` already does.
