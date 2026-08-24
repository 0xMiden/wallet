# App Store Listing Information

This document contains the metadata needed for App Store (iOS) and Google Play (Android) submissions.

---

## App Information

- **App Name (App Store Connect):** Bread Wallet · **Home-screen label (`CFBundleDisplayName`):** Bread
- **Bundle ID (iOS App Store):** com.miden.bread · **Package Name (Android):** com.miden.wallet
- **Version:** 1.14.4
- **Android versionCode:** 11404001
- **Category:** Finance
- **Content Rating:** Everyone / 4+

---

## Short Description (80 characters max)

```
Secure wallet for the Miden blockchain. Send, receive, and manage your assets.
```

---

## Full Description

<!-- REVIEW (Product, before the next submission): the "No tracking or analytics
     that compromise your privacy" bullet below predates the optional telemetry
     added in 1.15.22. That feature is off by default, requires explicit opt-in,
     carries no persistent identifier, and does no cross-app or cross-site
     tracking — so the claim is arguably still accurate, and the qualifier
     "that compromise your privacy" is doing real work. But it should be a
     decision by whoever owns the claim rather than a sentence that survived
     because nobody re-read it. See docs/telemetry-store-declarations.md.
     Note: the block below is pasted verbatim into store listings, so this
     comment sits outside it deliberately. -->

```
Bread Wallet is the official wallet for the Miden blockchain, designed to give you complete control over your digital assets with industry-leading security and privacy.

KEY FEATURES

Secure by Design
• Biometric authentication (Face ID / Fingerprint) for quick, secure access
• Your private keys never leave your device
• Password-protected wallet with encrypted local storage

Easy Asset Management
• Send and receive MIDEN tokens and other assets
• View your transaction history and account balances
• Automatic token claiming from faucets
• Support for multiple account types

Privacy-Focused
• Built on Miden's zero-knowledge proof technology
• Private transactions that protect your financial data
• No tracking or analytics that compromise your privacy

User-Friendly Experience
• Clean, intuitive interface
• Quick account setup with secure seed phrase backup
• Seamless switching between accounts
• Real-time balance updates

GETTING STARTED

1. Download and open Bread
2. Create a new wallet or import an existing one using your seed phrase
3. Secure your wallet with a password and enable biometric login
4. Start sending and receiving assets on the Miden network

SECURITY REMINDERS

• Always back up your seed phrase in a secure location
• Never share your seed phrase or private keys with anyone
• Enable biometric authentication for added security

Bread is open source. Visit our website to learn more about the Miden blockchain and our commitment to privacy and security.

Website: https://miden.fi
Privacy Policy: https://0xmiden.github.io/wallet/privacy/
```

---

## Keywords (iOS - 100 characters max)

```
miden,wallet,crypto,blockchain,privacy,zero-knowledge,zk,defi,tokens,secure,finance
```

---

## What's New (Release Notes) — Version 1.14.4

Full developer-facing changelog: `CHANGELOG.md`. User-facing summary below.

### Long form (App Store / website)

```
What's new in 1.14.4:

• Native Rust prover on iOS and Android — proving local transactions is now
  5-50× faster than before. Toggle in Settings → General → Local proving.
• Mobile sync fix — first auto-sync after wallet creation no longer hangs;
  newly received public notes now surface in the Receive screen on first
  launch.
• Private key import & export — back up or transfer individual accounts via
  a hex secret in Settings → Reveal Private Key and Import Account → Private
  Key.
• Connectivity banners revamped — separate signals for network / node /
  prover issues with a clear Retry action instead of a single misleading
  warning.
• View on Midenscan from the transaction-complete screen; explorer opens
  in-app on mobile so dismissing returns to the confirmation.
• Several reliability fixes around transaction-progress modal lifecycle and
  encrypted-wallet-file import preserving secret keys for every account.
```

### Play Store release notes (≤500 characters)

```
• Native Rust prover on iOS + Android — local proving now 5-50× faster.
• Mobile sync fix: first sync after wallet creation no longer hangs;
  newly received public notes appear right away.
• Private key import & export per account.
• Connectivity banner now separates network / node / prover issues
  with a clear Retry action.
• View on Midenscan from the transaction-complete screen.
• Several stability + dApp browser fixes.
```

---

## Screenshots Required

### iOS
- 6.7" Display (iPhone 14 Pro Max): 1290 x 2796 px
- 6.5" Display (iPhone 11 Pro Max): 1242 x 2688 px
- 5.5" Display (iPhone 8 Plus): 1242 x 2208 px
- 12.9" Display (iPad Pro): 2048 x 2732 px

### Android
- Phone: 1080 x 1920 px (minimum)
- 7" Tablet: 1200 x 1920 px
- 10" Tablet: 1800 x 2560 px

### Suggested Screenshot Scenes
1. Home screen with account balance
2. Send transaction screen
3. Receive screen with QR code
4. Activity/transaction history
5. Settings with biometric option
6. Account management

---

## App Icon

- iOS: 1024 x 1024 px (no transparency, no rounded corners)
- Android: 512 x 512 px

Current icons are located at:
- iOS: `ios/App/App/Assets.xcassets/AppIcon.appiconset/`
- Android: `android/app/src/main/res/mipmap-*/`

---

## Privacy Policy & Support

- **Privacy Policy URL:** `https://0xmiden.github.io/wallet/privacy/` — served by GitHub Pages from `docs/privacy/index.md` in this repo. Requires Pages to be enabled at Settings → Pages → Source = `Deploy from a branch`, Branch = `main`, Folder = `/docs`. URL becomes live ~1-2 min after Pages is enabled and `main` contains this commit.
- **Terms of Service URL:** N/A — Play Console allows omitting Terms of Service; only Privacy Policy is required.
- **Support URL:** https://miden.fi
- **Support Email:** privacy@miden.team

---

## App Review Information (iOS)

### Demo Account
If review requires a test account, provide:
- Instructions for creating a test wallet
- Note: App works offline for wallet creation, network connection needed for transactions

### Notes for Reviewers
```
Bread is a cryptocurrency wallet for the Miden blockchain.

To test the app:
1. Create a new wallet (no account needed)
2. Set a password and optionally enable Face ID
3. The app will generate a new account on the Miden testnet
4. You can request test tokens from the built-in faucet link

The app requires network connectivity to sync with the Miden blockchain for sending/receiving tokens, but wallet creation and account management work offline.
```

---

## Content Rating Questionnaire Notes

### iOS (App Store)
- No objectionable content
- No user-generated content sharing
- No gambling or contests
- Handles financial data (cryptocurrency)

### Android (Google Play)
- Target audience: General (Everyone)
- Contains: Financial features
- Does not contain: Violence, sexual content, gambling

---

## Data Safety (Google Play) — answers ready to paste into Play Console

### Data collection summary
- **Personal info:** None collected, none shared.
- **Financial info — User payment info:** NOT collected (no card / payment processing).
- **Financial info — Other financial info:** Local-only. Account addresses, balances, transaction history stored on-device, not transmitted. Declare in Play Console: *collected (on device), not shared, "Data is encrypted in transit" — N/A since not transmitted.*
- **Crypto-related — Crypto assets:** User-controlled. Seed phrase / private keys stored encrypted on-device, never transmitted. Declare: *collected, not shared, data deletion supported (in-app "Delete wallet" + uninstall).*
- **App activity — App interactions:** Collected, **optional** (off by default; requires opt-in via "Share usage data"). Not shared. Encrypted in transit. Purpose: *Analytics*. Declare: *collected, not shared, optional, "Data is encrypted in transit" — yes.* What is sent per event: which of 16 activities, whether it started or ended, the outcome (completed / cancelled / errored), a broad error category from a fixed list of 8, a duration in ms, which screen the activity reached (from a fixed list of 17 screen names), the app version, and the platform. No free-text field exists on the wire.
- **App info and performance — Crash logs:** Collected, **optional** (same setting, off by default). Not shared. Encrypted in transit. Purposes: *Analytics* and *App functionality*. Scrubbed on-device before sending; a report containing anything resembling a recovery phrase is discarded rather than sent.
- **App info and performance — Diagnostics:** Collected, **optional** (same setting). Not shared. Encrypted in transit. Purposes: *Analytics* and *App functionality*. Covers the error category and duration described above.
- **App info and performance — Other app performance data:** None collected.
- **Device or other IDs:** **None.** No user ID, device ID, install ID, or advertising ID exists anywhere in the app. The only identifiers involved are two random values held in memory and never persisted: one per activity, and one per run of the app that groups the activities of that run. Both are gone when the app closes, so nothing links one launch to another.

### Data shared with third parties
**None shared** in Play's sense (no transfer for another party's own purposes). RPC/transport traffic to `rpc.testnet.miden.io` + `transport.miden.io` is public chain data, not user PII.

Two processors act on Miden's instructions under a DPA, only while "Share usage data" is on: **Aptabase** (EU/Germany) for app-interaction events and **Sentry** (EU) for crash logs. Both are configured for 90-day retention with no IP storage, no raw export, and no onward forwarding. Neither is a data broker and neither may use the data for its own purposes.

### Security practices
- Data encrypted at rest on device (Android Keystore / iOS Secure Enclave when biometric protection enabled)
- All collected data is encrypted in transit (HTTPS)
- Users can delete their on-device data in-app ("Delete wallet" in Settings, plus uninstall)
- **Data deletion — telemetry:** per-user deletion is **not possible and not offered**, because nothing in the telemetry identifies a user; there is no identifier by which one person's records could be found. It is deleted automatically 90 days after collection. The account-deletion URL requirement does not apply — the app has no accounts.
- App is open source: https://github.com/0xMiden/miden-wallet

> Full declarations for the other three storefronts — Chrome Web Store, Firefox
> AMO, and the Apple App Store privacy questionnaire — are in
> [`docs/telemetry-store-declarations.md`](docs/telemetry-store-declarations.md),
> along with the vendor-configuration checklist that must be completed before any
> of these answers are true.

---

## Release Build Commands

### Android

```bash
# 1. Generate release keystore (one-time)
yarn mobile:android:keystore

# 2. Create keystore.properties (copy from example and fill in)
cp android/keystore.properties.example android/keystore.properties
# Edit android/keystore.properties with your passwords

# 3. Build release AAB (for Play Store)
yarn mobile:android:release

# 4. Or build release APK (for direct distribution)
yarn mobile:android:release:apk
```

Output locations:
- AAB: `android/app/build/outputs/bundle/release/app-release.aab`
- APK: `android/app/build/outputs/apk/release/app-release.apk`

### iOS

**Production App Store identity** (Miden organization account). These values are
the iOS identity on `main`. The iOS e2e harness now targets `com.miden.bread` to
match; the browser extension and Android (`applicationId`) intentionally stay on
`com.miden.wallet`.

| | Value |
|---|---|
| Bundle ID | **`com.miden.bread`** (fresh App ID under the org — no App Transfer needed) |
| Team | **`LHU7B7J5WL`** (Miden org) |
| Signing | Automatic — `-allowProvisioningUpdates` mints the Apple Distribution cert + App Store profile under the org |

The identity lives in four source files (already set to the values above):
`ios/App/App.xcodeproj/project.pbxproj` (`PRODUCT_BUNDLE_IDENTIFIER` +
`DEVELOPMENT_TEAM`, Debug & Release), `ios/App/ExportOptions.plist` (`teamID`),
`ios/App/App/App.entitlements` (keychain-access-group), and
`capacitor.config.ts` (`appId`).

Prerequisites: an Apple ID that is an **Admin or Account Holder** member of the
org (`LHU7B7J5WL`) signed into Xcode (Settings → Accounts) so automatic signing
can mint the distribution cert/profile; an App Store Connect app record for
`com.miden.bread` under the org; and an App Store Connect **team API key** (org)
for the headless upload.

```bash
# 1. Apply the production identity overrides (bundle id + team) — see table above.
# 2. Build the signed Release archive (testnet; mainnet RPC is still a placeholder).
#    NOTE: this project uses Swift Package Manager, not CocoaPods — the archive
#    builds against App.xcodeproj (there is no App.xcworkspace).
E2E_NETWORK= MIDEN_NETWORK=testnet yarn mobile:ios:release
```

Upload (pick one):
- **Xcode Organizer (GUI, recommended for account-based auth):** open
  `ios/App/build/MidenWallet.xcarchive` → Distribute App → App Store Connect →
  Upload (uses the signed-in Xcode account).
- **Headless:** `yarn mobile:ios:export` (ExportOptions: `app-store-connect`,
  `destination: upload`) — needs an App Store Connect API key configured, not
  just the Xcode account.

Export compliance: the app uses standard algorithms (AES-GCM, PBKDF2, SHA-256 via
Web Crypto). `ITSAppUsesNonExemptEncryption` is set to `false` in
`ios/App/App/Info.plist`, so the App Store upload does not re-prompt for the
encryption/France questionnaire.

Common upload errors:
- *"PLA Update available" / "No profiles for com.miden.bread were found"* — the
  **Program License Agreement needs accepting** at developer.apple.com/account
  (account holder). Both errors clear once it's accepted.

Output locations:
- Archive: `ios/App/build/MidenWallet.xcarchive`
- Export: `ios/App/build/export/`

> TODO: the "What's New" copy above is stale (last updated for 1.14.4) — refresh
> per release before submitting.

Alternatively, open Xcode and use Product > Archive for a GUI workflow.

---

## Checklist Before Submission

### iOS App Store
- [ ] Screenshots for all required device sizes
- [ ] App icon (1024x1024)
- [ ] App Store Connect account set up
- [ ] Distribution certificate and provisioning profile
- [ ] Privacy policy URL accessible
- [ ] Age rating questionnaire completed
- [ ] App Review notes prepared

### Google Play Store
- [ ] Screenshots for phone and tablet
- [ ] Feature graphic (1024x500)
- [ ] App icon (512x512)
- [ ] Google Play Console account set up
- [ ] Release keystore created and secured
- [ ] Privacy policy URL accessible
- [ ] Content rating questionnaire completed
- [ ] Data safety form completed
