# Dev-gated "No guardian" onboarding option — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a developer-settings checkbox that, when enabled, exposes a selectable "No guardian" card in the onboarding "Choose your guardian" screen; selecting it creates a private single-key (`WalletType.OffChain`) account with no guardian co-signer.

**Architecture:** UI + flow-wiring only — the non-guardian account path already exists (`Vault.spawn` else-branch → `createMidenWallet`). A new boolean `allowNoGuardian` rides on the existing `EndpointOverride` (persisted dev-settings object). The onboarding navigator reads it and passes a prop to `ChooseGuardianScreen`; selecting the card submits a sentinel id that `Welcome.tsx` routes to `WalletType.OffChain`.

**Tech Stack:** React + TypeScript, Zustand, react-i18next, Jest + React Testing Library. Repo `/Users/celrisen/miden/miden-wallet-no-guardian-dev`, branch `feat/dev-no-guardian-onboarding`, base `next`.

## Global Constraints

- **No `any`, no `as`** — use concrete types (CLAUDE.md code style).
- **All user-facing text via i18n** (`t('key')`); add new keys to `public/_locales/en/en.json` (flat format). `yarn lint:i18n` gates non-i18n strings.
- **Default-off:** when the flag is off, onboarding must be byte-identical to today (no card, no behavior change).
- **No backend/SDK/multisig-client changes.** Reuse the existing `WalletType.OffChain` create path.
- **Sentinel value is exactly `'no-guardian'`**, exported as `NO_GUARDIAN_ID` from `src/screens/onboarding/types.ts`.
- **No-guardian account type = `WalletType.OffChain`** (private single-key).
- **Do not touch** `isEndpointOverride` (legacy persisted overrides lacking the new field must still load).
- Prettier: 120 cols, single quotes, semicolons, trailing commas. Commit messages single-line, never signed / no `Co-Authored-By`. Never `git push` without explicit request. Leave the `wallet-devnet-build` worktree untouched.

## Prerequisite (one-time, before Task 1)

The worktree is fresh — install dependencies once. Deps are identical to the `wallet-devnet-build` worktree (same lockfile; #526/#527 changed no deps), so either is fine:

```bash
cd /Users/celrisen/miden/miden-wallet-no-guardian-dev
# Option A (fast): borrow identical-lockfile deps
ln -s /Users/celrisen/miden/wallet-devnet-build/node_modules node_modules
# Option B: a clean install
# source ~/.nvm/nvm.sh && nvm use 22 && yarn install --frozen-lockfile
```

Node ≥22 (`source ~/.nvm/nvm.sh && nvm use 22`). Test runner is `yarn test <path>` (jest). Typecheck: `npx tsc --noEmit -p tsconfig.json`. Lint: `npx eslint <files>` and `yarn lint:i18n`.

## File Structure

- `src/lib/miden-chain/effective-endpoints.ts` — add `allowNoGuardian` to the override type + default + getter. **(Task 1)**
- `src/lib/miden-chain/effective-endpoints.test.ts` — getter/default/legacy tests. **(Task 1)**
- `src/screens/onboarding/types.ts` — export `NO_GUARDIAN_ID` sentinel. **(Task 3)**
- `src/screens/developer-settings/DeveloperSettings.tsx` — checkbox row. **(Task 2)**
- `src/screens/developer-settings/DeveloperSettings.test.tsx` — checkbox tests. **(Task 2)**
- `src/screens/onboarding/common/ChooseGuardian.tsx` — `showNoGuardianOption` prop + card + sentinel submit. **(Task 3)**
- `src/screens/onboarding/common/ChooseGuardian.test.tsx` — card tests. **(Task 3)**
- `src/screens/onboarding/navigator.tsx` — pass the prop gated on the getter. **(Task 4)**
- `src/app/pages/Welcome.tsx` — route the sentinel to `WalletType.OffChain`. **(Task 4)**
- `src/app/pages/Welcome.test.tsx` — no-guardian handler test. **(Task 4)**
- `public/_locales/en/en.json` — new i18n keys. **(Tasks 2, 3)**
- `CHANGELOG.md` — one-liner. **(Task 4)**

---

### Task 1: `allowNoGuardian` on the override store

**Files:**
- Modify: `src/lib/miden-chain/effective-endpoints.ts`
- Test: `src/lib/miden-chain/effective-endpoints.test.ts`

**Interfaces:**
- Produces: `EndpointOverride.allowNoGuardian: boolean`; `getEffectiveAllowNoGuardian(): boolean`; `buildDefaultOverrideFor(...)` now includes `allowNoGuardian: false`.
- Consumes: existing `overrideCache`, `loadEndpointOverrides`, `ENDPOINT_OVERRIDE_STORAGE_KEY`.

- [ ] **Step 1: Write failing tests** — append to `src/lib/miden-chain/effective-endpoints.test.ts`. It already mocks the storage adapter via `mockKvStore` and imports the network maps from `./constants`. Add imports for the symbols under test if not already imported (`getEffectiveAllowNoGuardian`, `buildDefaultOverrideFor`, `loadEndpointOverrides`, `ENDPOINT_OVERRIDE_STORAGE_KEY`, `EndpointOverride` from `./effective-endpoints`), then add:

```ts
describe('getEffectiveAllowNoGuardian', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockKvStore)) delete mockKvStore[k];
  });

  it('defaults to false when no override is active', async () => {
    await loadEndpointOverrides(); // nothing stored -> cache null
    expect(getEffectiveAllowNoGuardian()).toBe(false);
  });

  it('reflects a stored override value', async () => {
    mockKvStore[ENDPOINT_OVERRIDE_STORAGE_KEY] = {
      ...buildDefaultOverrideFor(MIDEN_NETWORK_NAME.DEVNET),
      allowNoGuardian: true
    };
    await loadEndpointOverrides();
    expect(getEffectiveAllowNoGuardian()).toBe(true);
  });

  it('reads false from a legacy override that predates the field', async () => {
    const legacy: Record<string, unknown> = { ...buildDefaultOverrideFor(MIDEN_NETWORK_NAME.DEVNET) };
    delete legacy.allowNoGuardian;
    mockKvStore[ENDPOINT_OVERRIDE_STORAGE_KEY] = legacy;
    await loadEndpointOverrides();
    expect(getEffectiveAllowNoGuardian()).toBe(false);
  });

  it('buildDefaultOverrideFor includes allowNoGuardian:false', () => {
    expect(buildDefaultOverrideFor(MIDEN_NETWORK_NAME.DEVNET).allowNoGuardian).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn test src/lib/miden-chain/effective-endpoints.test.ts`
Expected: FAIL — `getEffectiveAllowNoGuardian is not a function` / `allowNoGuardian` undefined.

- [ ] **Step 3: Implement** in `src/lib/miden-chain/effective-endpoints.ts`:

Add the field to the interface (after the `guardianUrl` line):
```ts
  guardianUrl: string; // '' = no custom guardian
  allowNoGuardian: boolean; // dev-only: expose a "No guardian" card in onboarding
  networkName: MIDEN_NETWORK_NAME; // the "network id": drives NetworkId + endpoint-default seeding
```

Add the default inside `buildDefaultOverrideFor`'s returned object (after `guardianUrl`):
```ts
    guardianUrl: MIDEN_GUARDIAN_ENDPOINTS.get(network)?.[0] ?? '',
    allowNoGuardian: false,
    networkName: network,
```

Add the getter (immediately after `getEffectiveGuardianUrl`):
```ts
/** Dev-only: whether onboarding should offer a "No guardian" account option. */
export function getEffectiveAllowNoGuardian(): boolean {
  return overrideCache?.allowNoGuardian ?? false;
}
```

**Do NOT modify `isEndpointOverride`** — it deep-checks only `rpcUrl`/`networkName`, so legacy objects still pass; requiring the new boolean would reject a user's saved override.

- [ ] **Step 4: Run to verify pass**

Run: `yarn test src/lib/miden-chain/effective-endpoints.test.ts`
Expected: PASS (all, including the 4 new cases).

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit -p tsconfig.json
git add src/lib/miden-chain/effective-endpoints.ts src/lib/miden-chain/effective-endpoints.test.ts
git commit -m "feat(dev-endpoints): add allowNoGuardian override flag + getter"
```

---

### Task 2: Dev-settings checkbox

**Files:**
- Modify: `src/screens/developer-settings/DeveloperSettings.tsx`
- Modify: `public/_locales/en/en.json`
- Test: `src/screens/developer-settings/DeveloperSettings.test.tsx`

**Interfaces:**
- Consumes: `EndpointOverride.allowNoGuardian` (Task 1), `Checkbox` from `components/Checkbox`.
- Produces: a `data-testid="dev-allow-no-guardian"` row that toggles `form.allowNoGuardian` and persists it via the existing `applyEndpointOverride(form)` save path.

> **Note:** `Checkbox` (`src/components/Checkbox.tsx`) has its internal `onChange` commented out, so it is display-only. Drive the toggle from the wrapping row's `onClick`, passing `value={form.allowNoGuardian}` to the `Checkbox` purely as the visual indicator.

- [ ] **Step 1: Write failing tests** — in `src/screens/developer-settings/DeveloperSettings.test.tsx`:

First, mock the `Checkbox` (avoids rendering the real `Icon`/SVG) — add near the other `jest.mock`s at the top:
```ts
jest.mock('components/Checkbox', () => ({
  Checkbox: ({ value }: { value: boolean }) => <span data-testid="checkbox" data-checked={String(value)} />
}));
```

Then extend the existing `buildDefaultOverrideFor` mock object (in the `jest.mock('lib/miden-chain/effective-endpoints', …)` factory) to include the new field so `form.allowNoGuardian` is defined:
```ts
      guardianUrl: `https://guardian.${n}`,
      allowNoGuardian: false,
      networkName: n,
```
(Match the existing object's field set; add `allowNoGuardian: false` alongside the other defaults.)

Add the tests:
```ts
describe('DeveloperSettings — allowNoGuardian', () => {
  beforeEach(() => {
    applyEndpointOverride.mockClear();
    mockUseConfirm.mockReturnValue(confirm);
  });

  it('renders the no-guardian toggle row', () => {
    render(<DeveloperSettings />);
    expect(screen.getByTestId('dev-allow-no-guardian')).toBeInTheDocument();
    expect(screen.getByTestId('checkbox')).toHaveAttribute('data-checked', 'false');
  });

  it('persists allowNoGuardian=true when toggled on and saved', async () => {
    render(<DeveloperSettings />);
    fireEvent.click(screen.getByTestId('dev-allow-no-guardian'));
    fireEvent.click(screen.getByTestId('dev-endpoints-save'));
    await waitFor(() => expect(applyEndpointOverride).toHaveBeenCalled());
    expect(applyEndpointOverride).toHaveBeenCalledWith(expect.objectContaining({ allowNoGuardian: true }));
  });

  it('disables the toggle row in read-only mode', () => {
    render(<DeveloperSettings readOnly />);
    expect(screen.getByTestId('dev-allow-no-guardian')).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn test src/screens/developer-settings/DeveloperSettings.test.tsx`
Expected: FAIL — `Unable to find … dev-allow-no-guardian`.

- [ ] **Step 3: Implement** in `src/screens/developer-settings/DeveloperSettings.tsx`:

Add the import (with the other `components/*` imports):
```ts
import { Checkbox } from 'components/Checkbox';
```

Insert the row inside the scrollable form, immediately **after** the Network ID `</div>` block (i.e. after the closing `</div>` of the `flex flex-col gap-2` that wraps the Network ID `TabPicker`, and before the scroll-area's closing `</div>`):
```tsx
        <button
          type="button"
          disabled={readOnly}
          data-testid="dev-allow-no-guardian"
          onClick={
            readOnly
              ? undefined
              : () =>
                  setForm(prev => ({
                    ...prev,
                    allowNoGuardian: !prev.allowNoGuardian,
                    presetName: CUSTOM_PRESET
                  }))
          }
          className="flex items-center justify-between gap-3 text-left"
        >
          <span className="text-sm font-medium text-heading-gray">{t('devAllowNoGuardian')}</span>
          <Checkbox value={form.allowNoGuardian} />
        </button>
```

- [ ] **Step 4: Add i18n key** to `public/_locales/en/en.json` (next to the other `devEndpoint*` keys, keeping valid JSON / trailing commas):
```json
  "devAllowNoGuardian": "Allow 'No guardian' option in onboarding",
```

- [ ] **Step 5: Run to verify pass**

Run: `yarn test src/screens/developer-settings/DeveloperSettings.test.tsx`
Expected: PASS.

- [ ] **Step 6: Gates + commit**

```bash
npx tsc --noEmit -p tsconfig.json
npx eslint src/screens/developer-settings/DeveloperSettings.tsx src/screens/developer-settings/DeveloperSettings.test.tsx
yarn lint:i18n
git add src/screens/developer-settings/DeveloperSettings.tsx src/screens/developer-settings/DeveloperSettings.test.tsx public/_locales/en/en.json
git commit -m "feat(dev-settings): add 'Allow No guardian' checkbox"
```

---

### Task 3: "No guardian" card in ChooseGuardian

**Files:**
- Modify: `src/screens/onboarding/types.ts` (export sentinel)
- Modify: `src/screens/onboarding/common/ChooseGuardian.tsx`
- Modify: `public/_locales/en/en.json`
- Test: `src/screens/onboarding/common/ChooseGuardian.test.tsx`

**Interfaces:**
- Produces: `NO_GUARDIAN_ID = 'no-guardian'` (from `types.ts`); `ChooseGuardianScreenProps.showNoGuardianOption?: boolean`. When the card is selected and Continue pressed, `onSubmit({ guardianId: NO_GUARDIAN_ID, guardianEndpoint: '' })`.
- Consumes: nothing new.

- [ ] **Step 1: Add the sentinel** to `src/screens/onboarding/types.ts` (top-level, near the enums):
```ts
/** Sentinel guardianId meaning "create a no-guardian account" (dev-gated). */
export const NO_GUARDIAN_ID = 'no-guardian';
```
(Placed in `types.ts` so `Welcome.tsx` can import it without pulling in `ChooseGuardian`'s module graph.)

- [ ] **Step 2: Write failing tests** — in `src/screens/onboarding/common/ChooseGuardian.test.tsx` (it mocks `getGuardianOptionsForNetwork`, renders `<button data-testid="continue-button">` for `Button`, and echoes `t(key)`):
```ts
describe('ChooseGuardian — no-guardian option', () => {
  const oneOption = [{ id: 'open-zeppelin', name: 'OZ', operatedBy: 'OZ', location: 'US', endpoint: 'https://g' }];

  it('hides the No guardian card by default', () => {
    mockGetGuardianOptions.mockReturnValue(oneOption);
    render(<ChooseGuardianScreen onSubmit={jest.fn()} />);
    expect(screen.queryByTestId('choose-no-guardian')).toBeNull();
  });

  it('shows the card and submits the sentinel when enabled', () => {
    mockGetGuardianOptions.mockReturnValue(oneOption);
    const onSubmit = jest.fn();
    render(<ChooseGuardianScreen onSubmit={onSubmit} showNoGuardianOption />);
    fireEvent.click(screen.getByTestId('choose-no-guardian'));
    fireEvent.click(screen.getByTestId('continue-button'));
    expect(onSubmit).toHaveBeenCalledWith({ guardianId: 'no-guardian', guardianEndpoint: '' });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `yarn test src/screens/onboarding/common/ChooseGuardian.test.tsx`
Expected: FAIL — `choose-no-guardian` not found.

- [ ] **Step 4: Implement** in `src/screens/onboarding/common/ChooseGuardian.tsx`:

Import the sentinel (with the other imports):
```ts
import { NO_GUARDIAN_ID } from 'screens/onboarding/types';
```
(If the repo's import style for this file uses a relative path, use `'../types'` to match neighbors.)

Add the prop to the interface (after `allowCustomEndpoint`):
```ts
  // Dev-gated (onboarding only): show a selectable "No guardian" card that
  // creates a private single-key account with no guardian co-signer.
  showNoGuardianOption?: boolean;
```
Destructure it in the component signature with a default:
```ts
  allowCustomEndpoint = false,
  showNoGuardianOption = false
}) => {
```

Guard the sentinel at the **top** of `handleContinue` (before the `isCustom` branch):
```ts
  const handleContinue = () => {
    if (selectedId === NO_GUARDIAN_ID) {
      onSubmit?.({ guardianId: NO_GUARDIAN_ID, guardianEndpoint: '' });
      return;
    }
    if (isCustom) {
```

Render the card immediately **after** the options grid `</div>` (the `grid grid-cols-…` block that closes at the end of `options.map`), before the `allowCustomEndpoint` block:
```tsx
        {showNoGuardianOption && (
          <button
            type="button"
            onClick={() => handleSelect(NO_GUARDIAN_ID)}
            data-testid="choose-no-guardian"
            className={cn(
              'mt-4 flex flex-col items-start rounded-[20px] border-2 p-4 text-left transition-all duration-150 shrink-0',
              selectedId === NO_GUARDIAN_ID ? 'border-primary-500 border-4' : 'border-[#E3E3E3] dark:border-grey-800'
            )}
          >
            <span className="text-base font-semibold text-heading-gray">{t('noGuardianOptionTitle')}</span>
            <span className="mt-1 text-xs text-gray-secondary dark:text-pure-white">
              {t('noGuardianOptionSubtitle')}
            </span>
          </button>
        )}
```

- [ ] **Step 5: Add i18n keys** to `public/_locales/en/en.json` (near `chooseYourGuardian`):
```json
  "noGuardianOptionTitle": "No guardian",
  "noGuardianOptionSubtitle": "Advanced — recover with your seed phrase only. No guardian co-signer.",
```

- [ ] **Step 6: Run to verify pass**

Run: `yarn test src/screens/onboarding/common/ChooseGuardian.test.tsx`
Expected: PASS (new + existing guardian tests unchanged).

- [ ] **Step 7: Gates + commit**

```bash
npx tsc --noEmit -p tsconfig.json
npx eslint src/screens/onboarding/common/ChooseGuardian.tsx src/screens/onboarding/common/ChooseGuardian.test.tsx src/screens/onboarding/types.ts
yarn lint:i18n
git add src/screens/onboarding/common/ChooseGuardian.tsx src/screens/onboarding/common/ChooseGuardian.test.tsx src/screens/onboarding/types.ts public/_locales/en/en.json
git commit -m "feat(onboarding): dev-gated 'No guardian' card in ChooseGuardian"
```

---

### Task 4: Wire the flow (navigator + Welcome) + CHANGELOG

**Files:**
- Modify: `src/screens/onboarding/navigator.tsx`
- Modify: `src/app/pages/Welcome.tsx`
- Modify: `CHANGELOG.md`
- Test: `src/app/pages/Welcome.test.tsx`

**Interfaces:**
- Consumes: `getEffectiveAllowNoGuardian()` (Task 1), `showNoGuardianOption` prop (Task 3), `NO_GUARDIAN_ID` (Task 3), existing `WalletType.OffChain`, `putToStorage`, `GUARDIAN_URL_STORAGE_KEY`.

> **No new mocks needed in `navigator.test.tsx`:** `effective-endpoints` is already in the navigator's import graph via `ChooseGuardian → constants`, and `getEffectiveAllowNoGuardian()` returns `false` with no override — so existing navigator tests render `showNoGuardianOption={false}` (no card) unchanged.

- [ ] **Step 1: Write the failing Welcome test** — in `src/app/pages/Welcome.test.tsx`, inside the existing `describe('Welcome — choose-guardian-submit', …)` block. It uses `renderWelcome()`, `dispatch(action)`, `mockPutToStorage`, `mockRegisterWallet`, and `GUARDIAN_URL_STORAGE_KEY` mocked to `'guardian_url_setting'`:
```ts
  it('routes a No guardian selection to an OffChain wallet without storing a guardian endpoint', async () => {
    await renderWelcome();
    await dispatch({ id: 'setup-passcode-submit', payload: '111111' });
    mockPutToStorage.mockClear();
    await dispatch({ id: 'choose-guardian-submit', payload: { guardianId: 'no-guardian', guardianEndpoint: '' } });
    // never persists a real guardian endpoint
    expect(mockPutToStorage).not.toHaveBeenCalledWith('guardian_url_setting', expect.stringContaining('http'));
    // driving to confirmation registers a private, no-guardian (OffChain) wallet
    await dispatch({ id: 'confirmation' });
    expect(mockRegisterWallet).toHaveBeenCalledWith(WalletType.OffChain, '111111', expect.any(String), false);
  });
```
(Mirror the adjacent guardian test at lines ~430–437 for the passcode→confirmation sequence; if `confirmation` needs the mnemonic present, follow whatever the neighboring `registerWallet`-asserting test does to reach `register()`.)

- [ ] **Step 2: Run to verify failure**

Run: `yarn test src/app/pages/Welcome.test.tsx -t "No guardian"`
Expected: FAIL — `registerWallet` called with `Guardian`, not `OffChain` (handler not yet branching).

- [ ] **Step 3: Implement navigator** — `src/screens/onboarding/navigator.tsx`:

Add the import (with the other `lib/*` imports):
```ts
import { getEffectiveAllowNoGuardian } from 'lib/miden-chain/effective-endpoints';
```
Pass the prop at the `ChooseGuardian` case (currently `return <ChooseGuardianScreen onSubmit={onChooseGuardianSubmit} />;`):
```tsx
      case OnboardingStep.ChooseGuardian:
        return (
          <ChooseGuardianScreen
            onSubmit={onChooseGuardianSubmit}
            showNoGuardianOption={getEffectiveAllowNoGuardian()}
          />
        );
```

- [ ] **Step 4: Implement Welcome handler** — `src/app/pages/Welcome.tsx`:

Add the sentinel import (with the `screens/onboarding/types` import already on line 22, extend it):
```ts
import { NO_GUARDIAN_ID, OnboardingAction, OnboardingStep, OnboardingType, WalletType } from 'screens/onboarding/types';
```
Replace the first two lines of the `case 'choose-guardian-submit':` block (the unconditional `putToStorage` + `setWalletType(WalletType.Guardian)`) with the branch, leaving the `if (password) … else …` tail unchanged:
```ts
      case 'choose-guardian-submit':
        if (action.payload.guardianId === NO_GUARDIAN_ID) {
          // No guardian: private single-key (OffChain) account. Clear any stale
          // guardian endpoint; the non-guardian spawn branch ignores it anyway.
          await putToStorage(GUARDIAN_URL_STORAGE_KEY, '');
          setWalletType(WalletType.OffChain);
        } else {
          await putToStorage(GUARDIAN_URL_STORAGE_KEY, action.payload.guardianEndpoint);
          setWalletType(WalletType.Guardian);
        }
        if (password) {
          navigate('/#confirmation');
        } else {
          const hardwareAvailable = await checkHardwareSecurityAvailable();
          if (hardwareAvailable) {
            setPassword('__HARDWARE_ONLY__');
            navigate('/#confirmation');
          } else {
            navigate('/#create-password');
          }
        }
        break;
```

- [ ] **Step 5: Run to verify pass**

Run: `yarn test src/app/pages/Welcome.test.tsx src/screens/onboarding/navigator.test.tsx`
Expected: PASS (new no-guardian test + all existing; navigator suite unaffected).

- [ ] **Step 6: CHANGELOG** — add under the `## 1.15.20 (TBD)` section (verify it's still the unreleased heading via `gh api repos/0xMiden/wallet/releases/latest`; create a higher `(TBD)` section if 1.15.20 has shipped). Under `### Features`:
```md
- Dev-only: a "No guardian" option can be enabled from developer settings (7-tap the onboarding logo), which then shows a "No guardian" card on the Choose-your-guardian screen; selecting it creates a private single-key account with no guardian co-signer.
```

- [ ] **Step 7: Full gates + commit**

```bash
npx tsc --noEmit -p tsconfig.json
npx eslint src/screens/onboarding/navigator.tsx src/app/pages/Welcome.tsx src/app/pages/Welcome.test.tsx
yarn lint:i18n
git add src/screens/onboarding/navigator.tsx src/app/pages/Welcome.tsx src/app/pages/Welcome.test.tsx CHANGELOG.md
git commit -m "feat(onboarding): route 'No guardian' selection to an OffChain account"
```

---

## Manual verification (after all tasks)

1. Build the devnet extension in **this** worktree (not `wallet-devnet-build`):
   `MIDEN_NETWORK=devnet yarn build:extension` — verify no errors, `dist/chrome_unpacked/manifest.json` present.
2. Load unpacked, start onboarding, 7-tap the logo → Developer Settings → enable **Allow 'No guardian' option** → Save.
3. Create a new wallet → on Choose-your-guardian, confirm the **No guardian** card appears; select it → Continue → finish onboarding.
4. Confirm the account was created and Settings shows **no** guardian section (i.e. `type: OffChain`). With the dev flag **off**, confirm the card does not appear and onboarding is unchanged.

## Self-Review (completed by plan author)

- **Spec coverage:** dev flag (Task 1), checkbox (Task 2), card + onboarding-only gating (Tasks 3–4), OffChain wiring (Task 4), scope/non-goals honored (no Settings-switch card — the reuse simply doesn't pass the prop), tests per component, CHANGELOG + manual steps. ✓
- **Type consistency:** `allowNoGuardian` (boolean), `getEffectiveAllowNoGuardian()`, `showNoGuardianOption`, `NO_GUARDIAN_ID = 'no-guardian'`, `WalletType.OffChain` — used identically across tasks. `OnboardingAction`'s `choose-guardian-submit` payload already types `guardianId: string` (no types change needed for the read). ✓
- **Placeholders:** none — every code step has concrete code; sentinel lives in `types.ts` to avoid import-graph breakage; `Checkbox` display-only caveat captured. ✓
