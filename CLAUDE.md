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
│   ├── miden/transaction/   # tx pipeline: initiate/complete/get/cancel/helper; index = generateTransaction + loop (re-exported via miden/activity)
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

## CHANGELOG

`CHANGELOG.md` carries unreleased entries under a `## <next-version> (TBD)` heading. **NEVER add an entry to a section whose version has already been published — check `gh api repos/0xMiden/wallet/releases/latest` for the latest tag and put new entries under a section whose version is strictly higher and still has `(TBD)` next to it. If no such section exists, add one.** The header at the top of `CHANGELOG.md` may lag (a `(TBD)` heading often persists past the release tag); don't trust the heading alone.

## Critical gotchas

### WASM client concurrency
Miden WASM client is single-threaded. Concurrent calls throw `recursive use of an object ... unsafe aliasing`. **Always** wrap in `withWasmClientLock`:
```typescript
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
await withWasmClientLock(async () => (await getMidenClient()).someOp());
```

### Duplicate dexie / duplicate `@miden-sdk/miden-sdk` ("Two different versions of Dexie loaded")
The wallet pulls `@miden-sdk/miden-sdk` two ways: the file-linked web-sdk (root, e.g. 0.14.10) AND a nested copy under `@openzeppelin/miden-multisig-client/node_modules/@miden-sdk/miden-sdk` (its own pin, e.g. 0.14.5). **Each SDK build INLINES its own dexie** into its wasm-glue chunk (`dist/**/Cargo-*.js`), at different versions (e.g. 4.4.2 vs 4.0.8). Two inlined dexies → dexie's `globalThis[Symbol.for("Dexie")]` guard throws at runtime (service worker fails to register; mobile/desktop crash). Because dexie is *inlined*, `resolve.alias`/`resolutions` on `dexie` alone can't fix it.

Fix (already in place — keep it): every app vite config (`vite.{mobile,extension,background,desktop}.config.ts`) sets `resolve.dedupe: ['dexie', '@miden-sdk/miden-sdk']` so only the single root SDK resolves (this also collapses the duplicate WASM `WebClient`), and `package.json` pins `dexie` + a `resolutions` entry to the web-sdk's inlined version. Debug tip: `var DEXIE_VERSION` is in the UMD `dist/dexie.js` (no guard); the guard lives in `import-wrapper.mjs`. To find a stray version, parse a built chunk's `.js.map` for `sourcesContent` containing `DEXIE_VERSION` — the `sources[]` path names the offending package. `grep -r` over node_modules misses it (binary-detected wasm-glue + symlinked file: deps); use `--binary-files=text` and the sourcemap. `build:ext`/`build:bg` don't `rimraf dist/` — wipe `dist/chrome_unpacked` before re-verifying or you'll read stale chunks.

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

## Frontend UI, CSS, and Motion

Read `skills/miden-wallet-frontend/SKILL.md` before implementing or reviewing wallet UI, CSS, motion, layout, or interaction changes. Reuse existing wallet components and semantic theme tokens before adding primitives or literal styles. Keep component-specific animation out of `src/main.css`; route nontrivial motion through Framer Motion and the reduced-motion-aware spring helpers. Interactive UI must use accessible semantics, appropriate haptics, localization, and platform isolation, then be verified on every affected surface.

### Mobile file downloads
`<a download>` does nothing in WebView. Use `Filesystem.writeFile` + `Share.share` from `@capacitor/{filesystem,share}` when `isMobile()`.

### Balance loading
`fetchBalances` reads IndexedDB via `getAccount()` (instant). `AutoSync` (1s interval) calls `syncState()` separately to update IndexedDB. Don't call `syncState()` from the UI path.

## Adding a wallet action

1. Message type in `src/lib/shared/types.ts`
2. Handler in `src/lib/miden/back/actions.ts`, register in `back/main.ts`
3. Store action in `src/lib/store/index.ts`
4. Expose via `useMidenContext()` in `src/lib/miden/front/client.ts`

## Transaction summary badge (Generating Transaction screen)

The in-progress transaction view (`src/screens/generating-transaction/GeneratingTransaction.tsx`) renders a dynamic one-line summary pill under the title — `src/screens/generating-transaction/TransactionSummaryBadge.tsx`.

**The page is addressed by transaction id and observes a single row.** The route is `/generating-transaction/:txId` (and `/generating-transaction-full/:txId` for the desktop `keepOpen` variant) — see `PageRouter.tsx`. Send (`ReviewTransaction.tsx`) and swap (`SwapManager.tsx`) capture the id returned synchronously by their `initiate*` call and `navigate` straight to it. `GeneratingTransactionPage` subscribes to **that one row** by id via `useTransactionRow(txId)` (a Dexie `liveQuery`, `useTransactionRow.ts`) and derives everything from its status: `transactionComplete = status is Completed|Failed`, `hasErrors = status === Failed`, hash = `row.transactionId`. An unknown id `<Redirect>`s home.

**Why this shape (history).** The page began as a modal that watched the *whole queue* (`getAllUncompletedTransactions()`) and had to *guess* which tx it was showing (`pickActiveTx`), infer completion from the queue going empty, and infer failure by counting failed rows. Those heuristics existed only because the row **drops out of the uncompleted list the instant it completes** — so the page needed shadow state (`receiptTransaction`) to re-find it. Watching by id fixes the root cause: the row never disappears (`Queued → GeneratingTransaction → Completed | Failed`), so status alone is authoritative and all that scaffolding is gone. The FIFO processing loop (`safeGenerateTransactionsLoop` in `src/lib/miden/transaction/index.ts`) and the page's own `setInterval` driver are **unchanged** — the page still kicks the loop on mobile/desktop and is a pure observer on extension (SW owns the loop). Observing one row and draining the FIFO queue are orthogonal: the driver is not scoped to `txId`. Hiding the page mid-tx is safe because the in-flight `generateTransaction` promise isn't cancelled by unmount.

**`send`, `swap`, `consume` and `earn-deposit` variants exist**: send renders `{amount} {symbol} → {recipient}`; swap renders `(logo) {amount} {symbol} → (logo) {amount} {symbol}`; consume renders `{amount} {symbol} → Consumed` (nothing when the consume has no amount); earn-deposit renders `{amount} {symbol} ↑ {market}` (up-arrow separator; market name = the `marketUid` lender key, hyphenated — e.g. "DUMMY-LENDING" — via the exported `earnMarketLabel`). The badge returns `null` for every other transaction type. Future agents should extend it per type. On the success receipt (`success/receipt.ts`), consume rows relabel: address row = "From" (note sender), amount row = "Total Consumed", plus a "Notes Consumed" row listing `noteIds`; the hash row is labeled "Transaction ID" for all types. Completed `earn-deposit` rows route to `EarnSuccess` ("You're Earning!": pill + Market / Total Deposited / Transaction ID rows, "View Details" → `/earn/positions`) via the type check in `TransactionSuccess.tsx`.

**Data source**: the tracked `ITransaction`, passed in as the `activeTransaction` prop (= the row from `useTransactionRow`). Fields populated per `ITransactionType` (see the `Transaction` subclasses in `src/lib/miden/db/types.ts`):
- `send` → `amount`, `faucetId` (token), `secondaryAccountId` = **recipient address**.
- `swap` → `amount`/`faucetId` = **offered** side; `extraInputs.requestedAmount`/`extraInputs.requestedFaucetId` = **requested** side. Symbol/decimals/logo for the fixed devnet DEX tokens resolve via `getSwapTokenByFaucetId` in `src/lib/miden/swap/tokens.ts` (the swap-token registry — source of truth, since these faucets may be absent from `assetsMetadata`).
- `consume` (claim) → `faucetId`, `secondaryAccountId` = **note sender**, `noteId`; `amount` optional.
- `execute` → usually nothing useful.
- `switch-guardian` → `extraInputs.newGuardianEndpoint`. `replace-hot-key` → `extraInputs.newHotPublicKey`. Neither has amount/token.

**Token symbol/logo**: `useWalletStore(s => s.assetsMetadata)[faucetId]` → `AssetMetadata` (`symbol`, `decimals`, `thumbnailUri`); native fallback `MIDEN_METADATA` (`lib/miden/metadata`). Miden network logo: `IconName.MidenLogo`. To add a variant, add a branch in `TransactionSummaryBadge`; keep returning `null` when there's no meaningful summary so no empty pill renders.

**Per-step timing ("2 sec" on each step row) is built, frontend-only.** `GeneratingTransaction` stamps `startTimeForStep`/`endTimeForStep` (arrays indexed by UI step) in a `useEffect` on `activeStage`: step 0 runs `creating-proposal`→`sending`, step 1 `sending`→`submitting`, step 2 `submitting`→first post-submit stage (`confirming`/`registering-guardian`/`delivering`, stamped once via `step3StartedRef`), and the last started step ends when `transactionComplete` flips (step timings key off `transactionComplete`, not the stage; completion additionally stamps `stage = 'complete'` in `updateTransactionStatus` — #618 — so `activeStage` CAN be `'complete'` on a finished row). Durations render via the `meta` prop on `TransactionStepRow` (right-aligned muted text, `transactionStepDurationSec` key). Deliberately NOT persisted on `ITransaction` — timings are component-local and reset on remount / next tx (the `creating-proposal` case resets both arrays).

**`bridged-receive` rows are supported via a separate phase-driven branch.** These rows are born `Completed` with their lifecycle in `extraInputs.phase` (`submitting|delivering|ready|received|failed`), so the page cannot derive progress from `ITransactionStatus`. `readBridgedReceiveMeta` (helper.ts) detects them and switches to a two-step ladder (`BRIDGED_RECEIVE_STEPS`: "Sending to Ethereum" for agglayer / "Submitting intent" for epoch, then "Bridging to Miden"); the page shows Done from `delivering` onward ("Funds are on the way — track in Activity") and suppresses the Miden receipt/explorer. The badge has a `bridged-receive` variant (`{sourceAmount} {sourceSymbol} (Ethereum) → Miden`). The deposit-address bridge flow (`app/templates/DepositBridge`) navigates here after initiating.

**Deferred — NOT built yet (the mock shows these, intentionally skipped):**
- **Bridged-send step labels** ("Submitting to Base", "via Epoch" on outbound sends). `IBridgedSendExtraInputs` is defined in `src/lib/miden/db/types.ts` but nothing populates it yet, and there's no chain-id→name map.

The redesigned in-progress view dropped the `ScreenHeader` and the linear progress bar; dismissal is via the bottom Hide/Done button.

## Navigation

Two systems:
- **Woozie** (`src/lib/woozie/`) — hash-based global router. `navigate`, `goBack`, `useLocation`, `<Link>`.
- **Navigator** (`src/components/Navigator.tsx`) — internal step flows (`SendManager`, `SwapManager`, `EncryptedFileManager`). `useNavigator()` → `{navigateTo, goBack, cardStack}`. The swap flow (`src/screens/swap-flow/`) mirrors send: amounts (two `SelectAmount` in `embedded` mode) → review, rendered at `/swap` in both `PageRouter` and `HomeSwipeContainer`; the token picker is a bottom-sheet drawer (`SelectSwapTokenDrawer`, like send's `SelectTokenDrawer`) closed first by SwapManager's mobile back handler.

Onboarding (`Welcome.tsx`) and `ForgotPassword.tsx` use hash-based state (`/#step-name`), NOT Navigator.

The in-progress transaction view is a routed full-screen page at `/generating-transaction/:txId` (desktop `keepOpen` variant: `/generating-transaction-full/:txId`). Send and swap `navigate` here with the id path param after initiating; it observes that one row to completion (see the Transaction summary badge section). `onClose` guards on `hash.includes('generating-transaction')`, so the substring must stay in any future route rename.

Send flow: only recipient → amount remain Navigator steps inside `/send`; the token and contact pickers are fixed-height bottom-sheet drawers (`SelectTokenDrawer`, `AccountsListDrawer`) closed first by SendManager's mobile back handler; the review step is a routed full-screen page (`/send/review?amount=…&to=…&tokenId=…`, `ReviewTransaction.tsx`) that owns the transaction pipeline. Backing out restores the form via `send-flow/send-draft.ts` (SendManager reopens on the Amount step). Hardware back on review is covered by `MobileBackBridge` (history pop).

Receive has a Miden | Cross-chain `TabPicker` (shown only when `isDepositAddressBridgeEnabled()` and the account has a derived `evmAddress`); the Cross-chain tab shows the EVM deposit address and opens the `DepositBridgeDrawer` (`app/templates/DepositBridge`, internal steps assets→amount→route, closes via Receive's `useMobileBackHandler`). Deep link: `/receive?tab=crosschain&bridge=1&token=ETH`. The `DepositArrivalDrawer` ("funds arrived") is mounted once in `TabLayout` and driven by `useDepositAddressStore.pendingDrawer` (`lib/deposit-bridge`, watcher mounted in `lib/miden/front/provider.tsx`).

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

**Keep it a hook flag, not a behaviour switch.** Suppressing real product behaviour under `MIDEN_E2E_TEST` makes that behaviour permanently untestable — it can't be reached from any E2E run. The two existing opt-outs have their own flags, set by the `test:e2e:*:build` scripts (and defined in each `vite.*.config.ts` — an env read that isn't `define`d throws at runtime, the extension bundle has no `process` global):
- `MIDEN_E2E_DISABLE_SIDEPANEL` — keeps onboarding in-tab (`lib/extension/side-panel-handoff.ts`); a suite that wants to drive the real side panel builds without it.
- `MIDEN_E2E_DISABLE_ENDPOINT_OVERRIDES` — makes `loadEndpointOverrides()` a no-op so the build-baked network wins (`lib/miden-chain/effective-endpoints.ts`).

## Testing

Jest + RTL. Mock `lib/intercom` for frontend tests; wrap with `WalletStoreProvider` + `MidenContextProvider`.

Gotchas:
- `jest.mock()` path must match the import path used in source (e.g., `'lib/miden/back/vault'`, not `'./vault'`).
- `window.location.reload` can't be mocked in jsdom — wrap calls in try/catch.
- `afterEach(() => testRoot.unmount())` to prevent React cross-test pollution.

## Code style

Prettier: 120 cols, single quotes, semicolons, trailing commas. Break long `console.log`s across lines. `yarn format` to fix.

No `any`, no `as`. Use concrete types.

## Linked Web SDK PR (cross-repo CI)

**ALWAYS use the `Web SDK PR: #N` marker when opening a wallet PR that
depends on an unpublished web-sdk change.** This is the load-bearing
machine-readable handle — prose like "Companion PR: web-sdk#N" or
"depends on …" does NOT trigger the linked-PR pipeline. Put the marker
on its own line in the PR description (top is fine, anywhere is fine).
When in doubt include both forms (`Web SDK PR: #N` and a prose mention)
but the marker has to be present verbatim.

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

## CI gotcha: a push to `main` does not always create its workflow runs

Seen 2026-08-14: merge commit `9b84c493b` landed on `main` and GitHub created
**no** push-triggered runs for it — 25 minutes later the commit had a single
check suite (the half-hourly `Linked web-sdk PR ready` cron) and nothing else.
Actions was healthy throughout (another branch got a full set of runs in the same
window), and none of these workflows use path filters — they are all a bare
`on: push: branches: [main]`.

This is worse than a red main: the branch *looks* fine because the newest runs
listed against it are the PREVIOUS commit's.

- **Check by SHA, not by branch.** `gh run list --branch main` answers "the most
  recent run per workflow on this branch", which silently reports a different
  commit. Use:
  `gh api "repos/0xMiden/wallet/actions/runs?head_sha=$(git rev-parse origin/main)"`
  and confirm `total_count` is non-zero.
- **Re-trigger without a new commit** where the workflow allows it:
  `gh workflow run <file>.yml --repo 0xMiden/wallet --ref main`.
  Dispatchable: `e2e-blockchain`, `e2e-android`, `e2e-bridge`, `e2e-bridge-in`,
  `e2e-resilience`. NOT dispatchable (push-only, so they need a fresh commit):
  `coverage-badge` (Badges), Build Production, CodeQL.

## Important Notes

- Commit messages: single-line, short. Never sign commits (no `Co-Authored-By`).
- Never `git push` without explicit request.
- Stay within requested scope — don't modify files beyond the task.
- Update `CHANGELOG.md` one-liner per PR/task (not per fix).
- When adding a new intercom message type, also update `src/lib/intercom/mobile-adapter.ts`.
- Optimistic updates: snapshot prev, apply, rollback on catch.
- Background auto-ops: use `startBackgroundTransactionProcessing` (polls 5s × 5min, no modal) instead of `openLoadingFullPage`.
- Transaction states (`ITransactionStatus`): Queued(0) → GeneratingTransaction(1) → Completed(2) / Failed(3).
- Frontend receives sanitized state via `toFront()`; sensitive data (vault, keys) stays backend-only.
