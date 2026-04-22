# Changelog

## 1.14.4 (TBD)

### Features

* [FEATURE][all] **Private key export & import.** Settings → Reveal Private Key now shows the hex-encoded auth secret for the current account (guarded by the existing password / biometric unlock). Import Account → Private Key accepts a hex secret plus optional name and rebuilds the account deterministically via `AccountBuilder` + `AccountComponent.createAuthComponentFromSecretKey`; the secret is persisted through the existing `keystore.insert` → `insertKeyCallback` path, so the reveal/sign pipeline treats imported accounts identically to HD-derived ones. Imported accounts are tagged `hdIndex: -1`. (#195)

### Fixes

* [FIX][extension] Content scripts (`contentScript.js`, `addToWindow.js`) are now built as standalone classic IIFE bundles instead of ES modules with code-split `chunks/*` imports. MV3 content scripts declared in `manifest.json` run as classic scripts, so the `import` statements at the top of the previous output silently failed to parse — no error on the extension card, no entry in DevTools → Sources → Content scripts, and `window.midenWallet` was never injected (dApps saw `WalletNotReadyError`). New `vite.contentScripts.config.ts` builds each entry separately with `format: 'iife'` + `inlineDynamicImports: true`, and stubs `lib/intercom/{mobile,desktop}-adapter` so the content-script bundle doesn't drag the wasm-bindgen SDK in via their transitive deps. Wired into `build:extension` / `build:chrome` / `build:firefox` / `build:safari` / `test:e2e:blockchain:build`.
* [FIX][all] Encrypted-wallet-file import now restores secret keys for every imported account, not just the first. The decrypted wallet payload carries the full `WalletAccount[]` (with `hdIndex` and `type` per account), and `Vault.spawnFromMidenClient` re-derives each auth key from the mnemonic and inserts it into the new keystore via `client.keystore.insert`. Previously the imported miden-client DB came over without keystore entries, so signing broke for any non-default account.
* [FIX][all] Encrypted wallet file export now includes wallet account metadata alongside the miden-client/wallet DB dumps, so import can preserve account names and HD indices instead of falling back to generic "Miden Account N" labels.
* [FIX][all] Encrypted-file password screen consolidates the hardware-vs-password branching around a single `hasHardwareProtector` check — hardware-only vaults skip password entry entirely, password-protected vaults keep the attempt/lockout flow.
* [FIX][all] Encrypted-wallet-file flow now filters imported accounts out of the exported payload and adds a red inline notice naming the count of omitted accounts, because the file format does not carry raw private keys. Restore (`Vault.spawnFromMidenClient`) silently skips miden-client accounts with no matching `WalletAccount` entry and any entry with `hdIndex < 0`, so a stray orphan no longer either aborts the restore or overwrites an imported account's real secret with a mnemonic-derived one under `m/44'/0'/0'/-1'`. (#195)
* [FIX][all] `ACCOUNT_NAME_PATTERN` in `app/defaults.tsx` is now anchored at both ends (`/^[^\s-].{0,15}$/`); the prior `/[^\s-].{0,16}$/` was missing the start anchor, which silently accepted names of ANY length because the regex engine could match any suffix. `EditAccountName` / `CreateAccount` / Import Account now all enforce the same 16-character ceiling. **Behaviour note:** existing wallets that have accounts named with 17+ characters (accepted by the old broken regex) will still DISPLAY those names fine, but the first attempt to rename one of those accounts will fail validation until the user shortens it to 16 characters or fewer. (#195)
* [FIX][all] `importAccount` now serializes through the unlock queue and re-reads the accounts list inside the serialized section, so two quick successive imports can't both pass the name-uniqueness check against stale data and lose one of the writes. Auto-generated default names (`Account N`) also walk forward past collisions instead of throwing when the user has manually renamed an earlier account to match the template. (#195)
* [FIX][all] Hex validation on private-key import rejects odd-length input and caps the input at 4 KiB (~1.6× the serialized Falcon-512 secret key size) before allocation, so a malformed or pathologically large paste — e.g. an accidentally-pasted seed phrase or encrypted-file body — fails fast with a clean `PublicError` instead of throwing inside `AuthSecretKey.deserialize` under the WASM lock. (#195)
* [FIX][all] Encrypted-wallet-file restore now fails fast with a clear `"Encrypted file contains no restorable accounts"` error instead of crashing on an unguarded `walletAccounts[0]!.publicKey` dereference when the file carries zero HD accounts (e.g. a wallet whose only account was imported and therefore filtered out on export). (#195)
* [FIX][all] Encrypted-wallet-file import mirrors the export-side warning: after successful decryption, if the file was exported with any imported accounts stripped, the restore screen now shows a red notice naming the omitted count and requires an explicit second "Continue Import" click before completing. Count is carried in a new optional `omittedImportedAccountCount` field on the decrypted payload; older files without the field restore silently as before. (#195)
* [FIX][all] Reveal Private Key flow is now gated by an "I understand this key cannot be rotated" checkbox in addition to the warning banner — the Continue button stays disabled until the user ticks it, turning a passive notice into an active acknowledgment. (#195)

---

## 1.14.3 (TBD)

### Features

* [FEATURE][all] Per-stage label in the transaction progress modal. Each observable phase boundary (`syncing`, `sending`, `confirming`, `delivering`) writes a stage marker during tx processing, and the modal renders a stage-specific title + description instead of a single opaque "Generating Transaction" for the whole 3-8s spinner window. Send-type sub-label varies by tx type (claim / execute / send), and the batch subtitle surfaces a remaining-count when more than one tx is in flight.

---

## 1.14.2 (TBD)

### Fixes

* [FIX][mobile] Switched all `@miden-sdk/miden-sdk` and `@miden-sdk/react` imports to the explicit `/lazy` subpath. Both SDKs' default entries (post-split) await WASM at module top level for ergonomic dApp use; Capacitor's `capacitor://localhost` scheme handler interacts poorly with that TLA and hangs the host WebView indefinitely (React tree never mounts). The `/lazy` entries omit the TLA, leaving readiness to `MidenProvider`'s existing `isReady` flag.
* [FIX][all] Gated page-side SDK WASM init. `fetchTokenMetadata` and `SendDetails` used to race the SDK's lazy wasm-bindgen load when constructing `Endpoint`/`RpcClient` directly on the page thread, hitting `Cannot read properties of undefined (reading '__wbindgen_malloc')` and blacklisting the token via `autoFetchMetadataFails` for the rest of the session. New `ensureSdkWasmReady()` helper actively triggers the SDK's `loadWasm()` via a Vite-aliased deep import and probes readiness, wired up before any page-side RPC construction. (#187)
* [FIX][all] `clearStorage` no longer tears down live Dexie handles. The spawn-time reset used to call `Repo.db.delete() + db.open()`, which fired a `versionchange` event to every other open handle (notably the page's), forced them closed, and triggered `DatabaseClosedError` on subsequent page-side reads. Now clears only the transactions table; a new `resetStorageDestructive()` preserves the full-wipe semantics for the options-page "Reset Wallet" button that actually wants it. (#187)

---

## 1.14.0 (TBD)

### Features

* [FIX][mobile] Fixed iOS release build by removing stale CocoaPods references, using correct workspace target, fixing ExportOptions team ID, and adding auto-versioning from `package.json`. (#172)
* [FEATURE][mobile] **Embedded dApp browser** for iOS and Android with multi-instance tabs, parked-dApp switcher tray, and native navbar overlay.
* [FEATURE][all] Migrated backend from `WasmWebClient` to the new `MidenClient` TypeScript API. All service-worker WASM access now goes through `MidenClientInterface` wrapping the high-level `MidenClient` surface.
* [FEATURE][all] Migrated frontend to `@miden-sdk/react` hooks (`useMiden`, `useSyncState`, `useAccount`, etc.), replacing manual sync and balance-polling logic.

### Fixes

* [FIX][all] Fixed duplicate consume-transaction entries in wallet history when receiving a single note. `initiateConsumeTransaction` now dedups against all non-`Failed` consume txs for the same note (including `Completed`), preventing auto-consume from re-enqueueing while `getConsumableNotes` is still returning the note during chain-sync lag. Also replaced the sync poll's blanket clear of `extensionClaimingNoteIds` with a surgical remove so Explore's `isBeingClaimed` gate works correctly. (#184)

---

## 1.13.3 (2026-03-19)

### Features

* [FEATURE][arch][all] Moved to service-worker-first architecture. The WASM client now lives exclusively in the Chrome extension service worker, with the frontend communicating via intercom messaging. Eliminates duplicate WASM instances and fixes concurrency panics.
* [FEATURE][all] Complete UI revamp with new design system, updated layouts, and refreshed components across all screens.

---

## 1.13.2 (2026-03-16)

### Features

* [FEATURE][extension] Chrome Side Panel mode with popup toggle. Users can switch between popup (default) and side panel via the maximize/minimize icon in the header. Preference persists across sessions. (#176)
* [FEATURE][extension] Pin extension prompt shown once after fresh install, guiding users to pin the extension to the toolbar. (#176)
* [FEATURE][all] Color-coded Send (blue) and Receive (green) action buttons on the home page, matching the token detail page. (#176)

### Fixes

* [FIX][extension] Fixed `onInstalled` event handler not firing on Chrome MV3 due to webpack async module loading delaying listener registration. Handler moved to `sw.js` for synchronous registration. (#176)
* [FIX][all] Fixed `ConsumingNote` page using raw UA sniffing instead of `isMobile()` platform detection. (#176)
* [FIX][all] Fixed transaction recovery after network outages. Private accounts could enter a permanently broken state where all transactions fail with "initial state commitment does not match". Root causes: AutoSync loop died on the generating-transaction page, transactions were built against stale local state, and the transaction modal blocked on stale tx failures. Now syncs state before executing transactions, keeps AutoSync alive during transaction generation, cancels crashed/stale transactions properly, and shows correct "Failed" status instead of misleading "Executing". (#150)
* [FIX][all] Removed stale "Download Generated Files" button and output notes storage. The `useExportNotes` hook, `registerOutputNote`, and related storage key were unused dead code. Simplifies the transaction completion screen and its auto-close logic. (#160)
* [FIX][all] Removed the "Upload File" button and drag-and-drop note import from the Receive page. The freed space is now used by the notes list, making it taller. (#161)
* [FEATURE][all] Complete UI revamp across the wallet.

---

## 1.13.1 (2026-02-16)

### Features

* [FEATURE][all] Token metadata now fetched via `RpcClient` instead of IndexedDB lookups, improving reliability and reducing stale metadata issues. (#127)

### Fixes

* [FIX][extension] dApp-initiated transactions (e.g. from wallet adapter) now process in the background instead of requiring the user to keep the popup open. Previously, closing the extension popup during a dApp transaction could cause it to fail silently. (#130)
* [FIX][all] Fixed Note Transport Layer (NTL) connection failures caused by incorrect default port configuration. Updated faucet address to use the new testnet faucet. (#125)

---

## 1.13.0 (2026-02-12)

### Breaking Changes

* [BREAKING][rename][all] Miden SDK package renamed from `@demox-labs/miden-sdk` to `@miden-sdk/miden-sdk` and upgraded to v0.13.0. All imports and wallet adapter references updated accordingly. (#101)

### Features

* [FEATURE][mobile] **Mobile app for iOS and Android** via Capacitor. Includes FaceID/TouchID biometric authentication, in-app dApp browser with wallet adapter injection, QR code scanning and display, native local notifications for incoming notes, haptic feedback throughout the UI, hardware back button and swipe-back gesture support, and native file sharing for exports. (#81)
* [FEATURE][desktop] **Desktop application using Tauri** for macOS and Windows. Features native window controls, Touch ID unlock on macOS, and secure storage via Tauri's stronghold plugin. (#86)
* [FEATURE][desktop] **dApp browser for desktop** with dedicated browser window that injects `window.midenWallet` API into web pages. dApps can request wallet connections and transaction approvals via an in-window confirmation overlay. (#89)
* [FEATURE][mobile,desktop] **Hardware-first vault key security.** On devices with Secure Enclave, TPM, or TEE, the wallet now uses hardware-only protection with no password required. Eliminates password brute-force attack surface on mobile and desktop. Browser extension continues to use password-based protection. (#88)
* [FEATURE][all] **Note Transport Layer (NTL) support.** Enables private note delivery between wallets using encrypted peer-to-peer transport, allowing users to send and receive notes without exposing transaction details on-chain. (#45)
* [FEATURE][all] **Runtime language switching** with Spanish and Polish support. Language can be changed instantly in Settings without page reload. Unified i18n system using i18next exclusively, replacing the legacy custom `T`/`t` components. Updated branding from Demox Labs to Miden across the app. (#74)
* [FEATURE][all] **Transaction completion tracking.** Added `waitForTransactionCompletion` using Dexie's `liveQuery` so the UI can reliably wait for transactions to finalize rather than just queuing them. (#50)
* [FEATURE][all] **Improved seed phrase verification** during onboarding. Users now verify the first and last words of their seed phrase (similar to Coinbase Wallet) instead of always the 10th word, which caused confusion when users hadn't scrolled far enough during backup. (#51)
* [FEATURE][all] **Receive page overhaul with "Claim All" button.** Users can claim all pending notes in a single action. Claiming state persists across popup reopens, and new notes arriving during a claim show the button again. Includes error handling with retry support. (#55)
* [FEATURE][all] **Improved balance sync UX.** Balances default to 0 immediately on page load instead of showing a skeleton loader. A shimmer animation indicates sync progress on each token row, disappearing after the first chain sync completes. (#65)
* [FEATURE][all] **Subtle header spinner** replaces the wave loading animation for balance syncing, providing a less intrusive loading indication. (#100)
* [FEATURE][all] **i18n enforcement in CI.** All user-facing strings are now required to use translation keys, enforced by a linting rule. Prevents hardcoded English strings from being introduced. (#71)

### Fixes

* [FIX][all] **WASM client concurrency fix.** Removed all `Promise.all` usage with the WASM client to prevent "recursive use of an object" panics when multiple operations (e.g. fetching metadata for 2+ new tokens simultaneously) tried to access the client concurrently. (#53)
* [FIX][all] Fixed non-MIDEN tokens appearing delayed after sync. Previously, `fetchBalances()` released the WASM lock between `getAccount()` and metadata fetches, allowing AutoSync to grab the lock for 30+ seconds. All WASM operations now happen in a single lock acquisition. (#98)
* [FIX][all] Wallet now syncs state to chain tip before creating the first account during onboarding, resulting in faster initial setup. (#99)
* [FIX][all] Fixed autosync lock interfering with balance display. Balances are now fetched immediately when wallet becomes Ready (moved from React `useEffect` to `syncFromBackend` in Zustand store), eliminating a ~200ms delay. (#84)
* [FIX][all] Fixed generating transaction page showing success icon and "transaction complete" text even when the transaction failed. Error state now displays correctly with appropriate messaging. (#48)
* [FIX][all] Fixed custom transactions (e.g. from dApp swaps) not appearing on the activity/history page. The issue was that custom transactions don't have the note tag attached to the address. (#70)
* [FIX][all] Fixed undefined note metadata causing errors when handling private notes with request metadata. (#73)
* [FIX][extension] Fixed onboarding flow reopening in a new tab when the popup was clicked while onboarding was already in progress. The extension now redirects to the existing onboarding tab instead. (#52)
* [FIX][extension] Replaced the tab-opening pattern with an in-popup modal for transaction progress, unifying the UX across mobile, desktop, and extension. (#87)
* [FIX][extension] Disabled all CSS transitions and animations in the Chrome extension to prevent visual glitches. Fixed `isExtension()` detection to check both `browser.runtime.id` and `chrome.runtime.id`. (#83)
* [FIX][extension] Fixed receive page content overflowing the popup viewport. (#47)
* [FIX][extension] Fixed settings page bottom toolbar being cut off. (#75)
* [FIX][all] Fixed form fields (send flow, encrypted file export, etc.) broken after the react-hook-form v7 migration. Updated all FormField components to use the new register/validation API. (#66)
* [FIX][all] Fixed stability issues on the Consuming Note page that could cause errors during note consumption.
* [FIX][desktop] Fixed Windows desktop app icon displaying incorrectly. The `icon.ico` file was a PNG renamed to `.ico`; converted to proper ICO format required by the Windows Resource Compiler. (#93)
* [FIX][all] Resolved 63 dependency security vulnerabilities (66 down to 3). Removed `react-dev-utils` (3 critical), `node-forge` (4 high), replaced `analytics-node` with `@segment/analytics-node`, and updated `@svgr/webpack`, `nanoid`, and `translate` to patched versions. (#96)
