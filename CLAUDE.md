# CLAUDE.md

Guidance for Claude Code. **Self-maintaining:** update proactively when you learn a gotcha, pattern, or debugging trick worth keeping.

## Project

Miden Wallet: Chrome/Firefox extension + iOS/Android (Capacitor) + macOS (Tauri). React + Zustand frontend; service-worker backend (Effector store + vault). Backend is source of truth; frontend syncs via intercom port messaging.

## Layout

```
src/
├── lib/
│   ├── store/           # Zustand (frontend)
│   ├── miden/{back,front,sdk,psm}
│   ├── intercom/        # port messaging
│   ├── platform/        # isMobile/isIOS/isAndroid/isExtension
│   ├── mobile/          # haptics, back-handler
│   ├── woozie/          # router (navigate, goBack, useLocation, <Link>)
│   └── shared/types.ts
├── app/ | screens/ | workers/
src-tauri/               # desktop
playwright/e2e/          # E2E harness (chrome + ios)
```

## Commands

```bash
yarn dev | build | test | lint | format
yarn build:devnet        # network-specific extension build
yarn mobile:ios:run[:devnet]     # iOS simulator (iPhone 17 default)
yarn mobile:android
yarn tauri dev
yarn test:e2e:blockchain:{testnet,devnet,localhost}
yarn test:e2e:mobile:{devnet,testnet}
```

Node >=22 for Capacitor/Tauri: `source ~/.nvm/nvm.sh && nvm use 22`.

Lint/format only before commit or when asked — not every build.

## Version bumps

Extension manifest version comes from `package.json`, NOT `public/manifest.json` (webpack overrides it at `webpack.public.config.js:69-70`). Update **both** to keep in sync, then `rm -rf node_modules/.cache/webpack dist/` if the old version sticks.

## Critical gotchas

### WASM client concurrency
Miden WASM client is single-threaded. Concurrent calls throw `recursive use of an object ... unsafe aliasing`. **Always** wrap in `withWasmClientLock`:
```typescript
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
await withWasmClientLock(async () => (await getMidenClient()).someOp());
```

### Tailwind auto-flipping tokens
Many tokens in `tailwind.config.ts` map to CSS vars in `src/main.css` and auto-flip with theme. Do NOT add `dark:` variants on these — it overrides the auto-flip with a worse value:
- `text-black`, `bg-white`, `bg-gray-25/50/100`, `text-heading-gray`

Add `dark:` only on fixed-palette colors (`grey.*` custom palette, `pure-white`, `pure-black`) or SVG `fill={...}` props (check `document.documentElement.classList.contains('dark')` at render).

### i18n required
All user-facing text must use `t('key')` or `<T id="key" />`. CI blocks non-i18n strings (`yarn lint:i18n`). Add new keys to `public/_locales/en/en.json` (flat format). Placeholders: `$name$`.

### Platform isolation
Wrap platform-specific fixes with `isIOS()`/`isAndroid()`/`isMobile()` from `lib/platform`. Don't apply iOS fixes globally.

### Haptics on tappable components
Add `hapticLight()` (taps), `hapticMedium()` (toggles), `hapticSelection()` (tabs) from `lib/mobile/haptics`. Auto-checks `isMobile()` and user setting.

### Mobile file downloads
`<a download>` does nothing in WebView. Use `Filesystem.writeFile` + `Share.share` from `@capacitor/{filesystem,share}` when `isMobile()`.

### Balance loading
`fetchBalances` reads IndexedDB via `getAccount()` (instant). `AutoSync` (1s interval) calls `syncState()` separately to update IndexedDB. Don't call `syncState()` from the UI path.

## Adding a wallet action

1. Message type in `src/lib/shared/types.ts`
2. Handler in `src/lib/miden/back/actions.ts`, register in `back/main.ts`
3. Store action in `src/lib/store/index.ts`
4. Expose via `useMidenContext()` in `src/lib/miden/front/client.ts`

## Navigation

Two systems:
- **Woozie** (`src/lib/woozie/`) — hash-based global router. `navigate`, `goBack`, `useLocation`, `<Link>`.
- **Navigator** (`src/components/Navigator.tsx`) — internal step flows (`SendManager`, `EncryptedFileManager`). `useNavigator()` → `{navigateTo, goBack, cardStack}`.

Onboarding (`Welcome.tsx`) and `ForgotPassword.tsx` use hash-based state (`/#step-name`), NOT Navigator.

Back handlers (`src/app/env.ts`): `registerBackHandler` is stack-based. `PageLayout` registers a default that calls `goBack()` if `historyPosition > 0` else navigates home. Mobile hardware/swipe back requires `@capacitor/app` + explicit handlers — must be registered for global nav (`MobileBackBridge`), Navigator flows, state-based flows, and modals.

When adding screens/routes, keep this section accurate so mobile back stays correct.

## Mobile testing

### Skip onboarding
```bash
node /tmp/cdp-eval 'window.__TEST_SKIP_ONBOARDING = true; window.location.reload()'
```
Bypass lives in `Welcome.tsx`, only active when flag/query param set.

### iOS debugging
`console.log` goes to Safari Web Inspector — Claude cannot read it. Use:
```bash
xcrun simctl spawn booted log stream --predicate 'process == "App"'
```
For live DOM/JS eval: use the CDP bridge via `inspect` + persistent-connection daemon (`/tmp/cdp-daemon.mjs` + `/tmp/cdp-eval`). Bringup recipe in `~/.claude/projects/-Users-celrisen-miden-miden-wallet/memory/cdp-bridge-single-use-bug.md`. Key steps: kill bridges, reset `com.apple.webinspectord`, relaunch app, start `inspect`, start daemon, smoke-test with `node /tmp/cdp-eval '1+1'`.

### Verifying UI fixes
Always screenshot to verify:
```bash
xcrun simctl io booted screenshot /tmp/shot.png
xcrun simctl spawn booted notifyutil -p com.apple.BiometricKit_Sim.fingerTouch.match  # FaceID
```

### Common iOS layout issues
- Grey bar at bottom → `100dvh` doesn't account for safe areas. Use `100%` + `env(safe-area-inset-*)` padding on `mobile.html` body.
- Debug UI text should be `select-text` so errors are copyable.

### Adding Swift files to the App target
The App target in `ios/App/App.xcodeproj/project.pbxproj` does NOT auto-discover Swift files in the `App/` source directory. New files must be registered in four sections: `PBXBuildFile`, `PBXFileReference`, the App `PBXGroup` children, and the `PBXSourcesBuildPhase` files list. Pattern: see `LocalBiometricPlugin.swift` or `HotKeyPlugin.swift` entries.

### Adding a custom Capacitor plugin (iOS)
Capacitor on this app uses **manual** registration — not the `CAPBridgedPlugin` auto-discovery you'd get on a stock Capacitor app. After creating `MyPlugin.swift` and wiring it into the four pbxproj sections above, you also have to call `bridge?.registerPluginInstance(MyPlugin())` inside `capacitorDidLoad()` in `ios/App/App/AppViewController.swift`. Skip this step and JS calls land as `{"code":"UNIMPLEMENTED"}` even though the class compiled fine.

### swift-secp256k1 (P256K) trait-gating workaround
21-DOT-DEV/swift-secp256k1 v0.22+ gates `ENABLE_MODULE_ECDH/RECOVERY/SCHNORRSIG/MUSIG/ELLSWIFT` behind SPM traits. CLI `swift build` honors the default-enabled traits; **Xcode silently drops `.when(traits:)` conditions** so libsecp256k1 ships those C symbols missing while P256K's Swift code references them — undefined-symbol link errors. Workaround: `ios/App/scripts/patch-swift-secp256k1.sh` promotes the five defines into `baseSettings` (unconditional). Yarn pipeline (`mobile:ios`, `mobile:ios:build`, `test:e2e:mobile:build`, `mobile:ios:release`) calls it as `yarn mobile:ios:patch-spm`. Re-run manually after a Package "Reset Caches" in Xcode.

### Native navbar overlay
Mobile hides React footer and renders bottom nav as native pill (iOS: `MidenNavbarOverlayWindow` `UIWindow`; Android: two-instance `NavbarOverlayManager` with Activity-scoped + Dialog-scoped `NavbarView`). Plugin methods: `showNativeNavbar`, `setNavbarSecondaryRow`, `setNavbarAction`, `morphNavbar{Out,In}`. Events: `nativeNavbarTap`, `nativeNavbarSecondaryTap`, `nativeNavbarActionTap`. Wiring: `src/app/providers/DappBrowserProvider.tsx`. Android gotchas: don't use `MATCH_PARENT` children in `WRAP_CONTENT` parents (1878px buttons); `Dialog.setLayout` must follow `setContentView`; shadow must be on the view owning the background drawable.

### Adding Capacitor plugins
`yarn add @capacitor/<name> && yarn mobile:sync`. Add ProGuard rules to `android/app/proguard-rules.pro`:
```
-keep class com.capacitorjs.plugins.<name>.** { *; }
```
Remove rules when uninstalling.

## Desktop (Tauri)

- `src-tauri/src/{main,dapp_browser,lib}.rs`, `scripts/dapp-injection.js`
- Clear state: `rm -rf ~/Library/WebKit/{com.miden.wallet,miden-wallet}`
- dApp flow: inject encodes base64 request → navigate `https://miden-wallet-request/{payload}` → Tauri `on_navigation` intercepts → event to main window → `DesktopDappHandler` confirms → response via same URL-intercept pattern.

## E2E

### Chrome blockchain harness
Two Chrome instances + `miden-client` CLI against live network. `E2E_NETWORK` controls both harness endpoints AND `MIDEN_NETWORK` baked into the bundle — use the `:<network>` scripts to keep them matched. Auto-installs `miden-client-cli` from crates.io, version-matched to `@miden-sdk/miden-sdk`. Requires `cargo`. Specs: `wallet-lifecycle`, `mint-and-balance`, `send-{public,private}`, `multi-{claim,account}` in `playwright/e2e/tests/`.

**Agentic mode** (`E2E_AGENTIC=true` or `yarn test:e2e:blockchain:agentic`): on failure, browsers stay open 10 min; `test-results/debug-session.json` has connection info; `report.json` has `failureCategory`, `diagnosticHints`, `stateAtFailure`, `browserErrors`. Hot-reload via `chrome.runtime.reload()` preserves IndexedDB/vault.

### iOS simulator harness
Mirror suite in `playwright/e2e/ios/` against iPhone 17 + iPhone 17 Pro. CDP via `appium-remote-debugger` (simulator-compatible, unlike `remotedebug-ios-webkit-adapter`) over `RWI_LISTEN_SOCKET`. Per-test: terminate/uninstall/install/launch (~5s vs 30s for `simctl erase`). 7/7 specs pass on devnet in ~9 min.

iOS-specific product notes:
- Native navbar CTAs ("Claim All", "Continue") live in `UIWindow` outside WebView — CDP can't see them. `src/lib/dapp-browser/use-native-navbar-action.ts` exposes `globalThis.__TEST_TRIGGER_NAVBAR_ACTION__()` gated on `MIDEN_E2E_TEST=true && isMobile()`. Only wallet source change the iOS harness needed.
- No `SYNC_REQUEST` on mobile (SW-only); `useSyncTrigger` auto-syncs every 3s, so sleep suffices.
- No mobile reload trick — mobile `claimAllNotes` skips the `location.reload()` Chrome does (mobile has no SW holding the unlock, so reload drops decryption key).
- Don't read WASM client from CDP — deadlocks against `useSyncTrigger`'s 30–60s lock hold.

### E2E test hooks
`MIDEN_E2E_TEST=true` exposes `window.__TEST_STORE__` (Zustand) and `window.__TEST_INTERCOM__`. Zero production impact.

## Testing

Jest + RTL. Mock `lib/intercom` for frontend tests; wrap with `WalletStoreProvider` + `MidenContextProvider`.

Gotchas:
- `jest.mock()` path must match the import path used in source (e.g., `'lib/miden/back/vault'`, not `'./vault'`).
- `window.location.reload` can't be mocked in jsdom — wrap calls in try/catch.
- `afterEach(() => testRoot.unmount())` to prevent React cross-test pollution.

## Code style

Prettier: 120 cols, single quotes, semicolons, trailing commas. Break long `console.log`s across lines. `yarn format` to fix.

No `any`, no `as`. Use concrete types.

<<<<<<< utk-psm-integration
## Conventions
=======
## Linked Web SDK PR (cross-repo CI)

The wallet's CI can be pointed at an unpublished `@miden-sdk/miden-sdk`
or `@miden-sdk/react` branch by including a marker in the wallet PR's
description:

```
Web SDK PR: #134
```

Or cross-repo:

```
Web SDK PR: 0xMiden/web-sdk#134
```

When the marker is present, every yarn-using job in `.github/workflows/pr.yml`
runs `.github/actions/inject-linked-web-sdk-pr` BEFORE its `yarn install`
step. The action clones the linked web-sdk PR, builds
`@miden-sdk/miden-sdk` + `@miden-sdk/react` from source, and rewrites
this repo's `package.json` to consume them via `file:` deps (runner-local
mutation, never committed).

A separate workflow (`check-linked-web-sdk-pr.yml`) posts a custom
status named `linked-web-sdk-pr-ready` that's `pending` until the linked
web-sdk PR is merged AND a release tag covering its merge commit is
visible. Branch protection on `main` should require this status before
allowing the wallet PR to merge — that's the gate that prevents the
wallet from landing while it depends on an unpublished web-sdk change.

Local-dev parity:

```bash
scripts/dev-with-web-sdk-pr.sh             # auto-detect from current PR body
scripts/dev-with-web-sdk-pr.sh 134         # use web-sdk#134
scripts/dev-with-web-sdk-pr.sh --clear     # restore the published versions
```

The `lefthook.yml` pre-commit hooks block committing the patched state
(state file `.linked-web-sdk-pr.json` or `file:` SDK deps in
package.json). Lefthook isn't auto-installed by `yarn install` — opt in
once with `pnpm dlx lefthook install` if you want the guard.

Mirrors web-sdk's `Client PR: #N` pattern (`.github/actions/inject-linked-client-pr`).

## Important Notes
>>>>>>> main

- Commit messages: single-line, short. Never sign commits (no `Co-Authored-By`).
- Never `git push` without explicit request.
- Stay within requested scope — don't modify files beyond the task.
- Update `CHANGELOG.md` one-liner per PR/task (not per fix).
- When adding a new intercom message type, also update `src/lib/intercom/mobile-adapter.ts`.
- Optimistic updates: snapshot prev, apply, rollback on catch.
- Background auto-ops: use `startBackgroundTransactionProcessing` (polls 5s × 5min, no modal) instead of `openLoadingFullPage`.
- Transaction states (`ITransactionStatus`): Queued(0) → GeneratingTransaction(1) → Completed(2) / Failed(3).
- Frontend receives sanitized state via `toFront()`; sensitive data (vault, keys) stays backend-only.
