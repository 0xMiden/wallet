# Repository Guidelines

## Project Structure & Module Organization

Miden Wallet ships as a Chrome/Firefox extension, iOS/Android app (Capacitor), and macOS app (Tauri). React + Zustand frontend; service-worker backend (Effector store + vault). The backend is the source of truth; the frontend syncs via intercom port messaging (`src/lib/intercom/`).

The main TypeScript/React application lives in `src/`. Put reusable UI in `src/components/`, screens and flows in `src/screens/`, app routing/providers in `src/app/`, and platform or domain logic in `src/lib/`:

- `lib/store/` — Zustand (frontend)
- `lib/miden/{back,front,sdk,psm}` — wallet core
- `lib/miden/transaction/` — tx pipeline: initiate/complete/get/cancel/helper; index = `generateTransaction` + loop (re-exported via `miden/activity`)
- `lib/platform/` — `isMobile`/`isIOS`/`isAndroid`/`isExtension`
- `lib/mobile/` — haptics, back-handler
- `lib/woozie/` — hash-based router (`navigate`, `goBack`, `useLocation`, `<Link>`)
- `lib/shared/types.ts` — message types

Entry points such as `popup.tsx`, `mobile-app.tsx`, and `desktop-app.tsx` assemble each target. Browser tests are in `playwright/tests/`; blockchain, stress, iOS, and Android suites are under `playwright/e2e/`. Native shells live in `ios/`, `android/`, and `src-tauri/`; Capacitor plugins are in `packages/`. Static images and fonts belong in `src/assets/`, `public/`, `screenshots/`, and `fonts/` as appropriate.

## Build, Test, and Development Commands

Use Node 22+ and Yarn v1. Copy `.env.example` to `.env`, then run `yarn install`.

- `yarn dev` rebuilds the Chrome extension in watch mode; load `dist/chrome_unpacked/` in Chrome.
- `yarn build:devnet` — network-specific extension build.
- `yarn build:chrome`, `yarn build:mobile`, and `yarn desktop:build` produce platform builds.
- `yarn mobile:ios:run[:devnet]` (iPhone 17 simulator default), `yarn mobile:android`, `yarn tauri dev`.
- `yarn test` runs Jest; `yarn test:coverage` enforces coverage thresholds.
- `yarn test:e2e` runs the basic Playwright extension suite serially; `yarn test:e2e:blockchain:{testnet,devnet,localhost}` and `yarn test:e2e:mobile:{devnet,testnet}` run live-network suites.
- `yarn ts` type-checks; `yarn lint` runs ESLint; `yarn format` applies Prettier. Run lint/format only before committing or when asked — not on every build.
- There is no Storybook: the Vite migration left the `storybook` / `build:storybook` scripts behind but no `.storybook/` config and no `*.stories.*` file, so both exit with `SB_CORE-SERVER_0006 (MainFileMissingError)`. `yarn build-all` (`run-s build:*`, fail-fast) therefore aborts at `build:storybook` and never reaches `build:desktop` — build the platforms you need explicitly (`yarn build:chrome`, `yarn build:mobile`, `yarn desktop:build`).

### Version bumps

The extension manifest version comes from `package.json`, NOT `public/manifest.json` (webpack overrides it at `webpack.public.config.js:69-70`). Update **both** to keep them in sync, then `rm -rf node_modules/.cache/webpack dist/` if the old version sticks.

## Critical Gotchas

- **WASM client concurrency**: the Miden WASM client is single-threaded; concurrent calls throw `recursive use of an object ... unsafe aliasing`. Always wrap calls in `withWasmClientLock` from `lib/miden/sdk/miden-client`. The lock self-recovers from a wedged holder (issue #775): a realm error/rejection listener evicts a trapped holder in milliseconds, a 5-minute watchdog bounds any other silent wedge, and both reject the holder with `WasmClientPoisonedError` and replace the client singleton. Bracket a legitimately unbounded in-hold wait (user sign, local prove) in `withWasmLockWatchdogPaused`, which relaxes the ceiling rather than stopping the clock. **An evicted operation is abandoned, not cancelled** — it keeps running and can still submit, so treat `WasmClientPoisonedError` like `OperationAbortedError` in kill classifiers and never route it onto a path that requeues a row as a fresh write. See the `CLAUDE.md` section of the same name for the full contract.
- **Duplicate dexie / duplicate `@miden-sdk/miden-sdk`**: the root web-sdk and the nested copy under `@openzeppelin/miden-multisig-client` each inline their own dexie into their wasm-glue chunk; two inlined dexies trip dexie's global guard at runtime (SW fails to register; mobile/desktop crash). The fix is already in place — every app vite config sets `resolve.dedupe: ['dexie', '@miden-sdk/miden-sdk']` and `package.json` pins/resolves `dexie` to the web-sdk's inlined version. Keep it. To hunt a stray version, parse a built chunk's `.js.map` for `DEXIE_VERSION` (plain `grep -r` over node_modules misses it), and wipe `dist/chrome_unpacked` before re-verifying — `build:ext`/`build:bg` don't rimraf `dist/`.
- **Tailwind auto-flipping tokens**: `text-black`, `bg-white`, `bg-gray-25/50/100`, `text-heading-gray` map to CSS vars that flip with theme — do NOT add `dark:` variants on them. Add `dark:` only on fixed-palette colors (`grey.*`, `pure-white`, `pure-black`) or SVG `fill={...}` props.
- **i18n required**: all user-facing text via `t('key')` or `<T id="key" />`; CI blocks raw strings (`yarn lint:i18n`). New keys go in `public/_locales/en/en.json` (flat); placeholders use `$name$`.
- **Platform isolation**: wrap platform-specific fixes with `isIOS()`/`isAndroid()`/`isMobile()` from `lib/platform` — never apply iOS fixes globally.
- **Haptics**: tappable components get `hapticLight()` (taps), `hapticMedium()` (toggles), `hapticSelection()` (tabs) from `lib/mobile/haptics`.
- **Mobile file downloads**: `<a download>` does nothing in a WebView — use `Filesystem.writeFile` + `Share.share` from `@capacitor/{filesystem,share}` when `isMobile()`.
- **Balance loading**: `fetchBalances` reads IndexedDB via `getAccount()` (instant); `AutoSync` calls `syncState()` separately. Never call `syncState()` from the UI path.
- **Transaction states** (`ITransactionStatus`): Queued(0) → GeneratingTransaction(1) → Completed(2) / Failed(3).
- **Optimistic updates**: snapshot previous state, apply, roll back on catch.
- **Background auto-ops**: use `startBackgroundTransactionProcessing` (polls 5s × 5min, no modal), not `openLoadingFullPage`.
- **Sanitized frontend state**: the frontend receives state via `toFront()`; vault/keys stay backend-only.

## Frontend UI, CSS, and Motion

Read `skills/miden-wallet-frontend/SKILL.md` before implementing or reviewing wallet UI, CSS, motion, layout, or interaction changes. Reuse existing wallet components and semantic theme tokens before adding primitives or literal styles. Keep component-specific animation out of `src/main.css`; route nontrivial motion through Framer Motion and the reduced-motion-aware spring helpers. Interactive UI must use accessible semantics, appropriate haptics, localization, and platform isolation, then be verified on every affected surface.

## Adding a Wallet Action

1. Message type in `src/lib/shared/types.ts`
2. Handler in `src/lib/miden/back/actions.ts`, registered in `back/main.ts`
3. Store action in `src/lib/store/index.ts`
4. Expose via `useMidenContext()` in `src/lib/miden/front/client.ts`
5. When adding a new intercom message type, also update `src/lib/intercom/mobile-adapter.ts`.

## Navigation

Two systems:

- **Woozie** (`src/lib/woozie/`) — hash-based global router.
- **Navigator** (`src/components/Navigator.tsx`) — internal step flows (`SendManager`, `SwapManager`, `EncryptedFileManager`) via `useNavigator()`.

Onboarding (`Welcome.tsx`) and `ForgotPassword.tsx` use hash-based state (`/#step-name`), not Navigator. The in-progress transaction view is a routed page at `/generating-transaction/:txId` (desktop `keepOpen`: `/generating-transaction-full/:txId`) that observes its single tx row by id via a Dexie `liveQuery`; `onClose` guards on `hash.includes('generating-transaction')`, so keep that substring in any route rename. Send review is a routed page (`/send/review?...`); token/contact pickers are bottom-sheet drawers closed first by the flow's mobile back handler.

Back handlers (`src/app/env.ts`): `registerBackHandler` is stack-based. Mobile hardware/swipe back needs explicit handlers for global nav (`MobileBackBridge`), Navigator flows, state-based flows, and modals. When adding screens/routes, keep back handling correct.

## Mobile & Desktop Notes

- iOS `console.log` is invisible to CLI tooling — use `xcrun simctl spawn booted log stream --predicate 'process == "App"'`, and verify UI fixes with `xcrun simctl io booted screenshot`.
- Grey bar at the bottom on iOS → `100dvh` misses safe areas; use `100%` + `env(safe-area-inset-*)` padding on the `mobile.html` body.
- New Swift files must be registered in four `project.pbxproj` sections (`PBXBuildFile`, `PBXFileReference`, App `PBXGroup`, `PBXSourcesBuildPhase`) — the App target does not auto-discover them.
- Custom Capacitor plugins (iOS) use **manual** registration: also call `bridge?.registerPluginInstance(MyPlugin())` in `capacitorDidLoad()` (`AppViewController.swift`), or JS calls return `{"code":"UNIMPLEMENTED"}`.
- New Capacitor plugins: `yarn add @capacitor/<name> && yarn mobile:sync`, plus a ProGuard `-keep` rule in `android/app/proguard-rules.pro`.
- Mobile bottom nav is a native overlay (iOS `UIWindow`, Android `NavbarOverlayManager`), wired in `src/app/providers/DappBrowserProvider.tsx`.
- Desktop (Tauri): clear state with `rm -rf ~/Library/WebKit/{com.miden.wallet,miden-wallet}`; dApp requests round-trip via base64-encoded `https://miden-wallet-request/{payload}` URL interception.

## Testing Guidelines

Co-locate Jest/React Testing Library tests as `*.test.ts` or `*.test.tsx`. Name Playwright scenarios `*.spec.ts`. Add regression tests for behavior changes and mock platform boundaries rather than live services in unit tests — mock `lib/intercom` for frontend tests and wrap with `WalletStoreProvider` + `MidenContextProvider`. Global Jest coverage must remain at least 95% for branches, functions, lines, and statements.

Gotchas:

- `jest.mock()` paths must match the import path used in source (e.g., `'lib/miden/back/vault'`, not `'./vault'`).
- `window.location.reload` can't be mocked in jsdom — wrap calls in try/catch.
- `afterEach(() => testRoot.unmount())` to prevent React cross-test pollution.

E2E: `MIDEN_E2E_TEST=true` exposes `window.__TEST_STORE__` and `window.__TEST_INTERCOM__` (zero production impact). The blockchain harness runs against a live network — use the `:<network>` scripts so harness endpoints and the bundled `MIDEN_NETWORK` stay matched.

## Coding Style & Naming Conventions

TypeScript is strict. No `any`, no `as` — use explicit domain types, and preserve the configured absolute imports (`app/...`, `lib/...`, `shared/...`). Prettier: 120-column width, two-space indentation, single quotes, semicolons, trailing commas. ESLint enforces formatting and ordered imports. Name React components and files in `PascalCase`, hooks as `useSomething`, and utilities in `camelCase` or established kebab-case modules. `yarn format` to fix.

## Commit & Pull Request Guidelines

- Commit messages: single-line, short, imperative. Never sign commits (no `Co-Authored-By`).
- Never `git push` without explicit request.
- Stay within requested scope — don't modify files beyond the task.
- Update `CHANGELOG.md` with one entry per PR/task (not per fix). Never add an entry under a version that's already been published — check `gh api repos/0xMiden/wallet/releases/latest` and use a strictly-higher `(TBD)` section (add one if missing); don't trust the file header alone.
- PRs should explain the user impact, testing performed, and relevant issue; include screenshots or recordings for UI changes. Call out platform-specific effects and configuration changes. Never commit secrets from `.env` or machine-local dependency paths.
- If the wallet PR depends on an unpublished web-sdk change, put the verbatim marker `Web SDK PR: #N` (or `Web SDK PR: 0xMiden/web-sdk#N`) on its own line in the PR description — prose mentions do NOT trigger the linked-PR CI pipeline. Local parity: `scripts/dev-with-web-sdk-pr.sh [N|--clear]`.
