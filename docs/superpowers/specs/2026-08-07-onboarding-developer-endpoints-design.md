# Onboarding Developer Endpoint Configuration — Design

- **Date:** 2026-08-07
- **Branch:** `wiktor/onboarding-developer-endpoints` (off `origin/main` @ `c87eb427a`, wallet 1.15.19)
- **Status:** Approved design, pre-implementation

## 1. Summary

Add a hidden **Developer Settings** screen, reachable during onboarding by tapping the
Bread logo on the Welcome screen **7 times** (Android "enable developer options" style).
The screen lets an advanced user view and override **every** network endpoint the wallet
uses, seeded by a network preset dropdown. Because this happens **during onboarding —
before any wallet, SDK client, or local DB exists** — there is no "graceful reset of a live
wallet" problem: the chosen endpoints simply become the endpoints the fresh wallet is built
on.

After onboarding, the config is **read-only** in Settings (visible only when an override is
active), with a single **"Reset to defaults & re-onboard"** action. Changing endpoints later
therefore means a clean wallet reset, never a live re-point.

Health of each URL is surfaced with a **non-blocking** per-field reachability note
(pending / reachable / no-response). It never blocks saving.

### Non-goals

- Live re-pointing of an existing wallet to a new network without a reset.
- In-flight-transaction migration across a network change (impossible/undesirable; reset instead).
- Editing endpoints after onboarding (v1 is read-only + reset).
- A true protocol-level health check for gRPC endpoints (see §5 caveat).

## 2. Background — how endpoints work today

All endpoints live in `src/lib/miden-chain/constants.ts` and are derived from a single
**build-time** constant:

```
DEFAULT_NETWORK = resolveNetworkName(process.env.MIDEN_NETWORK)   // default 'testnet'
```

Per-network maps keyed by network name provide each endpoint, consumed as synchronous
`MAP.get(DEFAULT_NETWORK)` reads:

| Endpoint | Constant / getter (constants.ts) |
| --- | --- |
| RPC node | `MIDEN_NETWORK_ENDPOINTS`, `getRpcEndpoint()` |
| Tx prover | `MIDEN_PROVING_ENDPOINTS` |
| Note-transport (NTL) | `MIDEN_NOTE_TRANSPORT_LAYER_ENDPOINTS`, `getNoteTransportUrl()` (+ `MIDEN_NOTE_TRANSPORT_URL` env override) |
| Faucet website | `MIDEN_FAUCET_ENDPOINTS` |
| Faucet API | `MIDEN_FAUCET_API_ENDPOINTS` (`faucet-api.ts:getFaucetApiUrl`) |
| Explorer | `MIDEN_EXPLORER_ENDPOINTS`, `getExplorerTxUrl()` |
| Guardian | `GUARDIAN_OPTIONS` / `MIDEN_GUARDIAN_ENDPOINTS` / `getDefaultGuardianEndpoint()` |
| Network id (SDK) | `getNetworkId()` (switch on `DEFAULT_NETWORK`) |

These values are read in **both** contexts:

- **Frontend** (onboarding, Explore, guardian pickers).
- **Service-worker backend** — most importantly `src/lib/miden/sdk/miden-client-interface.ts`
  builds the SDK client with `rpcUrl` / `proverUrl` / `noteTransportUrl` (~L193–214, 349, 499).
  On mobile there is no SW, so the client is built on the main thread; the storage adapter
  abstracts the context difference.

There is a **partial legacy** network-selection mechanism (`NETWORK_STORAGE_ID = 'network_id'`,
`custom_networks_snapshot`, `getCurrentMidenNetwork()`, `useNetwork()`), but almost all
consumers ignore it and read `DEFAULT_NETWORK` directly. This design does **not** build on
that mechanism (see rejected Approach B).

Storage is async and cross-context via `getStorageProvider()`
(`src/lib/platform/storage-adapter.ts`): extension → `browser.storage.local`, desktop →
`localStorage`, mobile → Capacitor Preferences.

### E2E network override (must not break)

E2E overrides the network **purely at build time**: the harness scripts bake
`MIDEN_NETWORK=${E2E_NETWORK}` (+ `MIDEN_E2E_TEST=true`) into the bundle
(`package.json` `test:e2e:*:build`), which sets `DEFAULT_NETWORK`. Existing E2E specs never
open the dev screen and never write an `endpoint_overrides` key. See §3 invariant + safeguard.

## 3. Architecture (Approach A: sync cache + async bootstrap)

### Chosen approach

Introduce an **effective-endpoints resolver** with a synchronous in-memory cache seeded from
the build defaults, plus an async bootstrap that overlays a persisted override. This is the
only approach that (a) serves the synchronous SW-side SDK client, (b) keeps the ~10 existing
synchronous call sites working, and (c) works on extension/mobile/desktop.

**Rejected alternatives:**

- **B — reuse `network_id` / `custom_networks_snapshot`:** most consumers don't read that
  path, so they'd need repointing anyway; it's async-only (breaks sync consumers) and would
  need `WalletNetwork` extended to carry all endpoints. Strictly more work, messier.
- **C — persist + hard reload, read overrides at module load from `localStorage`:** the SW
  backend (the primary consumer) has no `localStorage`; breaks the main path. (A reload *is*
  used in the Settings reset flow, where it's appropriate.)

### New module: `src/lib/miden-chain/effective-endpoints.ts`

```ts
export interface EndpointOverride {
  rpcUrl: string;
  proverUrl: string;
  noteTransportUrl: string;
  faucetUrl: string;        // faucet website
  faucetApiUrl: string;     // faucet REST API
  explorerUrl: string;
  guardianUrl: string;      // '' = no custom guardian
  networkName: MIDEN_NETWORK_NAME;  // the "network id": drives endpoint-default seeding,
                                    // the SDK NetworkId (derived via getNetworkId), and isDevnet theming
  presetName: string;       // 'testnet'|'devnet'|'localnet'|'custom' — UI dropdown seed only
}
```

**`networkName` is the single "network-id" the user edits.** The SDK `NetworkId` is *derived*
from it by the existing `getNetworkId()` switch (note: `localnet → testnet`), so there is no
separate SDK-network-id field. `presetName` only remembers which preset the UI dropdown should
show; `networkName` is the functional value.

- Storage key: `endpoint_overrides` (single JSON object). **Presence = override active**; no
  separate dev-mode boolean.
- Internal `cache: EffectiveEndpoints`, initialized from **build defaults** computed from the
  existing constants (so getters are always safe even before load).
- `getBuildDefaults()` — pure, from `constants.ts`. Preserves existing precedence, incl. the
  `MIDEN_NOTE_TRANSPORT_URL` env override for NTL.
- `loadEndpointOverrides(): Promise<void>` — reads the key once, overlays it onto the cache.
  Idempotent. **No-op when `process.env.MIDEN_E2E_TEST === 'true'`** (safeguard).
- `applyEndpointOverride(o: EndpointOverride): Promise<void>` — writes the key **and** updates
  the cache synchronously.
- `clearEndpointOverride(): Promise<void>` — removes the key, resets cache to build defaults.
- `isEndpointOverrideActive(): Promise<boolean>` — key presence (for the Settings gate).
- Sync getters: `getEffectiveRpcUrl()`, `getEffectiveProverUrl()`,
  `getEffectiveNoteTransportUrl()`, `getEffectiveFaucetUrl()`, `getEffectiveFaucetApiUrl()`,
  `getEffectiveExplorerUrl()`, `getEffectiveGuardianUrl()`, `getEffectiveNetworkName()`.

**Precedence for each endpoint:** dev-screen override (if key present) > build-time env
override (e.g. `MIDEN_NOTE_TRANSPORT_URL`) > per-network default map.

### Bootstrap wiring (load-before-first-consumer)

- **Backend:** `await loadEndpointOverrides()` at the top of `start()` in
  `src/lib/miden/back/main.ts`, before `primeNativeAssetId` / any client creation.
- **Frontend:** the same call early in the app root bootstrap, before any route that creates a
  client or reads endpoints (this is the path that matters on mobile).

### Consumer repointing (`DEFAULT_NETWORK` map reads → resolver getters)

- `constants.ts`: `getRpcEndpoint`, `getNetworkId`, `getNoteTransportUrl`,
  `getDefaultGuardianEndpoint`.
- `sdk/miden-client-interface.ts`: rpcUrl / proverUrl / noteTransportUrl / midenRpcEndpoint
  (~L193–214, 349, 499).
- `miden/transaction/index.ts` (L445, 713), `miden/back/simulate-custom-tx.ts` (L86),
  `miden-chain/faucet-api.ts`, `miden-chain/faucet.ts`, `miden-chain/native-asset.ts`
  (incl. its `native_asset_*` cache keys → keyed on effective network name so they don't
  collide across networks), `epoch/chain.ts`, `app/pages/Explore.tsx` (L171).
- **Module-eval'd constants that must become getters** (else they capture stale build values
  before the overlay loads): `DEFAULT_GUARDIAN_ENDPOINT`, `IS_GUARDIAN_SUPPORTED`, and the
  `isDevnet` flags in `utils/brand-colors.ts`, `app/icons/v2/index.tsx`, `app/pages/Settings.tsx`
  → resolved via `getEffectiveNetworkName()` at call time.
- **Guardian:** when `guardianUrl` is set, `getGuardianOptionsForNetwork()` appends a
  "Custom" provider with that endpoint; `ChooseGuardian` shows it and `ImportRecoveryMethod`
  prefill uses it. `getDefaultGuardianEndpoint()` returns the custom URL when set.

### The two guarantees for E2E / build-token compatibility

1. **Pure-refactor invariant:** with no `endpoint_overrides` key, every getter returns exactly
   what today's code returns from the build token. Repointing is behavior-preserving in the
   no-override case → all existing E2E specs unchanged.
2. **Safeguard:** `loadEndpointOverrides()` is a no-op under `MIDEN_E2E_TEST=true`, so a stray
   persisted key can never repoint an E2E build; the build token stays authoritative.

## 4. Developer screen UI + 7-tap unlock

### Unlock gesture (`src/screens/onboarding/common/Welcome.tsx`)

- Wrap `<BreadLogo>` in a tap counter. **7 taps**, Android-style: the counter resets if the
  gap between taps exceeds ~2s.
- After ~4 taps show a subtle countdown hint ("3 taps away from developer settings") +
  `hapticLight()`; on the 7th, `hapticMedium()` and navigate to the dev screen.
- **Text-selection fix:** the logo tap target gets `user-select: none` /
  `-webkit-user-select: none` / `-webkit-touch-callout: none`, and the tap handler calls
  `e.preventDefault()` + `window.getSelection()?.removeAllRanges()` so rapid tapping never
  selects the "Welcome" heading.
- The existing `__TEST_SKIP_ONBOARDING` bypass and E2E hooks in `Welcome.tsx` are preserved.

### Screen

- A woozie route `/developer-settings`, one component reused in two modes: **edit** (from
  onboarding) and **read-only** (from Settings, via `?readonly=1`).
- Styled to match the app: `ScreenHeader` (back + title "Developer Settings"), `bg-app-bg`,
  existing `Button` / input components, all copy via `t()`, haptics on tappables.
- **Warning banner:** "Advanced — most people should never need to change this. Wrong values
  will break your wallet."
- **Network preset dropdown** (Testnet / Devnet / Localnet / Custom): selecting a known
  network prefills all URL fields **and** `networkName` from its constant map. Editing any
  field flips the dropdown to "Custom."
- **Grouped fields** (URLs monospace + `select-text` so they're copyable):
  - *Connectivity:* RPC, Prover, NTL.
  - *Services:* Faucet website, Faucet API, Explorer, Guardian.
  - *Network:* `networkName` dropdown (Mainnet / Testnet / Devnet / Localnet) — the editable
    "network id"; the SDK `NetworkId` is derived from it (`localnet → testnet`). In a known
    preset this mirrors the preset; in "Custom" it is independently selectable.
- **Footer:** edit mode → "Reset to defaults" + "Save & continue"; read-only mode →
  "Reset to defaults & re-onboard".
- **Save** (edit mode): `applyEndpointOverride(...)` then continue into the normal onboarding
  flow. Non-blocking — health status does not gate save.

## 5. Health checks (non-blocking, per-field)

- Debounced (~500ms after typing stops) probe below each URL field. States:
  **idle → pending → success → error**. Re-runs on edit and on preset change. Runs in the
  page context. Purely informational; never blocks Save.
- **Faucet API** — real check: `GET {faucetApiUrl}/get_metadata`, expect 2xx + JSON ⇒
  "Healthy" (mirrors `Explore.tsx:171`).
- **RPC / Prover / NTL / Guardian / Faucet website / Explorer** —
  `fetch(url, { mode: 'no-cors', signal: AbortSignal.timeout(4000) })`. Promise resolves
  (opaque response) ⇒ "Host reachable"; throws / times out ⇒ "No response."
- **Caveat (surfaced in UI wording):** for gRPC endpoints (RPC/prover) and cross-origin hosts
  we cannot do a true protocol health check — "reachable" means the host answered / TLS
  handshook, not that it's the correct service. Only the Faucet API is validated as the right
  service.
- **network-id** — no check.

## 6. Settings: read-only + reset

- A "Developer / Network" entry appears in `src/app/pages/Settings.tsx` **only when an
  override is active** (`isEndpointOverrideActive()`), so normal users never see it.
- It opens the dev screen in **read-only** mode: inputs disabled at current effective values;
  health notes stay live (useful for "is my custom RPC down?").
- Single action: **"Reset to defaults & re-onboard"** → confirm dialog → `clearEndpointOverride()`
  → reuse the existing full wallet-reset routine (the one behind Forgot Password /
  `src/screens/onboarding/ResetRequired.tsx` that wipes IndexedDB / PSM / vault) → app returns
  to Welcome on build-default endpoints.
- No editing after onboarding in v1. Changing endpoints later = reset & re-onboard, which is
  why no live re-point / in-flight-tx handling is required.

## 7. Testing

- **Unit:** resolver (build defaults, override overlay, clear, `MIDEN_E2E_TEST` no-op,
  NTL env-override precedence); preset prefill logic; 7-tap counter (success + >2s timeout
  reset); health-check state machine (mock fetch: 2xx JSON, opaque, timeout, network error);
  storage round-trip.
- **Component (RTL):** Welcome 7-tap opens the screen and does not select heading text;
  edit → save persists the override and continues onboarding; preset switch prefills all
  fields; read-only mode disables inputs; Settings entry visible only when an override is
  active; reset triggers the wallet-reset routine.
- **i18n:** every new string via `t()` / `<T id />`; new keys in
  `public/_locales/en/en.json` (CI `lint:i18n` gate).
- **Coverage:** read the jest threshold (`jest.config.ts`) and ensure new code clears it
  before opening the PR. No `any` / `as` per repo style.
- **E2E:** rely on the pure-refactor invariant — the existing localnet/testnet/devnet suites
  must stay green unchanged (no override key ⇒ identical endpoints). No new dev-screen E2E in
  v1 (would conflict with the `MIDEN_E2E_TEST` safeguard); the override path is covered by
  unit + component tests.

## 8. Key files touched (summary)

- **New:** `src/lib/miden-chain/effective-endpoints.ts`; the dev-settings screen component
  (+ its route registration and i18n keys).
- **Edited:** `src/lib/miden-chain/constants.ts` (getter-ize the derived consts, delegate to
  resolver), `src/lib/miden/back/main.ts` (bootstrap load), frontend root bootstrap,
  `src/lib/miden/sdk/miden-client-interface.ts`, `src/lib/miden/transaction/index.ts`,
  `src/lib/miden/back/simulate-custom-tx.ts`, `src/lib/miden-chain/{faucet-api,faucet,native-asset}.ts`,
  `src/lib/epoch/chain.ts`, `src/app/pages/Explore.tsx`, `src/utils/brand-colors.ts`,
  `src/app/icons/v2/index.tsx`, `src/app/pages/Settings.tsx`,
  `src/screens/onboarding/common/Welcome.tsx`,
  `src/screens/onboarding/{create-wallet-flow,import-wallet-flow}` (guardian custom option),
  `CHANGELOG.md` (one-liner).
