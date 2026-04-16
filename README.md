# Miden Wallet

[![LICENSE](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/0xMiden/miden-wallet/blob/main/LICENSE)
[![build](https://github.com/0xMiden/miden-wallet/actions/workflows/production-branch.yml/badge.svg)](https://github.com/0xMiden/miden-wallet/actions/workflows/production-branch.yml)
[![build](https://github.com/0xMiden/miden-wallet/actions/workflows/build-desktop.yml/badge.svg)](https://github.com/0xMiden/miden-wallet/actions/workflows/build-desktop.yml)
[![build](https://github.com/0xMiden/miden-wallet/actions/workflows/build-mobile.yml/badge.svg)](https://github.com/0xMiden/miden-wallet/actions/workflows/build-mobile.yml)

A secure, cross-platform wallet for the [Miden](https://miden.xyz) blockchain. Available as a browser extension, desktop application, and mobile app.

## Platforms

| Platform | Technology | Status |
|----------|------------|--------|
| Chrome Extension | WebExtension APIs | Production |
| Firefox Extension | WebExtension APIs | Production |
| Desktop (macOS, Windows, Linux) | [Tauri](https://tauri.app/) v2 | Production |
| iOS | [Capacitor](https://capacitorjs.com/) | Production |
| Android | [Capacitor](https://capacitorjs.com/) | Production |

## Features

### Core Wallet Features
- Create and manage multiple Miden accounts
- Send and receive tokens
- View transaction history
- Import/export wallet via seed phrase or encrypted file
- Address book for saved contacts

### Security
- **Browser Extension**: Secure vault with password encryption
- **Desktop**: Hardware-backed key storage via macOS Keychain / Windows Credential Manager
- **Mobile**: Biometric authentication (Face ID, Touch ID, Fingerprint)
- Client-side transaction signing (keys never leave your device)

### Platform-Specific Features

| Feature | Extension | Desktop | Mobile |
|---------|-----------|---------|--------|
| dApp Browser | N/A (uses tabs) | Built-in browser window | In-app WebView |
| System Tray | N/A | Yes | N/A |
| Biometric Unlock | N/A | Touch ID (macOS) | Face ID / Touch ID / Fingerprint |
| QR Code Scanning | N/A | N/A | Yes |
| Haptic Feedback | N/A | N/A | Yes |

## Install

Download the latest release: **https://miden.fi/**

## Development

### Prerequisites

- [Node.js](https://nodejs.org) 22 or later
- [Yarn](https://yarnpkg.com) v1
- [Rust](https://rustup.rs/) toolchain (for desktop app)
- Xcode (for iOS development)
- Android Studio (for Android development)

### Setup

```bash
# Clone the repository
git clone https://github.com/0xMiden/miden-wallet.git
cd miden-wallet

# Copy environment file
cp .env.example .env

# Install dependencies
yarn install
```

### Browser Extension

```bash
# Development (Chrome)
yarn dev

# Production build
yarn build:chrome    # Chrome
yarn build:firefox   # Firefox
yarn build-all       # All browsers
```

Load the unpacked extension from `dist/chrome_unpacked/` in Chrome's extension settings.

### Desktop App

```bash
# Development
yarn desktop:dev

# Production build
yarn desktop:build
```

See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for platform-specific requirements.

### Mobile App

```bash
# iOS
yarn mobile:ios           # Build and open in Xcode
yarn mobile:ios:run       # Build and run on Simulator

# Android
yarn mobile:android       # Build and open in Android Studio
```

#### Release Builds

```bash
# Android
yarn mobile:android:keystore     # Generate keystore (one-time)
yarn mobile:android:release      # Build AAB for Play Store
yarn mobile:android:release:apk  # Build APK for direct install

# iOS
yarn mobile:ios:release          # Build release archive
yarn mobile:ios:export           # Export IPA for App Store
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            Miden Wallet                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                 │
│   │  Extension  │    │   Desktop   │    │   Mobile    │                 │
│   │  (Chrome/   │    │   (Tauri)   │    │ (Capacitor) │                 │
│   │  Firefox)   │    │             │    │             │                 │
│   └──────┬──────┘    └──────┬──────┘    └──────┬──────┘                 │
│          │                  │                  │                        │
│          └──────────────────┼──────────────────┘                        │
│                             │                                           │
│                    ┌────────▼────────┐                                  │
│                    │   React + TS    │                                  │
│                    │   (Shared UI)   │                                  │
│                    └────────┬────────┘                                  │
│                             │                                           │
│                    ┌────────▼────────┐                                  │
│                    │   Miden SDK     │                                  │
│                    │     (WASM)      │                                  │
│                    └─────────────────┘                                  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Key Directories

```
src/
├── app/                 # React app, pages, layouts
├── components/          # Shared UI components
├── screens/             # Screen components (onboarding, send flow, etc.)
├── lib/
│   ├── miden/           # Miden SDK integration
│   │   ├── back/        # Backend: wallet operations, vault
│   │   ├── front/       # Frontend: hooks, providers
│   │   └── sdk/         # WASM client wrapper
│   ├── store/           # Zustand state management
│   ├── desktop/         # Desktop-specific (Tauri) code
│   ├── mobile/          # Mobile-specific (Capacitor) code
│   ├── dapp-browser/    # dApp connectivity
│   └── woozie/          # Custom router
├── workers/             # Background workers
└── public/              # Static assets, locales

src-tauri/               # Tauri (Rust) backend
├── src/
│   ├── lib.rs           # Main entry, command registration
│   ├── secure_storage/  # OS keychain integration
│   ├── dapp_browser.rs  # dApp browser window management
│   └── tray.rs          # System tray
└── scripts/             # Injected JavaScript

ios/                     # iOS native project
android/                 # Android native project
```

### State Management

- **Frontend**: Zustand store (`src/lib/store/`)
- **Backend (Extension)**: Effector store (`src/lib/miden/back/`)
- **Sync**: Intercom messaging between frontend and service worker

### Platform Detection

```typescript
import { isExtension, isDesktop, isMobile, isIOS, isAndroid } from 'lib/platform';

if (isDesktop()) {
  // Tauri-specific code
} else if (isMobile()) {
  // Capacitor-specific code
} else if (isExtension()) {
  // Browser extension code
}
```

## Testing

```bash
# Unit tests
yarn test

# E2E tests (Playwright)
yarn playwright:install   # First time only
yarn test:e2e

# Linting and formatting
yarn lint
yarn format
```

### E2E Blockchain Tests

Spin up two Chrome-extension instances and drive a real wallet flow against a live Miden network — deploy a faucet via the `miden-client` CLI, mint tokens, send notes, claim them. Takes ~6 minutes end-to-end.

```bash
yarn test:e2e:blockchain:testnet     # default network
yarn test:e2e:blockchain:devnet      # use when testnet is ahead/behind the wallet's SDK version
yarn test:e2e:blockchain:localhost   # requires a local Miden node on :57291
```

Each script sets `E2E_NETWORK` and propagates `MIDEN_NETWORK` through to the extension build, so the test harness and the wallet always target the same network. Running the two on different networks silently fails (notes land on one, wallet listens on the other).

Other useful scripts:

```bash
yarn test:e2e:blockchain:run       # skip rebuild; reruns tests against the last-built extension
yarn test:e2e:blockchain:build     # rebuild only; picks up $E2E_NETWORK if set, else testnet
yarn test:e2e:blockchain:agentic   # failure-on-first-error mode: browsers stay open on failure
                                   # so a debugger (or AI agent) can inspect live wallet state
```

The harness auto-installs `miden-client-cli` from crates.io on first run, version-matched to the wallet's `@miden-sdk/miden-sdk` package. Requires the Rust toolchain.

### E2E Stress Tests

Random-walk send/claim between two wallets with perturbations (lock/unlock, page reload, concurrent sends, idle periods) layered on top of the base flow. Parametrized by note count so the same suite dials from a ~15 min smoke to a multi-hour soak. Asserts **strict balance conservation** after the final drain — any missing note is treated as a real bug, not devnet flakiness.

```bash
# default ~15 min run on devnet, all perturbations on, fresh random seed
yarn test:e2e:stress:devnet
```

All knobs are env vars — set on the command line to override. Full list in `playwright/e2e/stress/stress.spec.ts`; the highlights:

| Var | Default | What it does |
|---|---|---|
| `STRESS_NUM_NOTES` | 20 | stop condition; ~15 min worth of sends on devnet |
| `STRESS_INITIAL_MINTS` | 3 | 3000 TST per wallet going in |
| `STRESS_AMOUNT_MIN` / `STRESS_AMOUNT_MAX` | 1 / 10 | display units |
| `STRESS_DELAY_MIN_MS` / `STRESS_DELAY_MAX_MS` | 3000 / 10000 | inter-send gap |
| `STRESS_PRIVATE_RATIO` | 0.5 | public vs private mix |
| `STRESS_CLAIM_AFTER_SEND_PROB` | 0.5 | receiver claims immediately after each incoming note |
| `STRESS_IDLE_EVERY` / `_MIN_MS` / `_MAX_MS` | 10 / 30000 / 60000 | user-stepped-away simulation |
| `STRESS_LOCK_EVERY` | 15 | lock/unlock cycle frequency |
| `STRESS_RELOAD_EVERY` | 20 | page reload cycle frequency |
| `STRESS_CONCURRENT_PROB` | 0.15 | both wallets send at the same tick |
| `STRESS_TRANSPORT_FAIL_PROB` | 0 | probability of intercepting + failing the SendNote gRPC call on a private send, so the wallet's transport-retry loop is exercised end-to-end |
| `STRESS_SEED` | `Date.now()` | reproducibility |
| `STRESS_CONSERVATION_STRICT` | true | fail if final total != initial |

Set any of the `*_EVERY` knobs (or `STRESS_CONCURRENT_PROB` / `STRESS_TRANSPORT_FAIL_PROB`) to `0` to disable that perturbation entirely.

Example usage:

```bash
# Quick sanity check after a wallet change (~7 min, base loop only):
STRESS_NUM_NOTES=5 \
STRESS_LOCK_EVERY=0 STRESS_RELOAD_EVERY=0 STRESS_IDLE_EVERY=0 STRESS_CONCURRENT_PROB=0 \
yarn test:e2e:stress:devnet

# Overnight soak (~100 min):
STRESS_NUM_NOTES=200 yarn test:e2e:stress:devnet

# Reproduce a specific failure — every run logs its seed at the top of stdout
# and inside stress-summary.json; pass it back in to replay the same sequence:
STRESS_SEED=2433243116 STRESS_NUM_NOTES=20 yarn test:e2e:stress:devnet

# Focus on a single perturbation (dense reload coverage, everything else off):
STRESS_NUM_NOTES=30 \
STRESS_RELOAD_EVERY=3 \
STRESS_LOCK_EVERY=0 STRESS_IDLE_EVERY=0 STRESS_CONCURRENT_PROB=0 \
yarn test:e2e:stress:devnet

# Skip the rebuild when iterating (advanced — use only if you're sure
# dist/chrome_unpacked is up-to-date; the normal variants rebuild every
# time to avoid stale-bundle foot-guns):
yarn test:e2e:stress:build                            # rebuild once
STRESS_NUM_NOTES=10 yarn test:e2e:stress:run-only     # then re-run tests only

# Switch networks:
yarn test:e2e:stress:testnet
yarn test:e2e:stress:localhost                        # expects a local node on :57291
```

Every run writes three artifacts into the timeline's output dir (under `test-results/run-*/tests/...`):

- `stress-summary.json` — seed, options, initial/final balances, per-op latency percentiles, perturbation counts, conservation-held flag
- `stress-operations.csv` — per-op record (sender, receiver, isPrivate, amount, sendMs, status, concurrent, perturbation, error)
- `timeline.ndjson` — full event stream (same schema as the blockchain suite)

Playwright traces + videos land under a separate `test-results-stress/` tree so stress runs don't clobber regular E2E artifacts.

### E2E iOS Simulator Tests

Same 7 specs as the Chrome suite, ported to drive two parallel iOS Simulators (iPhone 17 + iPhone 17 Pro) over the WebKit Inspector Protocol via `appium-remote-debugger`. Takes ~9 minutes end-to-end on devnet. Requires Xcode + iOS Simulator runtime.

```bash
yarn test:e2e:mobile:devnet          # currently green — use this for CI
yarn test:e2e:mobile:testnet         # see Chrome section caveat about testnet
yarn test:e2e:mobile:localhost       # requires a local Miden node on :57291
```

The first run boots the simulator pair and creates them if absent; subsequent runs reuse the same booted devices (UDIDs cached at `test-results-ios/.device-pair.json`), which saves the ~30s cold-boot cost per run.

Other useful scripts:

```bash
yarn test:e2e:mobile:run           # skip rebuild; reruns tests against the last-built App.app
yarn test:e2e:mobile:build         # rebuild the iOS app only; picks up $E2E_NETWORK if set, else testnet
```

Run a single spec the same way as Chrome:

```bash
E2E_NETWORK=devnet yarn test:e2e:mobile:run send-public
```

The iOS POM (`playwright/e2e/ios/helpers/ios-wallet-page.ts`) implements the same `WalletPage` interface as the Chrome POM, so most of the harness (timeline recorder, failure reports, state snapshots) is shared. Per-spec divergences are documented in the `.ios.spec.ts` files — most notably an explicit `claimAllNotes()` call between mint and balance verification, since mobile has no `chrome.storage.local` to surface pending notes.

Artifacts land in `test-results-ios/` with the same shape as the Chrome `test-results/` tree.

## Internationalization

The wallet supports multiple languages. Translation files are in `public/_locales/`.

```bash
# Generate translation files
yarn createTranslationFile
```

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests and linting (`yarn test && yarn lint`)
5. Commit your changes
6. Push to your branch
7. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Links

- [Miden Documentation](https://docs.miden.xyz/)
- [Polygon Miden](https://miden.xyz/)
- [Report Issues](https://github.com/0xMiden/miden-wallet/issues)
