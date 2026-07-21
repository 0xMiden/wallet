# Guardian Info Exposure to dApps + Out-of-Band Guardian Resolution — Design

- **Date:** 2026-07-20
- **Status:** Draft (pending review)
- **Repos touched:** `0xMiden/wallet` (miden-wallet) and `0xMiden/wallet-adapter`
- **Web SDK change required:** None.

## 1. Context & Problem

A dApp developer asked whether there is a supported way to read the connected
account's **guardian endpoint** (and provider: OpenZeppelin / Gateway /
LambdaClass). Today there is not: the wallet adapter's `useWallet()` /
`useMidenFiWallet()` expose only `address` and `publicKey`, and the wallet's
dApp bridge (`src/lib/adapter/`) carries no guardian data.

Exposing the endpoint is only useful if the wallet's own copy is **correct**. A
guardian can be switched **out of band** — e.g. the user switches guardian on
their phone, while the browser extension still holds the old endpoint. Today the
extension has no mechanism to notice or recover from this. So the two stories are
intertwined and are designed together:

1. **Keep each device's guardian metadata correct** after an out-of-band switch
   (detect + resolve).
2. **Expose the (now-trustworthy) guardian info** to dApps via a live request
   method, including a sync-status the dApp can act on.

## 2. Grounding Findings (why the design is shaped this way)

Verified against `@openzeppelin/miden-multisig-client`,
`@openzeppelin/guardian-client`, `miden-base`, `miden-client`, `miden-node`, and
the SDK type surface (exhaustive adversarial sweep, ~99% confidence):

- **The guardian endpoint URL is NOT derivable from any account-bound data.**
  On-chain the guardian occupies three storage slots — `selector`, `public_key`
  (a commitment), `scheme_id` — no string/URL
  (`@openzeppelin/miden-multisig-client/src/account/storage.ts:73-91`,
  `masm/auth/guardian.masm`). The base account model has no URI concept. Node RPC
  has zero guardian concept. The endpoint is only ever a **client input**, stored
  wallet-local as `WalletAccount.guardianEndpoint` (falling back to the legacy
  global `guardian_url_setting`, then the network default; see
  `resolveGuardianEndpoint`, `src/lib/miden/guardian/account.ts:20-23`).
- **The on-chain guardian commitment is the operator's operator-wide key.** At
  create/switch the guardian commitment is set to the operator's
  `GET /pubkey` value (`src/lib/miden/guardian/account.ts:148-155`;
  `verifyGuardianEndpointCommitment`, `.../multisig.ts:189-204`). `GET /pubkey`
  is **unauthenticated, operator-wide, takes no account id**
  (`@openzeppelin/guardian-client/src/http.ts:82-90`).
- **Therefore, for the three built-in operators, the endpoint is resolvable by a
  zero-leak local match:** read the account's on-chain guardian commitment `C`,
  fetch each built-in operator's public `GET /pubkey`, compare locally. No account
  id, signer key, or authenticated request is sent to any operator — an operator
  cannot even tell you have an account with them. **This is not an invasive
  probe; the earlier "fan-out privacy trade-off" does not apply.**
- **Custom (user-typed) URLs are provably unrecoverable** except from wallet-local
  storage or a user prompt — you cannot query an endpoint whose address you don't
  have, and nothing on-chain/registry contains it.

## 3. Goals / Non-Goals

**Goals**
- Detect an out-of-band guardian switch on each device and re-establish the
  correct endpoint automatically for built-in operators, or with a single
  user prompt for custom operators.
- Expose `{ isGuardianAccount, guardianEndpoint, guardianProvider,
  guardianSyncStatus }` for the connected account to dApps via a live request
  method on both React surfaces.

**Non-Goals (explicit)**
- Cross-device metadata sync (a future robustness upgrade; not required because
  built-in operators auto-resolve and custom operators prompt).
- On-chain operator-id/URI commitment (a future protocol change; see §10).
- Any change to the guardian security model or to `@miden-sdk` / web-sdk.
- Mainnet guardian support (no mainnet guardian operator exists;
  `DEFAULT_GUARDIAN_ENDPOINT` resolves to `''` there).

## 4. Locked Design Decisions

| Decision | Choice |
|---|---|
| React surfaces | **Both** `useWallet()` (legacy) and `useMidenFiWallet()` (modern); shared underlying adapter method |
| Access gating | **Free once connected** (like `address`/`publicKey`); connection is the consent |
| Delivery | **Live request method** (`requestGuardianInfo`), not a connect-time echo |
| Scope | **Connected account only** (the adapter is single-account) |
| Non-guardian accounts | Return `{ isGuardianAccount: false, guardianEndpoint: null, guardianProvider: null, guardianSyncStatus: null }` — never throw |
| Provider identity | Reverse-map the endpoint against `GUARDIAN_OPTIONS` → id, `'custom'` fallback (the id/type is not persisted; only the URL is) |
| Sync status | **Included** (detection now exists because the stories are folded) |
| Resolution privacy | Zero-leak local match against public operator keys; no invasive probe |

## 5. Architecture

Two parts. Part A (wallet) is the substantive work; Part B (adapter) is a thin
exposure layer on top of it.

### Part A — Wallet-side detection & resolution

**Data model additions** (`src/lib/shared/types.ts`, `WalletAccount`):
- `guardianOperatorCommitment?: string` — the operator-wide guardian key
  commitment the current `guardianEndpoint` corresponds to. This is the **local
  baseline** for out-of-band detection. Set wherever `guardianEndpoint` is set
  (create, switch, resolve). Absent on non-guardian accounts.
- `guardianSyncStatus?: 'in-sync' | 'resolving' | 'needs-user-input'` — the
  per-account resolution state. Defaults to `in-sync`. Persisted so a reload
  doesn't lose a pending `needs-user-input`.

**Detection helper** (`src/lib/miden/guardian/account.ts`): add
`readOnchainGuardianCommitment(account): string`, mirroring
`getSignerDetailsFromAccount` but reading the **guardian** slot
(`GUARDIAN_SLOT_NAMES.PUBLIC_KEY` map) rather than the multisig signer slots.
(Confirm exact slot names against the vendored OZ package at implementation
time.)

**Operator-key cache** (new module, e.g. `src/lib/miden/guardian/operator-map.ts`):
a `{ operatorId → { url, commitment } }` map built by fetching each
`GUARDIAN_OPTIONS` entry's `GET /pubkey` for the active network. In-memory with a
short TTL; **cache-bust-on-miss** (see resolution step d).

**Detection & resolution loop** — hook into the existing frontend guardian sync,
which already runs every 3 s (`syncGuardianAccounts()`,
`src/lib/miden/front/guardian-sync.ts`, driven by `useSyncTrigger`,
`SYNC_INTERVAL_MS = 3_000`). Per guardian account with a hot key:

1. `C_chain = readOnchainGuardianCommitment(account)` (local; account already
   synced).
2. If `C_chain === account.guardianOperatorCommitment` → `in-sync`. **Done — the
   ~99% path, no network, no UI.**
3. Else out-of-band switch detected → set `resolving`:
   - a. Ensure the operator-key map is populated (fetch `GET /pubkey` per built-in
     operator; public, no account data sent).
   - b. Find the operator whose commitment `=== C_chain`.
   - c. **Match** → update `guardianEndpoint` + `guardianOperatorCommitment`,
     `clearGuardianServiceFor(accountId)` (so the cached MultisigService rebinds),
     set `in-sync`. **Silent, no UI.**
   - d. **No match** → refresh the operator-key map once (cache-bust, to cover an
     operator that rotated its key) and retry (b–c). Still no match → set
     `needs-user-input`.
4. `needs-user-input`: surface a banner/modal — *"Your guardian was changed and we
   couldn't identify the new operator. Enter its URL."* User submits a URL →
   fetch its `GET /pubkey` → **verify `commitment === C_chain`** → match: persist
   `guardianEndpoint` + `guardianOperatorCommitment`, `in-sync`; mismatch: reject
   (*"That operator doesn't match your account's on-chain guardian."*).

**Gating:** while `guardianSyncStatus !== 'in-sync'`, the endpoint is untrustworthy
and guardian co-signing cannot work; gate guardian-dependent operations and show
the account as "action needed."

### Part B — dApp exposure

**Intercom contract** (`src/lib/adapter/types.ts`): add `GuardianInfoRequest` /
`GuardianInfoResponse` to `MidenDAppMessageType` and the request/response unions.

**Backend handler** (`src/lib/miden/back/dapp.ts`): `requestGuardianInfo(origin)`
reads `currentAccount` (Effector store, as used elsewhere in `dapp.ts`) and
returns a `GuardianInfo`:
- `isGuardianAccount` = `account.type === WalletType.Guardian`.
- `guardianEndpoint` = `resolveGuardianEndpoint(account)` (null for non-guardian /
  mainnet / unresolved).
- `guardianProvider` = reverse-map endpoint → `GUARDIAN_OPTIONS` id; `'custom'`
  when no match; `null` for non-guardian.
- `guardianSyncStatus` = collapse `account.guardianSyncStatus` to the dApp-facing
  `'in-sync' | 'out-of-sync'` (`resolving` and `needs-user-input` → `out-of-sync`);
  `null` for non-guardian.

**Dispatch** (`src/lib/miden/back/actions.ts`): one new case in the `processDApp`
switch. **Verify** whether dApp messages reach mobile via the generic
`PageRequest → processDApp` passthrough (`src/lib/intercom/mobile-adapter.ts`) or
require an explicit case there; per `CLAUDE.md`, adding an intercom message type
means checking `mobile-adapter.ts`.

**Adapter plumbing** (`0xMiden/wallet-adapter`):
- `packages/core/base/signer.ts`: add `requestGuardianInfo` to
  `MessageSignerWalletAdapterProps`, and a `GuardianInfo` type in base.
- `packages/wallets/**`: implement `requestGuardianInfo()` on the concrete adapter
  (calls the injected provider method).
- `packages/core/react/useWallet.ts` (`WalletContextState`) and
  `MidenFiSignerProvider.tsx` (`MidenFiWalletContextState`): surface
  `requestGuardianInfo` on both hooks.
- The wallet's injected provider (`src/lib/adapter/midenWindowObject.ts`,
  `client.ts`): add the provider method that sends the intercom request.

**Return shape (dApp-facing):**
```ts
type GuardianProvider = 'open-zeppelin' | 'gateway' | 'lambda-class' | 'custom';
type GuardianSyncStatus = 'in-sync' | 'out-of-sync';

interface GuardianInfo {
  isGuardianAccount: boolean;
  guardianEndpoint: string | null;     // null: non-guardian / mainnet / unresolved
  guardianProvider: GuardianProvider | null;
  guardianSyncStatus: GuardianSyncStatus | null; // null: non-guardian
}
```

## 6. Data Flow (end to end)

**Steady state:** every 3 s, per guardian account, `C_chain === stored commitment`
→ nothing happens.

**Out-of-band switch to a built-in operator:** device B switches on-chain →
device A's next tick sees `C_chain` changed → fetches operator `/pubkey`s →
matches → silently updates endpoint → `in-sync`. The user never sees anything.

**Out-of-band switch to a custom operator:** same detection → no operator match →
`needs-user-input` → banner → user enters URL → verified against `C_chain` →
persisted.

**dApp query:** dApp calls `requestGuardianInfo()` → intercom →
`requestGuardianInfo` handler → reads current account → returns `GuardianInfo`. A
dApp reading `guardianSyncStatus: 'out-of-sync'` knows the endpoint is being
reconciled and should hold off on guardian-dependent flows.

## 7. Error Handling & Edge Cases

- **Operator rotates its operator-wide key:** hosted accounts' on-chain commitment
  changes only if re-registered; a stale cache is handled by the cache-bust-on-miss
  in step 3d before falling through to `needs-user-input`.
- **Mainnet / non-guardian / no endpoint:** `guardianEndpoint` null, status null,
  `isGuardianAccount` false as applicable; never throw.
- **Offline / operator unreachable during resolution:** stay in `resolving`,
  retry on later ticks; never corrupt stored metadata; best-effort like the
  existing guardian sync.
- **Custom URL mismatch:** reject and keep `needs-user-input`; the on-chain
  commitment is the source of truth.
- **Rotation-pending / hot-key-less accounts:** already skipped by
  `syncGuardianAccounts`; detection inherits that guard.

## 8. Security & Privacy

- **Resolution leaks nothing account-specific** for built-in operators: only
  public, unauthenticated `GET /pubkey` fetches + local comparison. No account id,
  signer key, or auth token leaves the device.
- **Custom URL entry is verified** against the on-chain commitment before persist,
  so a wrong/malicious URL cannot silently corrupt metadata.
- **The endpoint remains an unverifiable-by-dApp assertion** (it's off-chain
  wallet-local metadata); `guardianSyncStatus` lets a dApp distrust a
  possibly-stale value.
- **Access is gated only by connection.** No new sensitive-data surface beyond
  "which of three public operators (or a custom URL) the user chose."

## 9. Testing Strategy

- **Wallet unit (Jest):** detection (match → in-sync; mismatch → resolving);
  operator-map match → silent update; no-match → needs-user-input; custom-URL
  verify (match persists, mismatch rejects); provider reverse-map incl. `custom`;
  `requestGuardianInfo` handler for guardian / non-guardian / unresolved;
  gating while not in-sync.
- **Wallet E2E (Playwright guardian harness):** simulate an out-of-band switch
  (switch on one client, assert the other detects + auto-resolves for a built-in
  operator; assert the prompt path for a custom URL). Extends the existing
  mobile-guardian-e2e pattern.
- **dApp E2E:** a connected dApp calls `requestGuardianInfo()` and receives the
  correct shape/status (reuse the dApp/DEX harness).
- **Adapter (vitest):** `requestGuardianInfo` plumbing on both hooks and the base
  props; default-context error message parity.

## 10. Rollout / Sequencing

Cross-repo, no web-sdk involvement:
1. **wallet-adapter PR:** add `GuardianInfo` type + `requestGuardianInfo` to base
   props, concrete adapter, and both React surfaces; publish
   `@miden-sdk/miden-wallet-adapter-*`.
2. **wallet PR:** implement Part A (detection/resolution + data-model fields) and
   the Part B backend handler + provider method; bump the adapter dep.

Part A can land independently of the dApp exposure (it stands alone as a
correctness fix); Part B depends on the adapter types being available.

## 11. Open Questions / Future

- Offer a "pick from the known operator list" affordance in the
  `needs-user-input` UI (helps if an operator rotated its key), or keep it
  URL-entry only?
- Persist `guardianSyncStatus` vs recompute on load — proposed: persist.
- Notify dApps of status changes via an event vs. poll-only — future; poll via the
  request method is sufficient for v1.
- **Future robustness:** cross-device metadata sync and/or an on-chain
  operator-id/URI commitment (a 4th guardian slot holding `hash(operatorURI)` or a
  registered operator-id) would make even custom URLs auto-resolvable and survive
  operator key rotation — a protocol/component change, out of scope here.
