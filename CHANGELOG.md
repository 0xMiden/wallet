# Changelog

## 1.14.0 (TBD)

### Features

* [FEATURE][mobile] **Embedded dApp browser** for iOS and Android with multi-instance tabs, parked-dApp switcher tray, and native navbar overlay.
* [FEATURE][all] Migrated backend from `WasmWebClient` to the new `MidenClient` TypeScript API. All service-worker WASM access now goes through `MidenClientInterface` wrapping the high-level `MidenClient` surface.
* [FEATURE][all] Migrated frontend to `@miden-sdk/react` hooks (`useMiden`, `useSyncState`, `useAccount`, etc.), replacing manual sync and balance-polling logic.

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
