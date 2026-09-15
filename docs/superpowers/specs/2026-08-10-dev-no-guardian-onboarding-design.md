# Dev-gated "No guardian" onboarding option — Design

**Goal:** Add a developer-settings checkbox that, when enabled, exposes a "No guardian" card in the onboarding "Choose your guardian" screen. Selecting it creates a **private, single-key (`WalletType.OffChain`) account** with no guardian co-signer.

**Status:** Approved design (2026-08-10). Base branch: `next`. Default-off; zero change to normal onboarding when the flag is off.

## Context / findings (why this is UI-only)

The wallet already fully supports non-guardian accounts; only the onboarding UI path is missing.

- `WalletType` (`src/screens/onboarding/types.ts:20-24`): `OffChain` (private), `Guardian`, `OnChain` (public).
- `Vault.spawn` (`src/lib/miden/back/vault.ts:439-475`) branches: `Guardian` → `createGuardianMidenWallet`; **else → `createMidenWallet(walletType, walletSeed, NEW_ACCOUNT_AUTH_SCHEME)`** which builds a single-key account via the SDK `accounts.create({ storage: 'private' | 'public' })` (`src/lib/miden/sdk/miden-client-interface.ts:249-266`). No multisig, no guardian keys, no `registerOnGuardian`.
- Guardian-specific UI/logic is already gated on `account.type === WalletType.Guardian` (e.g. `Settings.tsx`, `KeysSettings.tsx`, guardian sync / hot-key rotation), so a non-guardian account cleanly skips all of it.
- Non-guardian creation is already exercised by the E2E bypass (`Welcome.tsx:150-194`, defaults to `OffChain`) and the Import flow's OnChain option (`ImportRecoveryMethod.tsx` → `Welcome.tsx:387-393`).
- The gap: the onboarding create flow always routes through `ChooseGuardian` and the `choose-guardian-submit` handler **unconditionally** does `setWalletType(WalletType.Guardian)` (`src/app/pages/Welcome.tsx:324-340`).

Dev-settings override mechanism (PR #512):
- `EndpointOverride` type + all read/write live in `src/lib/miden-chain/effective-endpoints.ts`. Persisted under key `endpoint_overrides` via the platform storage adapter (JSON — a boolean rides along with no adapter change). Read synchronously from a module-level `overrideCache` via `getEffective*` getters; hydrated once at startup (`front/provider.tsx`, `back/main.ts`).
- Editor: `src/screens/developer-settings/DeveloperSettings.tsx` (form is one `EndpointOverride` in `useState`; fields are `Input`s + `TabPicker`s; `setField` marks preset `custom`). Read-only Settings variant via the `readOnly` prop.

## Components & changes

### 1. Dev flag (`allowNoGuardian`)

`src/lib/miden-chain/effective-endpoints.ts`:
- Add `allowNoGuardian: boolean;` to the `EndpointOverride` interface.
- `buildDefaultOverrideFor(...)`: set `allowNoGuardian: false`.
- `isEndpointOverride(...)`: **do NOT** add `allowNoGuardian` to the strict guard. The guard already deep-checks only `rpcUrl`/`networkName`, so an override persisted before this field existed still passes; requiring the new boolean would reject legacy objects and wipe a user's saved endpoints. Missing/invalid values are handled by the getter's `?? false` fallback.
- Add getter:
  ```ts
  export function getEffectiveAllowNoGuardian(): boolean {
    return overrideCache?.allowNoGuardian ?? false;
  }
  ```

`src/screens/developer-settings/DeveloperSettings.tsx`:
- Render a `Checkbox` (`src/components/Checkbox.tsx`) bound to `form.allowNoGuardian`, placed after the Network ID picker, above the footer. Label via new i18n key `devAllowNoGuardian` ("Allow 'No guardian' option in onboarding"), with a short helper line if the design has room.
- `onChange` mirrors `setField`: `setForm(prev => ({ ...prev, allowNoGuardian: v, presetName: CUSTOM_PRESET }))`.
- Disabled when `readOnly` (mirrors the inputs). Read-only view still reflects the saved value.
- `initial`/`getActiveOverride()` already returns the full object, so `form.allowNoGuardian` is defined via `buildDefaultOverrideFor`.

i18n: add `devAllowNoGuardian` (+ optional helper key) to `public/_locales/en/en.json`.

### 2. "No guardian" card (`src/screens/onboarding/common/ChooseGuardian.tsx`)

- Add prop `showNoGuardianOption?: boolean` (default `false`).
- When true, render one extra selectable card **below** the guardian cards, styled like the others, with a sentinel id `NO_GUARDIAN_ID = 'no-guardian'`: title `t('noGuardianOptionTitle')` ("No guardian"), subtitle `t('noGuardianOptionSubtitle')` ("Advanced — recover with your seed phrase only. No guardian co-signer."). It participates in the same `selectedId` selection state and `handleSelect`.
- `handleContinue`: check the sentinel **before** the `options.find(...) ?? options[0]` fallback:
  ```ts
  if (selectedId === NO_GUARDIAN_ID) {
    onSubmit?.({ guardianId: NO_GUARDIAN_ID, guardianEndpoint: '' });
    return;
  }
  ```
- Do **not** auto-select the no-guardian card by default; the existing default (first guardian / current) is unchanged, so with the flag off behavior is byte-identical.
- New i18n keys: `noGuardianOptionTitle`, `noGuardianOptionSubtitle`.

### 3. Gating (onboarding-only)

`src/screens/onboarding/navigator.tsx` (`OnboardingStep.ChooseGuardian` case, ~:201-202):
- Pass `showNoGuardianOption={getEffectiveAllowNoGuardian()}` to `<ChooseGuardianScreen>`. Import the getter from `lib/miden-chain/effective-endpoints`.
- The Settings guardian-switch reuse (`src/app/templates/GuardianSettings.tsx`) does **not** pass the prop → stays `false`. This combines both gates (dev-flag ON + onboarding context) in one place.

### 4. Wiring (`src/app/pages/Welcome.tsx`, `choose-guardian-submit` ~:324-340)

- Branch on the sentinel:
  ```ts
  case 'choose-guardian-submit':
    if (action.payload.guardianId === NO_GUARDIAN_ID) {
      await removeFromStorage(GUARDIAN_URL_STORAGE_KEY); // ensure no stale endpoint
      setWalletType(WalletType.OffChain);
    } else {
      await putToStorage(GUARDIAN_URL_STORAGE_KEY, action.payload.guardianEndpoint);
      setWalletType(WalletType.Guardian);
    }
    // ...unchanged: password ? navigate('/#confirmation') : biometric branch
  ```
  (Use the existing storage remove helper; if none exists, `putToStorage(GUARDIAN_URL_STORAGE_KEY, '')` — the non-guardian spawn branch ignores it either way.)
- Export/share `NO_GUARDIAN_ID` from a single module (e.g. alongside `ChooseGuardian` or a small shared constant) so the screen and `Welcome` agree on the sentinel.
- Everything after is unchanged: `register()` → `registerWallet(WalletType.OffChain, …)` → `Vault.spawn` else-branch creates the private single-key account.

## Data flow

Dev settings: `Checkbox` → `form.allowNoGuardian` → `applyEndpointOverride(form)` → `overrideCache` (sync) + persisted storage.

Onboarding: navigator reads `getEffectiveAllowNoGuardian()` → prop → card rendered → user selects → `Continue` → `onSubmit({guardianId:'no-guardian', endpoint:''})` → `Welcome` sets `WalletType.OffChain`, skips guardian endpoint → `register()` → `Vault.spawn` else-branch → private single-key account.

## Scope / non-goals

- **In:** dev checkbox, onboarding "No guardian" card, create-flow wiring to `OffChain`.
- **Out:** Import flow (already has OnChain/Guardian selector); Settings guardian-switch (must not offer no-guardian); public (`OnChain`) no-guardian variant; converting an existing guardian account to no-guardian; wiring the dead `SelectRecoveryMethod` screen. No backend/SDK/multisig-client changes.

## Testing

- **Unit — `effective-endpoints.test.ts`:** `getEffectiveAllowNoGuardian()` returns `false` with no override and the stored value when set; `buildDefaultOverrideFor` includes `allowNoGuardian:false`; a legacy override object lacking the field still loads (guard tolerance) and reads as `false`.
- **Unit — `DeveloperSettings.test.tsx`:** checkbox renders, toggling updates form state + marks preset custom, value persists through `applyEndpointOverride` on save, disabled in read-only mode.
- **Unit — `ChooseGuardian.test.tsx`:** no-guardian card absent when `showNoGuardianOption` is false/undefined; present when true; selecting it + Continue calls `onSubmit` with `{guardianId:'no-guardian', guardianEndpoint:''}`; guardian cards still behave unchanged.
- **Unit — `Welcome`/handler (if reachable in the existing test harness):** `choose-guardian-submit` with the sentinel sets `WalletType.OffChain` and does not persist a guardian endpoint; the guardian path is unchanged.
- **Manual/visual:** rebuild the devnet extension, enable the checkbox in dev settings, complete onboarding via "No guardian", confirm the created account has `type: OffChain` and Settings shows no guardian section.

## PR logistics

- Branch `feat/dev-no-guardian-onboarding` off `next` (already created). Leave `wallet-devnet-build` untouched.
- CHANGELOG one-liner under the `1.15.20 (TBD)` section ("Fixes"/"Features" as appropriate — this is a dev-only feature).
- Run gates locally before pushing: `eslint` (incl. `lint:i18n` for the new keys), `tsc`, and the touched jest suites.
