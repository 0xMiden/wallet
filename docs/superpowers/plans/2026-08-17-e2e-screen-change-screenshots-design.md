# E2E screen-change screenshots — design

- **Date:** 2026-08-17
- **Status:** Draft for review
- **Repo:** `0xMiden/wallet` (design mapped against `origin/main`; local checkout was 29 commits behind at time of writing)

## 1. Goal

Every E2E harness that runs on a push to `main` should produce a screenshot **on every screen change** of the wallet UI, uploaded as CI artifacts, so we have a browsable per-run visual record (filmstrip) of how each flow looks — on green runs, not only failures.

"Screen change" = a navigation-level UI transition. Concretely, `walletA.sendTokens(...)` must yield separate shots for **amount → review → generating → receipt**, plus shots when **drawers/modals** open and close. It explicitly does **not** mean the in-place proving sub-stages inside the Generating-Transaction screen (creating-proposal → sending → submitting → confirming) — those are one screen.

### Decisions locked with the requester

| Decision | Choice |
|---|---|
| Granularity (Tier) | **Tier 2** — Woozie route changes + Navigator card-stack steps + drawer/modal open/close. NOT proving sub-stages. |
| Mobile fidelity | **Per-screen on all platforms** (Chrome, iOS, Android). Accept that a sub-250ms transient screen may be missed on mobile; accept native-grab latency. |
| PR-only suites on `main` | **Blocking gates** — swap, earn, guardian-lifecycle, bridge-guardian get a `push: main` trigger and fail `main` on failure. |
| Drawer/modal identity | **Optional `screenKey` prop + generic fallback.** Named overlays get precise labels; unnamed ones publish a generic `drawer`/`modal` key so open/close is still captured. Names threaded through call sites progressively. |
| Rollout | **Full build in one spec** (all platforms + CI together). |

## 2. Motivation / why app-side capture

The suites are **not** uniform in how they mark stages:

- `guardian-*` and `resilience` specs use the custom `TestStepRunner` (`steps.step(...)`), which already has an opt-in per-step screenshot path (`playwright/e2e/harness/test-step.ts:95-113`). Only 58 of 218 step calls opt in today.
- **`swap`, `earn`, `bridge`, `bridge-guardian` specs do NOT call `steps.step(...)` at all** — they drive `walletA`/`walletB` directly. Any mechanism hung off `TestStepRunner` would silently capture **nothing** for these four suites.

Therefore capture must be triggered **from the app** (the only component that knows when a screen actually changes) and **from a per-platform capture loop in the harness**, independent of whether a spec uses `TestStepRunner`. This is the load-bearing rationale for the whole design.

## 3. Non-goals

- No visual-regression / golden-image gating (`toHaveScreenshot`). This produces images for humans to browse, not diffs that fail the build.
- No capture of Generating-Transaction proving sub-stages (Tier-2 boundary).
- No permanent archive. Retention stays at the existing CI window (7 days). A durable external sink (S3 / Pages) is a possible follow-up, out of scope here.
- No new navigation abstraction. We observe the three existing systems; we do not unify them in product code.

## 4. Architecture overview

```
┌─ App (only when MIDEN_E2E_TEST === 'true', tree-shaken from prod) ─────────────┐
│  ScreenKeyPublisher (root component in AppProvider, inside Woozie.Provider)     │
│    key = compose(route, navigatorCard, overlay)                                 │
│    on change → globalThis.__TEST_SCREEN__ = { key, seq }  (immediate)           │
│                → debounced(150ms) window.__e2eScreenChanged(key)  (Chrome only) │
│    sources:                                                                     │
│      • Woozie   → listen() + createLocationState().pathname                     │
│      • Navigator→ useEffect([activeRoute]) in NavigatorProvider (all 4 flows)   │
│      • Overlay  → Drawer / CustomModal / dialog store (optional screenKey prop) │
└────────────────────────────────────────────────────────────────────────────────┘
        │ Chrome (reactive)              │ iOS / Android (polling ~250ms)
        ▼                                ▼
  page.exposeFunction(              setInterval: read __TEST_SCREEN__.seq via CDP;
   '__e2eScreenChanged',             on change → native grab (simctl / adb screencap)
    key => page.screenshot(...))
        │                                │
        └──────────────► <outputDir>/screens/screen-<seq>-<key>-wallet-<label>.png
                         (same harness outputDir → rides existing artifact upload)
```

## 5. Detailed design

### 5.1 Screen-key signal (app-side)

**Gating.** Every piece gates on `process.env.MIDEN_E2E_TEST === 'true'`, matching the existing hook pattern (`src/lib/store/index.ts:772-778`, `src/app/pages/Welcome.tsx:148-155`). Vite statically replaces the flag in prod, so all of this tree-shakes out. Published to `globalThis` (not `window`) to match the existing hooks (works across SW context too), but read as `window.__TEST_SCREEN__` in browser contexts.

**Shape.** `globalThis.__TEST_SCREEN__ = { key: string, seq: number }`. `seq` is a monotonic counter bumped on every `key` change; harness capture is driven by `seq`, never by string parsing.

**Composition.** `key = [route, card, overlay].filter(Boolean).join(' > ')`. Overlay is appended, so both open and close change the key (`/send > SelectAmount` ↔ `/send > SelectAmount > drawer:token`). A pure `composeScreenKey(parts)` function is unit-testable in isolation.

**Sources & single hook points:**

1. **Woozie route** — `ScreenKeyPublisher`, a root component mounted in `AppProvider` (`src/app/App.tsx:94-96`, inside `<Woozie.Provider>`). Uses `listen()` (`src/lib/woozie/history.ts:18-27`) + `createLocationState().pathname` (+ `search`). This component owns `__TEST_SCREEN__` and the debounced Chrome push; the other two sources write their part into it.
2. **Navigator card** — one `useEffect([activeRoute])` inside `NavigatorProvider` (`src/components/Navigator.tsx:37-116`; `activeRoute` at `:94`). Because all four flows (`SendManager.tsx:793`, `SwapManager.tsx:350`, `EncryptedFileManager.tsx:234`, `EvmBridgeDepositScreen.tsx:686`) mount this one provider, a single effect covers every flow. Publishes `activeRoute?.name` as the `card` part (cleared when the provider unmounts).
3. **Overlay (drawer / modal / dialog)** — three shared primitives, one hook each:
   - `src/lib/ui/drawer.tsx` (`Drawer`, `:26-37`) — effect keyed on `open`.
   - `src/app/atoms/CustomModal.tsx` (`:12-27`) — effect keyed on `isOpen`.
   - `src/lib/ui/dialog.tsx` (constate store, `:22-27`) — alert/confirm `isOpen`.
   Each publishes `overlay = "drawer:<screenKey>"` / `"modal:<screenKey>"` / `"dialog:alert"`, falling back to a generic `"drawer"`/`"modal"` when no `screenKey` is supplied. A small **stack** is kept for the overlay part so nested overlays and close-order behave (top of stack wins; empty → no overlay part).

**Drawer/modal identity (the one gap).** The shared `Drawer`/`CustomModal` carry no per-instance identity. We add an **optional** `screenKey?: string` prop to both. Named call sites get precise labels; unnamed ones fall back to generic. We thread meaningful names into the high-value pickers first (`SelectToken`, `SelectSwapToken`, `AccountsList`, `SelectNetwork`, `ScanQr`, `FundWallet`, guardian info, seed reveal, dApp actions sheet, EVM connect/bridge drawers) and can add the rest incrementally. Correct capture from day one; precision improves over time without blocking the feature.

**Debounce / settle.** `__TEST_SCREEN__` is updated **immediately** on every change (so mobile polls always read the latest committed value). The **Chrome** push (`__e2eScreenChanged`) is **debounced ~150ms** so the reactive shot lands after the screen paints and rapid multi-part key changes coalesce into one shot. Consequence: Chrome and mobile can occasionally disagree on whether a very-fast intermediate screen was captured — acceptable for an audit filmstrip; documented as a limitation.

### 5.2 Capture — Chrome (reactive)

- Register `page.exposeFunction('__e2eScreenChanged', (key) => captureScreen(page, key, label))` per wallet page. There is **no existing `exposeFunction` usage** in `playwright/` — this is net-new.
- Registration site: the `walletA`/`walletB` fixtures in `playwright/e2e/fixtures/two-wallets.ts` (`:746-791`), right after `launchWalletInstance` resolves the page (page getter `:556-558`), alongside the existing `steps.registerSnapshotCaps(...)` call.
- **Re-registration:** `exposeFunction` is per-page. It MUST be re-registered after `relaunch()` (`two-wallets.ts:513-521`) and after the load-retry `page.reload()` (`:481`). A small `installScreenCapture(page, label, outputDir)` helper is called from each of those sites.
- `captureScreen` writes `page.screenshot({ path })` best-effort (try/catch — the page may be mid-navigation or torn down, mirroring `test-step.ts:109`).

### 5.3 Capture — iOS & Android (polling)

- No existing background interval on either fixture — net-new. Start a `setInterval(~250ms)` in the pair fixture (`two-simulators.ts:362-408` `_simPair`; the Android equivalent in `two-emulators.ts`) once wallets are up; clear it in teardown.
- Each tick evals a tiny read and grabs on change:
  - **iOS:** `cdp.eval('return JSON.stringify(window.__TEST_SCREEN__ || null)')` (`cdp-bridge.ts:100-109`). **Do NOT use `evalAsync`** — broken on the iOS RWI bridge (`cdp-bridge.ts:116-130`). Grab via `IosWalletPage.screenshot({ path })` → `simctl io screenshot` (`ios-wallet-page.ts:101-103`, `simulator-control.ts:172-175`).
  - **Android:** `cdp.evaluate(() => window.__TEST_SCREEN__)` (real CDP, `cdp-bridge.ts:162-170`). Grab via `AndroidWalletPage.screenshot({ path })` → `adb exec-out screencap -p` (`android-wallet-page.ts:58-60`, `emulator-control.ts`).
- **WASM-lock safety (confirmed):** reading the plain `__TEST_SCREEN__` object touches no WASM, so it is NOT subject to the `useSyncTrigger` 30–60s sync-lock deadlock the repo warns about (that warning is specific to reading the WASM *client*). Same reasoning the codebase already relies on for `__TEST_GUARDIAN_AUTH__` / `__TEST_STORE__` reads over CDP. Invariant to preserve: `__TEST_SCREEN__` must never dereference the Miden client.
- **Serialization caveat:** iOS CDP calls share one RWI socket, so the 250ms poll competes with the spec's own eval traffic. Keep the polled read minimal (single small JSON string).

### 5.4 Output location & file naming

- Reuse the harness `outputDir` (from `steps` / `timeline.getOutputDir()`), so shots ride the existing artifact upload with zero extra CI wiring:
  - Chrome → `test-results/run-<ts>/tests/<id>/screens/`
  - iOS → `test-results-ios/run-<ts>/tests/<id>/screens/`
  - Android → `test-results-android/run-<ts>/tests/<id>/screens/`
- Filename: `screen-<seq3>-<sanitizedKey>-wallet-<label>.png` (e.g. `screen-004-send__SelectAmount__drawer_token-wallet-a.png`). Zero-padded `seq` keeps lexical = chronological order (a proper filmstrip). Key sanitized to a filesystem-safe slug.
- Lives alongside the existing `screenshots/` (per-step) folder; the two do not collide.

### 5.5 CI changes (#3 + green-run capture)

Add `push: branches: [main]` as **blocking gates** and ensure uploads fire on green runs:

| Workflow | Change |
|---|---|
| `pr-e2e-swap.yml` | add `push: main` trigger; `upload-artifact` `if: failure()` → `if: always()` |
| `pr-e2e-earn.yml` | same |
| `pr-e2e-guardian-lifecycle.yml` | same |
| `pr-e2e-bridge-guardian.yml` | same |
| `e2e-resilience.yml` | `upload-artifact` `if: failure()` → `if: always()` (+ set `retention-days: 7`) so green resilience runs keep their filmstrips |

Already correct (no change): `e2e-blockchain.yml`, `e2e-bridge.yml`, `e2e-bridge-in.yml`, `e2e-android.yml` all upload `if: always()`.

Concurrency/cost note: promoting the four suites to `main` gates adds four localnet-stack runs per main push. They already run per-PR, so runner capacity exists; but this doubles their invocation rate. Flagged for the requester as an accepted cost of the "blocking gate" choice.

## 6. Affected files (concrete)

**App (product code, all `MIDEN_E2E_TEST`-gated):**
- `src/app/App.tsx` — mount `ScreenKeyPublisher` in `AppProvider` (inside `Woozie.Provider`).
- `src/app/templates/ScreenKeyPublisher.tsx` *(new)* — owns `__TEST_SCREEN__`, Woozie `listen()`, debounced Chrome push, and the compose/publish API the other sources call into.
- `src/lib/testing/screen-key.ts` *(new)* — pure `composeScreenKey` + a tiny publish helper + the overlay stack. Unit-tested.
- `src/components/Navigator.tsx` — add `useEffect([activeRoute])` in `NavigatorProvider`.
- `src/lib/ui/drawer.tsx` — optional `screenKey` prop; publish on `open`.
- `src/app/atoms/CustomModal.tsx` — optional `screenKey` prop; publish on `isOpen`.
- `src/lib/ui/dialog.tsx` — publish alert/confirm open state.
- High-value drawer call sites (SelectToken, SelectSwapToken, AccountsList, SelectNetwork, ScanQr, FundWallet, GuardianInfo, RevealSeedPhrase, DappActionsSheet, EvmConnect/Bridge drawers) — pass `screenKey`.

**Harness:**
- `playwright/e2e/fixtures/two-wallets.ts` — `installScreenCapture(page,label,outputDir)`; call after launch + after relaunch/reload.
- `playwright/e2e/harness/screen-capture.ts` *(new, shared)* — `captureScreen` + filename builder used by all platforms.
- `playwright/e2e/ios/fixtures/two-simulators.ts` — 250ms poll loop + native grab; teardown clear.
- `playwright/e2e/android/fixtures/two-emulators.ts` — same.

**CI:** the five workflow edits in §5.5.

## 7. Testing / verification strategy

Empirical proof before "done" (the feature IS test infra, so verification = demonstrating the filmstrip):

1. **Unit:** `composeScreenKey` + overlay-stack logic (Jest, pure functions). Covers ordering, append-on-overlay, generic fallback, close-restores-base.
2. **Chrome local run:** build with `MIDEN_E2E_TEST=true`, run `send-public` (localhost) and confirm `screens/` contains an ordered filmstrip that includes amount → review → generating → receipt **and** a token-drawer open/close pair. Eyeball the PNGs.
3. **iOS local run:** boot a simulator, run `send-public.ios`, confirm the mobile `screens/` filmstrip captures the same transitions (accepting occasional transient misses).
4. **Swap/earn coverage proof:** run one swap spec (which uses **no** `steps.step`) and confirm screenshots are still produced — the key evidence that app-side capture covers the non-TestStepRunner suites.
5. **CI dry-run:** on the feature branch, trigger the promoted workflows via `workflow_dispatch` and confirm the `screens/` artifacts upload on a **green** run.

## 8. Limitations & risks (carried forward)

- **Tier-2 boundary:** proving sub-stages inside Generating-Transaction are one screen — not separately captured.
- **Mobile transient misses:** 250ms poll can miss a screen that appears+disappears faster than the interval; each grab adds latency (iOS already on 25-min per-test timeout — tolerable).
- **Chrome vs mobile timing skew:** debounced reactive (Chrome) vs polled (mobile) means the two platforms may capture slightly different intermediate frames for the same flow.
- **Retention = 7 days:** an audit *window*, not a permanent record.
- **Not regression detection:** images only; a human eyeballs them.
- **Drawer identity is incremental:** unnamed overlays show as generic until names are threaded in.
- **CI cost:** four extra localnet-stack runs per main push (accepted with the blocking-gate choice).
- **`exposeFunction` re-registration** after relaunch/reload is a correctness footgun — covered explicitly, must not regress.

## 9. Open questions

None blocking. Optional future work: raise retention / add durable sink; add per-drawer names for the long tail; consider an index.html filmstrip viewer generated per run.
