# CLAUDE.md

This file provides guidance for Claude Code when working on this repository.

**Self-maintaining document:** Proactively update this file when you learn something worth remembering - new patterns, gotchas, debugging techniques, or project-specific knowledge. Don't wait to be asked.

## Project Overview

Miden Wallet is a browser extension wallet for the Miden blockchain, also available as a mobile app for iOS and Android. The browser version is built as a Chrome/Firefox extension with a React frontend and a service worker backend. The mobile app uses Capacitor to wrap the web app in a native shell.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Browser Extension                     │
├─────────────────────────┬───────────────────────────────┤
│   Frontend (Popup/Tab)  │   Backend (Service Worker)    │
│                         │                               │
│   React + Zustand       │   Effector Store              │
│   - UI Components       │   - Vault (secure storage)    │
│   - State management    │   - Wallet operations         │
│                         │                               │
│         ◄──── Intercom (Port messaging) ────►           │
└─────────────────────────┴───────────────────────────────┘
```

**Key principle:** Backend is the source of truth. Frontend syncs via intercom messaging.

## Key Directories

```
src/
├── lib/
│   ├── store/           # Zustand store (frontend state)
│   ├── miden/
│   │   ├── back/        # Backend: Effector store, vault, actions
│   │   ├── front/       # Frontend: hooks, providers, client
│   │   └── sdk/         # Miden SDK integration
│   ├── intercom/        # Port-based messaging between frontend/backend
│   └── shared/types.ts  # Shared type definitions
├── app/                 # React app entry, pages, templates
├── screens/             # Screen components (onboarding, send, etc.)
└── workers/             # Background service worker entry
```

## Key Modules

Quick reference for commonly needed utilities:

| Module | Path | Exports |
|--------|------|---------|
| Platform detection | `lib/platform` | `isMobile()`, `isIOS()`, `isAndroid()`, `isExtension()` |
| Haptic feedback | `lib/mobile/haptics` | `hapticLight()`, `hapticMedium()`, `hapticSelection()` |
| Mobile back handler | `lib/mobile/back-handler` | `initMobileBackHandler()`, `useMobileBackHandler()` |
| Navigation (Woozie) | `lib/woozie` | `navigate()`, `goBack()`, `useLocation()`, `<Link>` |
| App environment | `app/env` | `useAppEnv()`, `registerBackHandler()`, `onBack()` |

## Commands

```bash
yarn install          # Install dependencies
yarn build            # Build extension (outputs to dist/)
yarn dev              # Development build with watch
yarn test             # Run Jest tests
yarn lint             # ESLint
yarn format           # Prettier
```

**IMPORTANT:** Always run `yarn lint` and `yarn format` before `yarn build`. The build will fail on lint/prettier errors.

## Mobile Development

**IMPORTANT:** Always use these yarn scripts for mobile development. Do not run Capacitor or Xcode commands directly.

**IMPORTANT:** When testing mobile changes, always build and run the simulator yourself. Never tell the user to build/test changes themselves - do it for them.

**iOS Simulator:** Always use **iPhone 17** as the default simulator for testing.

**Node version:** Capacitor CLI requires Node >= 22. Use nvm to switch:
```bash
source ~/.nvm/nvm.sh && nvm use 22 && yarn mobile:ios:run
# or for Android:
source ~/.nvm/nvm.sh && nvm use 22 && yarn mobile:android
```

### iOS

```bash
yarn mobile:ios                  # Build, sync, and open in Xcode
yarn mobile:ios:run              # Build and run on iOS Simulator (default network)
yarn mobile:ios:run:devnet       # Same but explicitly targets devnet
yarn mobile:ios:build            # Build for iOS Simulator only
yarn mobile:ios:build:devnet     # Same, devnet
yarn mobile:ios:faceid           # Fix FaceID enrollment on simulator
```

`MIDEN_NETWORK` is baked into the bundle at compile time, so network selection happens at build, not runtime. The `:devnet` variants just set `MIDEN_NETWORK=devnet` for you.

### Android

```bash
yarn mobile:android              # Build, sync, and open in Android Studio
yarn mobile:android:fingerprint  # Trigger fingerprint auth on emulator
```

### Build Only

```bash
yarn build:mobile         # Production build for mobile (outputs to dist/mobile/)
yarn build:mobile:dev     # Development build for mobile
yarn mobile:sync          # Build and sync with Capacitor (no IDE open)
```

### Release Builds

```bash
# Android
yarn mobile:android:keystore     # Generate release keystore (one-time)
yarn mobile:android:release      # Build AAB for Play Store
yarn mobile:android:release:apk  # Build APK for direct distribution

# iOS
yarn mobile:ios:release          # Build release archive
yarn mobile:ios:export           # Export IPA for App Store
```

See `STORE_LISTING.md` for full app store submission checklist and instructions.

### Build Output Locations

**Android APKs/AABs** are output to `android/app/build/outputs/`:
```
android/app/build/outputs/
├── apk/
│   ├── debug/app-debug.apk       # Debug APK (yarn mobile:sync && cd android && ./gradlew assembleDebug)
│   └── release/app-release.apk   # Release APK (yarn mobile:android:release:apk)
└── bundle/
    └── release/app-release.aab   # Release AAB (yarn mobile:android:release)
```

**iOS archives** are output to `ios/App/build/`:
```
ios/App/build/
├── MidenWallet.xcarchive         # Release archive (yarn mobile:ios:release)
└── export/                       # Exported IPA (yarn mobile:ios:export)
```

### Workflow

1. Make code changes in `src/`
2. Run `yarn mobile:ios:run` to build and test on iOS Simulator
3. Or run `yarn mobile:ios` to open in Xcode for debugging

The mobile app shares the same React codebase as the browser extension. Mobile-specific code uses `isMobile()` checks from `lib/platform`.

### Skip Onboarding (Mobile Testing)

To skip the entire onboarding UI (seed phrase, verification, password) and jump directly to the "Your wallet is ready → Get started" screen, use one of these methods:

**Method 1: URL parameter** — After the app launches on the welcome screen, navigate via CDP:
```bash
node /tmp/cdp-eval 'window.location.search = "?__test_skip_onboarding=1"'
```

**Method 2: JS global** — Set the global before the component mounts:
```bash
node /tmp/cdp-eval 'window.__TEST_SKIP_ONBOARDING = true; window.location.reload()'
```

Both methods auto-generate a random seed phrase, set password to `password1`, and navigate to the confirmation screen. From there, tapping "Get started" (or triggering it via CDP) runs `registerWallet()` which initializes the WASM Worker and creates the wallet.

To also auto-trigger "Get started" (full end-to-end skip):
```bash
# Wait a moment for the confirmation screen to render, then click
node /tmp/cdp-eval 'document.querySelector("button")?.click(); "clicked"'
```

The bypass is in `src/app/pages/Welcome.tsx`. It only activates when `__test_skip_onboarding=1` is in the URL or `window.__TEST_SKIP_ONBOARDING` is set — zero impact on production.

### Platform-Specific Changes

**CRITICAL:** This app builds for three platforms: Chrome extension, iOS, and Android. When fixing bugs or adding features:

1. **Isolate platform-specific fixes** - If a bug only affects iOS, wrap the fix with platform detection (e.g., `if (isIOS()) { ... }`). Don't apply iOS fixes globally unless they genuinely apply to all platforms.
2. **Test across platforms** - Changes to shared code can break other platforms unexpectedly.
3. **Use platform detection** - `isMobile()`, `isIOS()`, `isAndroid()` from `lib/platform` for conditional logic.

### Haptic Feedback

**IMPORTANT:** When adding new tappable components (buttons, links, toggles, list items, etc.), always add haptic feedback for mobile users.

```typescript
import { hapticLight, hapticMedium, hapticSelection } from 'lib/mobile/haptics';

// Use hapticLight() for button taps, navigation links, card clicks
// Use hapticMedium() for toggles, checkboxes, radio buttons
// Use hapticSelection() for tab changes, footer navigation
```

The haptic functions automatically check `isMobile()` and the user's haptic feedback setting - no need to wrap in conditionals.

Components that already have haptics (for reference):
- `components/Button.tsx`, `app/atoms/Button.tsx` - buttons
- `lib/woozie/Link.tsx` - navigation links
- `components/Toggle.tsx`, `app/atoms/ToggleSwitch.tsx` - toggles
- `components/TabBar.tsx`, `app/atoms/TabSwitcher.tsx` - tabs
- `components/FooterIconWrapper.tsx` - footer navigation
- `components/CardItem.tsx`, `components/ListItem.tsx` - tappable items
- `components/Chip.tsx`, `components/CircleButton.tsx` - misc buttons
- `app/atoms/Checkbox.tsx`, `components/RadioButton.tsx` - form controls

### Known iOS-Specific Issues

- **WASM/WebWorker behavior** - iOS Safari has different WebWorker/WASM memory handling than Android/Chrome
- **IndexedDB quirks** - Safari's IndexedDB implementation has known limitations (e.g., doesn't work in private browsing, stricter storage quotas)
- **Memory pressure** - iOS is more aggressive about limiting memory; watch for OOM issues with multiple WASM worker instances

### File Downloads on Mobile

**The standard web download approach does NOT work on mobile:**
```typescript
// This works on desktop but NOT on iOS/Android WebView
const a = document.createElement('a');
a.href = URL.createObjectURL(blob);
a.download = 'file.json';
a.click();  // Does nothing on mobile!
```

**Use Capacitor Filesystem + Share plugins instead:**
```typescript
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { isMobile } from 'lib/platform';

if (isMobile()) {
  // Write to cache, then share
  const result = await Filesystem.writeFile({
    path: 'file.json',
    data: fileContent,
    directory: Directory.Cache,
    encoding: Encoding.UTF8
  });
  await Share.share({ url: result.uri });
} else {
  // Standard web download for desktop
}
```

### Adding/Removing Capacitor Plugins

When **adding** new Capacitor plugins:

1. Install: `yarn add @capacitor/plugin-name`
2. Sync: `yarn mobile:sync` (updates iOS and Android native projects)
3. **Add ProGuard rules** for Android release builds in `android/app/proguard-rules.pro`:
   ```
   -keep class com.capacitorjs.plugins.pluginname.** { *; }
   ```
4. Check if iOS needs Info.plist permissions (most plugins document this)

When **removing** Capacitor plugins:

1. Uninstall: `yarn remove @capacitor/plugin-name`
2. Sync: `yarn mobile:sync` (updates iOS and Android native projects)
3. **Remove ProGuard rules** from `android/app/proguard-rules.pro` for the removed plugin

### Native Navbar Overlay (iOS + Android)

The mobile wallet hides the React footer and renders its bottom nav as a native floating pill on both iOS and Android. The pill has a main row (Home / Activity / Browser), an optional secondary row (Send / Receive / Settings), and a compact mode with a primary action button (e.g. Continue in the Send flow).

**iOS**: `MidenNavbarOverlayWindow` in `packages/dapp-browser/ios/Sources/InAppBrowserPlugin/WKWebViewController.swift` — a dedicated `UIWindow` at `.normal + 200` that sits above the Capacitor host window AND every dApp WKWebView window. UIWindow z-order is automatic.

**Android**: `packages/dapp-browser/android/src/main/java/ee/forgr/capacitor_inappbrowser/navbar/` — a two-instance architecture:
- `NavbarState` + `NavbarStateHolder` — immutable state + observer pattern
- `NavbarOverlayManager` — coordinator that lazily creates the Activity-scoped `NavbarView`, spawns a fresh Dialog-scoped `NavbarView` when a `WebViewDialog` shows (via `OnShowListener`), and detaches it on dismiss. Arbitrates which instance is visible via a simple stack-top rule.
- `NavbarView` — the actual FrameLayout hierarchy: shadowWrap → blurContainer → outerVStack → [secondaryRow, contentStack[navStack, actionButton]]
- `NavbarButton`, `NavbarSecondaryButton`, `NavbarActionButton` — individual button views with platform-matched styling

**Why two instances on Android**: Android sub-windows (`TYPE_APPLICATION_PANEL`) stack with their parent window's token, so a view attached to the Activity would be covered by a Dialog. Instead of fighting z-order, we give the Activity one navbar view and each WebViewDialog its own, both observing the same state holder. Exactly one instance is visible at any time, picked by which window is frontmost.

**Plugin methods** (iOS + Android, same signatures):
- `showNativeNavbar({items, activeId})` — show pill with 3 main-row items
- `hideNativeNavbar()` — hide pill entirely
- `setNativeNavbarActive({id})` — update active main-row pill without rebuild
- `setNavbarSecondaryRow({items, activeId})` — populate or clear secondary row; empty items collapses the row via spring animation
- `setNavbarAction({label, enabled})` — enter compact mode with a primary action pill
- `clearNavbarAction()` — exit compact mode, restore default nav row layout
- `morphNavbarOut()` / `morphNavbarIn()` — slide pill off-screen for drawer presentations

**Events** (JS listens via `InAppBrowser.addListener`):
- `nativeNavbarTap` → `{id}` when a main-row button is tapped
- `nativeNavbarSecondaryTap` → `{id}` when a secondary-row button is tapped
- `nativeNavbarActionTap` → `{}` when the compact-mode action button is tapped

**Wallet JS wiring** lives in `src/app/providers/DappBrowserProvider.tsx` — two effects watching `location.pathname` drive the main and secondary rows; a third watches the confirmation store for drawer morph-out.

**Gotchas**:
- `MATCH_PARENT` children in `WRAP_CONTENT` FrameLayouts inflate the parent to ancestor AT_MOST. Use background drawables instead of child views for active-state pills (learned the hard way — `NavbarButton` used to do this and produced 1878px-tall buttons). See commit `64145d74` in the navbar checkin.
- `NavbarButton` is pinned to 60dp via `setMinimumHeight` so compact mode can't grow the toolbar. Also mirrored on iOS as `NavbarButton.buttonHeight = 60`.
- On Android, `Dialog.getWindow().setLayout(MATCH_PARENT, MATCH_PARENT)` must be called AFTER `setContentView()`. Otherwise the default `wrap_content` wins and the Dialog is a tiny centered blob.
- Android's `setRenderEffect(createBlurEffect(...))` blurs the view's own content, NOT what's behind it. There's no clean backdrop blur primitive for a decor-view child. We use a solid translucent pill and accept the platform difference.
- Shadow elevation must be on the view with the background drawable (blurContainer), not a wrapper without an outline — or the shadow just doesn't render.

### Debugging iOS Issues

**Debug UI components:** When adding debug panels to the UI, ensure all text is **selectable** (use `select-text` or `user-select: text`) so the user can copy/paste error messages instead of retyping them.

**IMPORTANT:** Do NOT use `console.log` for iOS debugging - those logs go to Safari Web Inspector which Claude Code cannot access.

**Instead, use native iOS logging that can be read via CLI:**
```bash
# Stream logs from running simulator (filter for webkit/app logs)
xcrun simctl spawn booted log stream --predicate 'process == "App"' --level debug

# Or capture to file for later analysis
xcrun simctl spawn booted log stream --predicate 'process == "App"' > ios_logs.txt &
```

**For JavaScript code, use Capacitor's native logging or write to a debug file** that can be read from the simulator's file system.

**Alternative: Safari Web Inspector (manual, last resort):**
1. Run the app in simulator: `yarn mobile:ios:run`
2. Open Safari on Mac → Develop menu → Simulator → select the app
3. Console tab shows JavaScript logs

### CDP Bridge for iOS WebView Debugging

Use the `inspect` CLI (`@inspectdotdev/cli`) + a persistent-connection daemon to evaluate JavaScript in the Capacitor WKWebView from Claude Code. This gives you access to DOM, computed styles, console output, and error state — much more powerful than screenshots alone.

**Known issue:** The inspect bridge has a single-use bug — after a WebSocket client disconnects, subsequent connections get no responses. The workaround is a persistent-connection daemon that holds ONE WebSocket open and routes all requests through it.

**Bringup recipe (run once per session):**

```bash
# 1. Kill old bridges and free ports
pkill -9 -f "inspect" 2>/dev/null
pkill -9 -f "cdp-daemon" 2>/dev/null
lsof -ti:9221,9222,9333 | xargs kill -9 2>/dev/null

# 2. Reset webinspectord
xcrun simctl spawn booted launchctl kill 9 user/501/com.apple.webinspectord

# 3. Relaunch the app (re-registers WebView with fresh webinspectord)
xcrun simctl terminate booted com.miden.wallet
xcrun simctl launch booted com.miden.wallet
sleep 2

# 4. Start inspect bridge (wait ~5s for it to discover devices)
source ~/.nvm/nvm.sh && nvm use 22
nohup inspect --no-telemetry > /tmp/inspect.log 2>&1 &
sleep 5

# 5. Start CDP daemon (holds persistent WS, routes evals through it)
nohup node /tmp/cdp-daemon.mjs > /tmp/cdp-daemon.log 2>&1 &
sleep 3

# 6. Smoke test — should print "2"
node /tmp/cdp-eval '1+1'
```

**Usage after bringup:**
```bash
# Evaluate any JS in the WebView
node /tmp/cdp-eval 'document.title'
node /tmp/cdp-eval 'JSON.stringify(window.__cdp_errors)'

# Set up an error trap to catch async failures
node /tmp/cdp-eval 'window.__cdp_errors = []; window.addEventListener("error", e => window.__cdp_errors.push(e.message)); window.addEventListener("unhandledrejection", e => window.__cdp_errors.push("REJECTION: " + (e.reason?.message || e.reason))); "trap set"'
```

**Recovery when it stops working:**
- Smoke test fails → restart from step 2 (webinspectord reset)
- Bridge sees `[]` on `/json` → restart from step 3 (app crashed)
- After `yarn mobile:ios:run` rebuild → restart from step 4 (PID changed)
- Nothing works → quit Simulator.app entirely (`osascript -e 'tell application "Simulator" to quit'`), cold-boot, restart from step 1

**Files:** `/tmp/cdp-daemon.mjs` (persistent WS daemon), `/tmp/cdp-eval` (one-shot client). If missing, recreate from the memory file at `~/.claude/projects/-Users-celrisen-miden-miden-wallet/memory/cdp-bridge-single-use-bug.md`.

### Verifying Mobile UI Fixes

**IMPORTANT:** When fixing mobile UI issues (layout, spacing, safe areas, etc.), always verify the fix by taking screenshots from the simulator and analyzing them visually. Do not rely solely on code inspection.

**Workflow for UI fixes:**
1. Build and run on simulator: `yarn mobile:ios:run`
2. Take a screenshot: `xcrun simctl io booted screenshot /tmp/screenshot.png`
3. Read the screenshot file to visually verify the fix
4. If authentication is needed, trigger FaceID: `xcrun simctl spawn booted notifyutil -p com.apple.BiometricKit_Sim.fingerTouch.match`
5. Wait briefly and take another screenshot: `sleep 2 && xcrun simctl io booted screenshot /tmp/screenshot2.png`

**Example verification flow:**
```bash
# Build and launch
source ~/.nvm/nvm.sh && nvm use 22 && yarn mobile:ios:run

# Take screenshot after app loads
xcrun simctl io booted screenshot /tmp/ios-test.png

# Authenticate if needed (for locked wallet)
xcrun simctl spawn booted notifyutil -p com.apple.BiometricKit_Sim.fingerTouch.match

# Wait and capture main screen
sleep 2 && xcrun simctl io booted screenshot /tmp/ios-main.png
```

**Common iOS layout issues and fixes:**
- **Grey bar at bottom:** Usually caused by `100dvh` height not accounting for safe areas. Use `100%` instead and ensure `mobile.html` body has proper safe area padding.
- **Content cut off:** Check if containers have `overflow: hidden` without proper height constraints.
- **Safe area gaps:** Ensure `public/mobile.html` has `padding: env(safe-area-inset-*)` on body, and body background color matches app background (white).

## Tailwind theme tokens

**CRITICAL:** In `tailwind.config.ts`, many Tailwind color tokens are mapped to CSS custom properties defined in `src/main.css` (`:root` for light, `.dark` for dark). These tokens **already auto-flip** with the active theme — do NOT add `dark:` variants on top, because that overrides the auto-flip with a *worse* value.

Tokens that auto-flip:
- `text-black` → `var(--color-text-primary)` → `#000` / `#fff`
- `bg-white` → `var(--color-surface)` → `#fff` / `#3f3f3f99` (translucent)
- `bg-gray-25` → `var(--color-surface-secondary)` → `#f9f9f9` / `#2a2a2a`
- `bg-gray-50` → `var(--color-surface-tertiary)` → `#f3f3f3` / `#333333`
- `bg-gray-100` → `var(--color-hover-bg)` → `#e1dbdb` / `#ffffff0d`
- `text-heading-gray` → `var(--color-text-secondary)` → `#484848` / `#fff`

**Gotcha:** Writing `text-black dark:text-white` makes `text-white` win in dark — but `white` is mapped to `var(--color-surface)` = `#3f3f3f99` (translucent dark grey). So the explicit `dark:` variant makes the label **less** readable than `text-black` alone.

When to add `dark:` variants:
- The base class points to a **fixed** palette color — the custom `grey.*` palette in `src/utils/tailwind-colors.js` is NOT theme-aware. Prefer `bg-gray-*` (spelled with `a`) over `bg-grey-*`.
- You need dark-mode-specific contrast in kind — e.g. `dark:bg-pure-white/15` on a TabPicker active pill, where `bg-white` alone is too subtle in dark. `pure-white` / `pure-black` are literal hex (not remapped).
- SVG `fill={...}` on `<Icon>` takes a literal JS color — Tailwind `dark:` variants don't reach prop values. Read `document.documentElement.classList.contains('dark')` at render time and pass the resolved color.

Quick check before adding `dark:`: grep `tailwind.config.ts` for the base token name. If it maps to `var(--color-...)`, don't override.

## Desktop Development (Tauri)

The desktop app uses Tauri to wrap the web app in a native macOS window.

### Commands

```bash
yarn build:desktop        # Production build for desktop (outputs to dist/desktop/)
yarn build:desktop:dev    # Development build for desktop
yarn tauri dev            # Build and run desktop app in dev mode
yarn tauri build          # Build release desktop app
```

**Node version:** Requires Node >= 22. Use nvm to switch:
```bash
source ~/.nvm/nvm.sh && nvm use 22 && yarn tauri dev
```

### Key Directories

```
src-tauri/
├── src/
│   ├── main.rs           # Tauri app entry point
│   ├── dapp_browser.rs   # dApp browser window and wallet API
│   └── lib.rs            # Command registration
├── scripts/
│   └── dapp-injection.js # Wallet API injected into dApp pages
├── capabilities/         # Tauri permission capabilities
└── tauri.conf.json       # Tauri configuration

src/lib/desktop/
├── dapp-browser.ts                   # TypeScript bindings for Tauri commands
├── DesktopDappHandler.tsx            # Handles wallet requests from dApps
└── DesktopDappConfirmationModal.tsx  # Manages confirmation overlay in dApp WebView
```

### Clearing App State (macOS)

To completely reset the desktop app state (useful for testing fresh installs or debugging):

```bash
# Clear all wallet data (IndexedDB, localStorage, WebKit caches)
rm -rf ~/Library/WebKit/com.miden.wallet
rm -rf ~/Library/WebKit/miden-wallet

# Optional: Also clear Application Support and Caches
rm -rf ~/Library/Application\ Support/com.miden.wallet
rm -rf ~/Library/Caches/com.miden.wallet
```

**Important:** The WebKit directories contain the actual IndexedDB/localStorage data. The Application Support directory may be empty or contain minimal data.

After clearing, restart the app with `yarn tauri dev` to see the onboarding screen.

### dApp Browser Architecture

The desktop app includes a separate browser window for dApps:

```
┌─────────────────────────────────────────────────────────────┐
│                    Desktop App Architecture                  │
├─────────────────────────────────────────────────────────────┤
│  Main Window (wallet UI)     │  dApp Browser Window          │
│  - React app                 │  - External dApp webpage      │
│  - DesktopDappHandler        │  - Injected window.midenWallet│
│  - Confirmation modal logic  │  - URL interception for msgs  │
│                              │                               │
│         ◄──── Tauri Events (dapp-wallet-request) ────►      │
└─────────────────────────────────────────────────────────────┘
```

**Communication flow:**
1. dApp calls `window.midenWallet.connect()` or other methods
2. Injection script encodes request as base64 and navigates to `https://miden-wallet-request/{payload}`
3. Tauri's `on_navigation` callback intercepts this URL
4. Request is emitted to main window via Tauri event
5. `DesktopDappHandler` processes and shows confirmation overlay in dApp window
6. Response flows back via similar URL interception pattern

## Code Style (Prettier)

This project uses Prettier for code formatting. Always write code that conforms to Prettier rules:

- **Line length:** Max 120 characters. Break long lines, especially `console.log` statements with multiple arguments
- **Multi-argument calls:** When function calls exceed line length, put each argument on its own line:
  ```typescript
  // Good
  console.log(
    '[Component] message:',
    value1,
    'key2:',
    value2
  );

  // Bad - will fail prettier
  console.log('[Component] message:', value1, 'key2:', value2, 'key3:', value3);
  ```
- **Trailing commas:** Use trailing commas in multi-line arrays/objects
- **Semicolons:** Always use semicolons
- **Quotes:** Single quotes for strings

Run `yarn format` to auto-fix formatting issues if needed.

## State Management

- **Backend:** Effector store in `src/lib/miden/back/store.ts`
- **Frontend:** Zustand store in `src/lib/store/index.ts`
- **Sync:** `WalletStoreProvider` subscribes to `StateUpdated` broadcasts

Frontend hooks that use Zustand:
- `useMidenContext()` - main wallet state and actions
- `useAllBalances()` - token balances with polling
- `useAllTokensBaseMetadata()` - asset metadata cache

## Intercom Messaging

Frontend ↔ Backend communication uses `IntercomClient`/`IntercomServer`:

```typescript
// Frontend request
const res = await intercom.request({ type: WalletMessageType.EditAccountRequest, ... });

// Backend broadcasts state changes
intercom.broadcast({ type: WalletMessageType.StateUpdated });
```

Message types defined in `src/lib/shared/types.ts`.

## Navigation Architecture

**IMPORTANT - Maintain this section:** When adding new screens, routes, or modifying navigation flows, update the route maps and flow documentation below. This ensures mobile back button handling stays correct and future developers understand the navigation structure.

The app uses **two separate navigation systems**:

### 1. Woozie (Global Page Navigation)

Custom lightweight router in `src/lib/woozie/`. Uses History API with hash-based URLs (`USE_LOCATION_HASH_AS_URL = true`).

**Key exports:**
- `navigate(path)` - Navigate to a route
- `goBack()` - Go back in history (`window.history.go(-1)`)
- `useLocation()` - Get current `pathname`, `historyPosition`, etc.
- `<Link to="/path">` - Declarative navigation with haptic feedback

**History tracking:**
- `historyPosition` tracks position in navigation stack (0 = first page in session)
- Used to determine if back navigation is available

### 2. Navigator (Internal Step Navigation)

Component-based navigator in `src/components/Navigator.tsx` for multi-step flows.

**Used by:**
- `SendManager` (`src/screens/send-flow/SendManager.tsx`)
- `EncryptedFileManager` (`src/screens/encrypted-file-flow/EncryptedFileManager.tsx`)

**Key exports:**
- `useNavigator()` - Returns `{ navigateTo, goBack, cardStack, activeRoute }`
- `cardStack` - Array of visited routes (step history)
- `goBack()` - Pops from cardStack (only works if `cardStack.length > 1`)

### Route Map

**Tab Pages** (with persistent footer, via `TabLayout`):
| Route | Component | Back Behavior |
|-------|-----------|---------------|
| `/` | Explore (Home) | Minimize app (Android) / Nothing (iOS) |
| `/history/:programId?` | AllHistory | → Home |
| `/settings/:tabSlug?` | Settings | Sub-tab → Settings main → Home |
| `/browser` | Browser | → Home |

**Settings Sub-Tabs** (`/settings/:tabSlug`):
| Tab Slug | Component | Notes |
|----------|-----------|-------|
| `general-settings` | GeneralSettings | Theme, analytics, haptics |
| `language` | LanguageSettings | App language selection |
| `address-book` | AddressBook | Saved contacts |
| `reveal-seed-phrase` | RevealSeedPhrase | Only shown for non-public accounts |
| `edit-miden-faucet-id` | EditMidenFaucetId | Hidden from menu |
| `encrypted-wallet-file` | EncryptedFileFlow | Opens as full dialog (see flow below) |
| `advanced-settings` | AdvancedSettings | Developer options |
| `dapps` | DAppSettings | Authorized dApps management |
| `about` | About | Version info, links |
| `networks` | NetworksSettings | Hidden from menu |

**Full-Screen Pages** (slide animation, via `FullScreenPage` or `PageLayout`):
| Route | Component | Back Behavior |
|-------|-----------|---------------|
| `/send` | SendFlow | See Send Flow below |
| `/receive` | Receive | → Home |
| `/faucet` | Faucet | → Home |
| `/get-tokens` | GetTokens | → Home |
| `/select-account` | SelectAccount | → Home |
| `/create-account` | CreateAccount | → Previous |
| `/edit-name` | EditAccountName | → Previous |
| `/import-account/:tabSlug?` | ImportAccount | → Previous |
| `/history-details/:transactionId` | HistoryDetails | → History |
| `/token-history/:tokenId` | TokenHistory | → Home |
| `/manage-assets/:assetType?` | ManageAssets | → Home |
| `/encrypted-wallet-file` | EncryptedFileFlow | See Encrypted Flow below |
| `/generating-transaction` | GeneratingTransaction | (Modal - no back) |
| `/consuming-note/:noteId` | ConsumingNote | (Processing - no back) |
| `/import-note-pending/:noteId` | ImportNotePending | → Home |
| `/import-note-success` | ImportNoteSuccess | → Home |
| `/import-note-failure` | ImportNoteFailure | → Home |

**Onboarding/Auth Routes** (catch-all when locked):
- `/reset-required`, `/reset-wallet`, `/forgot-password`, `/forgot-password-info`

### Send Flow Steps (Internal Navigator)

Route: `/send` → `SendManager` with internal step navigation:

| Step | Component | Back Behavior |
|------|-----------|---------------|
| 1. SelectToken | Token picker | → Close flow (Home) |
| 2. SelectRecipient | Address input | → SelectToken |
| 3. AccountsList | Modal overlay | → Dismiss (stays on SelectRecipient) |
| 4. SelectAmount | Amount input | → SelectRecipient |
| 5. ReviewTransaction | Confirm details | → SelectAmount |
| 6. GeneratingTransaction | Processing | (No back) |
| 7. TransactionInitiated | Success | → Home |

### Encrypted File Flow Steps (Internal Navigator)

Route: `/encrypted-wallet-file` → `EncryptedFileManager`:

| Step | Component | Back Behavior |
|------|-----------|---------------|
| 1. CreatePassword | Password setup | → Close flow (Settings) |
| 2. ConfirmPassword | Confirm password | → CreatePassword |
| 3. ExportFile | Download file | → ConfirmPassword |

### Onboarding Flow (State-Based Navigation)

**IMPORTANT:** Unlike SendManager/EncryptedFileManager, the onboarding flow does NOT use the Navigator component. It uses hash-based URLs (`/#step-name`) with React state to track the current step.

Route: `/` (when wallet is locked/new) → `Welcome.tsx` with hash-based steps:

| Hash | Step | Back Behavior |
|------|------|---------------|
| (none) | Welcome | Minimize app (Android) / Nothing (iOS) |
| `#backup-seed-phrase` | BackupSeedPhrase | → Welcome |
| `#verify-seed-phrase` | VerifySeedPhrase | → BackupSeedPhrase |
| `#select-import-type` | SelectImportType | → Welcome |
| `#import-from-seed` | ImportFromSeed | → SelectImportType |
| `#import-from-file` | ImportFromFile | → SelectImportType |
| `#create-password` | CreatePassword | → Previous step (depends on flow) |
| `#confirmation` | Confirmation | (No back while loading) |

**Navigation pattern:**
- Steps navigate via `navigate('/#step-name')` which updates the URL hash
- `useEffect` watches the hash and updates `step` state accordingly
- Back navigation calls `onAction({ id: 'back' })` which has switch logic for each step
- Mobile back handler in `Welcome.tsx` triggers this same `onAction({ id: 'back' })`

**Forgot Password Flow** (`/forgot-password` → `ForgotPassword.tsx`) uses the same pattern with `ForgotPasswordStep` enum.

### Back Handler System

**Global handler** in `src/app/env.ts`:
- `registerBackHandler(handler)` - Register a back handler (returns unregister function)
- `onBack()` - Calls the current handler
- Stack-based: handlers can be layered (modals on top of pages)

**PageLayout** (`src/app/layouts/PageLayout.tsx`) registers default handler:
```typescript
// If history available, go back; otherwise go home
if (historyPosition > 0) {
  goBack();
} else if (!inHome) {
  navigate('/', HistoryAction.Replace);
}
```

### Mobile Back Button

**IMPORTANT:** Hardware back button on Android and swipe-back on iOS require `@capacitor/app` plugin and explicit handling. Without it, back gestures close the app instead of navigating.

Back handlers must be registered for:
1. Global navigation (MobileBackBridge component)
2. Navigator-based flows (SendManager, EncryptedFileManager)
3. State-based flows (Welcome/onboarding, ForgotPassword)
4. Modals/dialogs that should close on back

## Code Patterns

### Adding a new wallet action

1. Add message types to `src/lib/shared/types.ts`
2. Add handler in `src/lib/miden/back/actions.ts`
3. Register handler in `src/lib/miden/back/main.ts`
4. Add action to Zustand store in `src/lib/store/index.ts`
5. Expose via `useMidenContext()` in `src/lib/miden/front/client.ts`

### Optimistic updates

```typescript
// In store action
editSomething: async (id, value) => {
  const prev = get().items;
  set({ items: /* optimistic value */ });
  try {
    await request({ ... });
  } catch (error) {
    set({ items: prev }); // Rollback
    throw error;
  }
}
```

## Balance Loading Architecture

The wallet uses an IndexedDB-first pattern for instant UI updates:

```
┌─────────────────────────────────────────────────────────────┐
│                    Balance Loading Flow                      │
├─────────────────────────────────────────────────────────────┤
│  1. fetchBalances() → getAccount() → IndexedDB (instant)    │
│  2. AutoSync (1s interval) → syncState() → Miden Node       │
│  3. syncState updates IndexedDB → next fetchBalances sees it│
└─────────────────────────────────────────────────────────────┘
```

- `fetchBalances` in `src/lib/store/utils/fetchBalances.ts` reads from IndexedDB via `getAccount()` - it does NOT call `syncState()`
- `AutoSync` class in `src/lib/miden/front/sync.ts` handles background network sync separately
- This separation allows showing cached balances instantly while syncing in background

**Important distinction:**
- `getAccount(accountId)` - reads balance from IndexedDB (local cache)
- `syncState()` - syncs with Miden node and updates IndexedDB
- `importAccountById(assetId)` - imports **asset/token metadata**, not account balances

## WASM Client Concurrency

**CRITICAL:** The Miden WASM client cannot handle concurrent access. Concurrent calls cause:
```
Error: recursive use of an object detected which would lead to unsafe aliasing in rust
```

**Always wrap WASM client operations in `withWasmClientLock`:**

```typescript
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';

// CORRECT - always use the lock
const result = await withWasmClientLock(async () => {
  const midenClient = await getMidenClient();
  return midenClient.someOperation();
});

// WRONG - direct access without lock causes concurrency errors
const midenClient = await getMidenClient();
const result = await midenClient.someOperation();
```

**This applies everywhere**, including:
- Transaction workers in `src/workers/` (consumeNoteId.ts, sendTransaction.ts, submitTransaction.ts)
- Backend operations in `src/lib/miden/back/`
- Frontend hooks in `src/lib/miden/front/`
- Any new code that accesses `getMidenClient()`

The lock ensures only one WASM operation runs at a time across the entire app, preventing AutoSync, dApp requests, and user operations from conflicting.

## Testing

- Unit tests in `*.test.ts` files alongside source
- Tests use Jest + React Testing Library
- Mock `lib/intercom` for frontend tests
- Wrap components with `WalletStoreProvider` + `MidenContextProvider`

### Jest Mock Gotchas

**Module path resolution:** Mock paths must match how the source file imports the module:
```typescript
// If actions.ts imports: import { Vault } from 'lib/miden/back/vault';
// Then mock with the same path:
jest.mock('lib/miden/back/vault', () => ({ ... }));
// NOT: jest.mock('./vault', ...) - this won't work
```

**jsdom limitations:** `window.location.reload` cannot be mocked in jsdom. Use try-catch:
```typescript
try {
  functionThatCallsReload();
} catch {
  // reload throws in jsdom, expected
}
```

**React test cleanup:** Prevent test pollution by cleaning up React roots:
```typescript
afterEach(() => {
  testRoot.unmount();
});
```

## E2E Blockchain Test Harness

End-to-end tests that exercise real wallet operations against a live Miden network (testnet, devnet, or localhost). Uses Playwright to automate two Chrome extension instances and `miden-client` CLI to deploy a faucet and mint tokens.

### Quick Start

```bash
# Build + run against a specific network (default testnet)
yarn test:e2e:blockchain:testnet
yarn test:e2e:blockchain:devnet
yarn test:e2e:blockchain:localhost

# Subsequent runs (skip rebuild if no code changes)
E2E_NETWORK=devnet yarn test:e2e:blockchain:run

# Build only (no test run) — picks up E2E_NETWORK if set, else testnet
yarn test:e2e:blockchain:build

# Raw form (equivalent to the :<network> shortcuts)
E2E_NETWORK=testnet yarn test:e2e:blockchain
```

The `:<network>` scripts set both `E2E_NETWORK` (which endpoints the harness + miden-client CLI use) AND propagate `MIDEN_NETWORK` through to the extension build (which network the wallet connects to). Running with a mismatched pair — e.g. harness on devnet but wallet built for testnet — silently fails because notes land on one network and the wallet listens on the other.

The harness auto-installs `miden-client-cli` from crates.io on first run, version-matched to the wallet's `@miden-sdk/miden-sdk` package. Requires Rust toolchain (`cargo`).

### Directory Layout

```
playwright/e2e/
  config/environments.ts       # Network endpoints per E2E_NETWORK
  harness/                     # Observability layer (types, timeline, capture, reports)
  helpers/
    miden-cli.ts               # miden-client CLI wrapper (init, deploy faucet, mint)
    wallet-page.ts             # Page Object Model for wallet UI automation
  fixtures/two-wallets.ts      # Playwright fixture: 2 Chrome instances + observability
  tests/*.spec.ts              # Test specs
playwright.e2e.config.ts       # Playwright config (5 min timeout, traces always on)
```

### Environment Selection

`E2E_NETWORK` controls both:
- which RPC/prover/transport endpoints the harness + `miden-client` CLI use (via `playwright/e2e/config/environments.ts`)
- which network the extension build bakes into its bundle (piped through to `MIDEN_NETWORK` at build time in `test:e2e:blockchain:build`)

Use the dedicated scripts to avoid mismatches:

```bash
yarn test:e2e:blockchain:testnet    # default
yarn test:e2e:blockchain:devnet
yarn test:e2e:blockchain:localhost  # requires a local Miden node on :57291
```

Or set `E2E_NETWORK` explicitly with the generic script:

```bash
E2E_NETWORK=devnet yarn test:e2e:blockchain
```

### Test Specs

| Spec | What it tests |
|------|---------------|
| `wallet-lifecycle.spec.ts` | Create, lock, unlock wallets |
| `mint-and-balance.spec.ts` | Deploy faucet via CLI, mint tokens, verify balance in UI |
| `send-public.spec.ts` | Send public note A->B, B syncs and claims |
| `send-private.spec.ts` | Send private note A->B via transport layer |
| `multi-claim.spec.ts` | Mint 3 notes, batch claim |
| `multi-account.spec.ts` | Multiple accounts, switch, send between own accounts |

### Agentic Debug Mode

**For AI agents running this as a verification loop.** On test failure, browsers stay open so the agent can inspect live state and hot-reload fixes.

```bash
# Run with agentic mode
E2E_AGENTIC=true E2E_NETWORK=testnet yarn test:e2e:blockchain:run

# Or use the shortcut script
yarn test:e2e:blockchain:agentic
```

#### On Failure: What Happens

1. **Browsers stay open** -- Both Chrome instances remain alive with full wallet state (IndexedDB, service worker, vault)
2. **`test-results/debug-session.json`** is written with connection details:
   ```json
   {
     "wallets": {
       "A": { "extensionId": "abc...", "fullpageUrl": "chrome-extension://abc.../fullpage.html", "cdpUrl": "ws://...", "userDataDir": "/tmp/..." },
       "B": { "extensionId": "def...", "fullpageUrl": "chrome-extension://def.../fullpage.html", "cdpUrl": "ws://...", "userDataDir": "/tmp/..." }
     },
     "midenCliWorkDir": "/tmp/miden-cli-...",
     "reportPath": "test-results/run-.../tests/.../report.json"
   }
   ```
3. **`report.json`** contains structured failure diagnosis (see "Reading Failure Reports" below)
4. **Auto-cleanup** after 10 min (configurable via `E2E_AGENTIC_TIMEOUT`)

#### Agent Investigation Workflow

After a test failure in agentic mode:

1. **Read the failure report:**
   ```bash
   cat test-results/run-<latest>/tests/<test-name>/report.json
   ```
   Key fields: `failureCategory`, `failedAtStep`, `diagnosticHints`, `stateAtFailure`, `browserErrors`

2. **Take fresh screenshots of live wallets:**
   Use CDP or Playwright's still-alive connection to screenshot the current state.

3. **Query wallet state via the exposed Zustand store:**
   ```typescript
   // In page.evaluate() on an open wallet page:
   const store = (window as any).__TEST_STORE__;
   const state = store.getState();
   // state.status, state.accounts, state.balances, state.currentAccount
   ```

4. **Trigger a sync manually:**
   ```typescript
   // In page.evaluate():
   const intercom = (window as any).__TEST_INTERCOM__;
   intercom.request({ type: 'SYNC_REQUEST' });
   ```

5. **Run miden-client commands against the preserved state:**
   ```bash
   cd <midenCliWorkDir>   # from debug-session.json
   miden-client account --list
   miden-client sync
   miden-client notes --list
   ```

6. **Navigate the wallet UI** to different pages to investigate visually.

#### Hot-Reload: Fix Code and Push to Live Browsers

The agent can modify wallet source code, rebuild, and reload into the still-open browsers **without losing wallet state**:

```bash
# 1. Fix the bug in source code
# 2. Rebuild the extension
yarn test:e2e:blockchain:build

# 3. Reload the extension in each open Chrome instance
#    (via page.evaluate on the extension's fullpage tab)
```

```typescript
// In page.evaluate() on the wallet's fullpage tab:
chrome.runtime.reload();
// Extension reloads from updated dist/chrome_unpacked/
// IndexedDB + vault data PERSIST (tied to extension origin)
// Service worker restarts, in-memory Zustand state resets
```

After `chrome.runtime.reload()`, extension pages unload. Re-open the fullpage tab:
```
chrome-extension://<extensionId>/fullpage.html
```
The wallet initializes from IndexedDB -- same accounts, same keys, same balances. The agent can now test the fix against the exact wallet state that caused the failure.

### Reading Failure Reports

The `report.json` is designed for machine consumption. Key fields for an AI agent:

```typescript
{
  failureCategory: string,     // "timeout_waiting_for_sync" | "ui_element_not_found" | etc.
  diagnosticHints: string[],   // Pre-computed suggestions, e.g., "NETWORK: 3 RPC requests failed"
  failedAtStep: {
    index: number,             // Which test step failed (0-based)
    name: string,              // "sync_wallet_b"
    lastAction: string         // What was happening when it failed
  },
  stateAtFailure: {
    walletA: { status, balances, claimableNotes, currentUrl },
    walletB: { status, balances, claimableNotes, currentUrl }
  },
  browserErrors: [...],        // JS errors from both extension instances
  failedNetworkRequests: [...], // Failed RPC calls
  recentEvents: [...],         // Last 50 timeline events before failure
  timing: {
    wasTimeout: boolean,       // Did we hit the test timeout?
    slowestSteps: [...]        // Which steps were unusually slow?
  }
}
```

**Diagnosis flowchart:**
- `wasTimeout: true` + `failedAtStep.name` contains "sync" -> Blockchain sync issue, check network
- `browserErrors` contains "recursive use of an object" -> WASM concurrency bug
- `failedNetworkRequests` not empty -> Node/RPC connectivity issue
- `failureCategory === 'ui_element_not_found'` -> UI changed, update selectors in `wallet-page.ts`
- `failureCategory === 'cli_command_failed'` -> Check `recentCliCommands` for stderr

### Observability Artifacts

Every test run produces structured artifacts in `test-results/run-<timestamp>/tests/<test-name>/`:

| File | Purpose |
|------|---------|
| `report.json` | Primary diagnostic document (read this first) |
| `timeline.ndjson` | Chronological event stream (every action, assertion, CLI call, console log) |
| `checkpoints.json` | Step-by-step pass/fail with assertion details |
| `state-snapshots/` | Wallet Zustand state at each checkpoint |
| `cli/` | miden-client CLI invocations with full stdout/stderr |
| `browser/wallet-{a,b}-console.ndjson` | Browser console output from both extensions |
| `screenshots/` | Screenshots at checkpoints + on failure |
| `traces/wallet-{a,b}.zip` | Playwright traces (open with `npx playwright show-trace`) |
| `video/` | Video recordings (only on failure) |

### Source Modifications for E2E

The E2E build (`MIDEN_E2E_TEST=true`) exposes test hooks on `window`:

- `window.__TEST_STORE__` -- Zustand store (`useWalletStore`) for reading wallet state via `page.evaluate()`
- `window.__TEST_INTERCOM__` -- Intercom client instance for sending `SyncRequest` and other messages to the service worker

These are only present when built with `MIDEN_E2E_TEST=true` and have zero impact on production builds.

### Custom Faucet Token Discovery

The E2E harness deploys its own faucet via `miden-client new-account --account-type fungible-faucet`. Tokens from this custom faucet appear in the wallet because:
- The wallet fetches ALL fungible assets from the account vault (no `TOKEN_MAPPING` whitelist)
- Token metadata (symbol, decimals) is fetched from the RPC node as long as the faucet is deployed with `--storage-mode public`
- Custom tokens show with their proper symbol (e.g., "TST") in the UI, are selectable in the send flow, and have correct decimal formatting

## E2E iOS Simulator Test Harness

Mirror of the Chrome E2E suite, but driving two iPhone 17 / iPhone 17 Pro simulators in parallel against the iOS app. Same 7 specs, ported to `playwright/e2e/ios/tests/*.ios.spec.ts`.

### Quick Start

```bash
yarn test:e2e:mobile:devnet      # build app + run full iOS suite on devnet
yarn test:e2e:mobile:testnet     # same on testnet
yarn test:e2e:mobile:run         # skip rebuild (re-run only)
yarn test:e2e:mobile:build       # build app only
```

The first run boots two simulators (iPhone 17 + iPhone 17 Pro), creating them if absent. UDIDs persist at `test-results-ios/.device-pair.json` so subsequent runs reuse the same booted devices — saves ~30s per run.

### Architecture

```
playwright/e2e/ios/
  helpers/
    simulator-control.ts   # xcrun simctl wrapper (boot, install, launch, terminate)
    cdp-bridge.ts          # WebKit Inspector bridge via appium-remote-debugger
    ios-wallet-page.ts     # WalletPage interface impl backed by CDP + simctl
  fixtures/
    two-simulators.ts      # Playwright fixture; same shape as two-wallets
    global-setup.ts        # asserts App.app, reserves+boots device pair
    global-teardown.ts     # no-op (devices stay booted between runs)
  tests/
    *.ios.spec.ts          # ported specs (one-line import change from Chrome)
```

The `WalletPage` interface in `playwright/e2e/helpers/wallet-page.ts` is shared between Chrome and iOS — same method signatures, different impls. The harness (`playwright/e2e/harness/`) is platform-neutral and is reused wholesale; per-wallet `SnapshotCaps` closures supplied by the fixture absorb platform-specific bits (page.evaluate, service-worker queries on Chrome; CdpSession.evaluate on iOS).

### CDP Bridge (appium-remote-debugger)

`remotedebug-ios-webkit-adapter` does NOT work on simulators (it wraps libimobiledevice which is USB-only). We use `appium-remote-debugger` instead, which talks the WebKit Inspector Protocol directly over the per-simulator UNIX socket at `/private/tmp/com.apple.launchd.<RANDOM>/com.apple.webinspectord_sim.socket`.

The socket path is discovered per-boot via:
```bash
xcrun simctl spawn <udid> launchctl print user/501 | grep RWI_LISTEN_SOCKET
```

`CdpBridge.connect({ udid, bundleId })` resolves the socket, calls `selectApp(null, 5, true)` with `additionalBundleIds: ['*']` to find the app's WebView page, then `selectPage(appKey, pageNum)`. Returns a `CdpSession` that wraps `executeAtom('execute_script', [body, []])` for repeated evaluation.

### Per-Test Isolation

Boot is amortized across runs (devices stay booted). Per-test, the fixture does:
1. `terminate` the app (if running)
2. `uninstall` it (wipes IndexedDB + Preferences sandbox)
3. `install` the freshly-built `.app`
4. `launch` with `MIDEN_E2E_TEST=true`
5. Connect CDP and construct `IosWalletPage`

Total ~5s per wallet — much cheaper than the ~30s `simctl erase` would cost.

### Onboarding Bypass

Mirroring the wallet's official test hook (`Welcome.tsx`), iOS spec wallets skip seed-phrase backup/verify by setting `window.__TEST_SKIP_ONBOARDING = true` + `?__test_skip_onboarding=1` and tapping "Get started". This is what `IosWalletPage.createNewWallet` does. Specs that need a real seed phrase should use `importWallet()`.

### Reading iOS Failure Reports

Same artifact tree as Chrome, output to `test-results-ios/run-<timestamp>/tests/<test>/`. The `WalletSnapshot.platform` discriminator is `'ios'` (vs `'chrome'`); `serviceWorkerStatus` and `extensionId` are omitted. `runtimeInfo.kind === 'ios'` in the run manifest. All consumers (`failure-report.ts`, `diagnostic-hints.ts`) handle both platforms.

### Known Limitations

- Headless mode is not available — Simulator.app must be running. The harness boots devices but does not control the GUI window. CI runners need a graphical session.
- The CDP bridge picks the first WebKit page on the inspector. The wallet uses one WebView, so this is fine; if a future build adds a dApp browser WebView, `CdpBridge.connect` needs a target-disambiguation parameter.
- `simctl` does NOT support keyboard input from outside the simulator. The iOS POM dispatches React-compatible `input`/`change` events directly via DOM rather than typing into native fields. For native iOS sheets / system dialogs this won't work — only WebView content is reachable.

## Internationalization (i18n)

**IMPORTANT:** All user-facing text in React components MUST be internationalized. Never use hardcoded strings for UI text - always use `t('key')` or the `<T id="key" />` component. CI will block PRs with non-i18n'd strings (enforced by `yarn lint:i18n`).

When adding new translatable strings, add them to `public/_locales/en/en.json`, NOT `messages.json`.

- `en.json` - Flat format source file (`"key": "value"`). The translation script reads from this file.
- `messages.json` - Chrome extension format (`"key": { "message": "value", "englishSource": "value" }`). Auto-generated.

### Adding new i18n strings

1. Add the key to `public/_locales/en/en.json` in flat format:
   ```json
   "myNewKey": "My new translatable string"
   ```

2. Use in React components with `useTranslation` hook:
   ```typescript
   import { useTranslation } from 'react-i18next';

   const { t } = useTranslation();
   return <span>{t('myNewKey')}</span>;
   ```

3. CI will auto-translate to other languages via `yarn createTranslationFile`

### Placeholders in translations

Use `$placeholder$` format for dynamic values:
```json
"greeting": "Hello $name$, you have $count$ messages"
```

## Transaction Processing

### Background Transaction Processing

For operations that should happen silently (like auto-consume), use `startBackgroundTransactionProcessing`:

```typescript
import { startBackgroundTransactionProcessing } from 'lib/miden/activity';
import { useMidenContext } from 'lib/miden/front';

const { signTransaction } = useMidenContext();

// Queue transactions first
await initiateConsumeTransaction(accountPublicKey, note, isDelegatedProvingEnabled);

// Then process silently in background (no modal/tab)
startBackgroundTransactionProcessing(signTransaction);
```

This is preferred over `openLoadingFullPage()` for automatic operations because:
- Doesn't interrupt the user with a modal (mobile) or new tab (desktop)
- Polls every 5 seconds for up to 5 minutes
- Works on both mobile and desktop

### Transaction States

Transactions flow through these states in `ITransactionStatus`:
1. `Queued` (0) - Initial state when transaction is created
2. `GeneratingTransaction` (1) - Being processed
3. `Completed` (2) - Successfully finished
4. `Failed` (3) - Error occurred

## Important Notes

- **Never push without explicit request.** Creating commits is fine, but never run `git push` unless the user explicitly asks.
- **Keep commit messages short.** Use single-line messages (e.g., "fix: add missing i18n keys").
- Uses yarn, not npm (yarn.lock is the lockfile)
- Browser extension APIs via `webextension-polyfill`
- Miden SDK is a WASM module (`@miden-sdk/miden-sdk`)
- Sensitive data (vault, keys) stays in backend only
- Frontend receives sanitized state via `toFront()` in backend store
