# App Store Listing Information

This document contains the metadata needed for App Store (iOS) and Google Play (Android) submissions.

---

## App Information

- **App Name:** Miden Wallet
- **Bundle ID / Package Name:** com.miden.wallet
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

```
Miden Wallet is the official wallet for the Miden blockchain, designed to give you complete control over your digital assets with industry-leading security and privacy.

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

1. Download and open Miden Wallet
2. Create a new wallet or import an existing one using your seed phrase
3. Secure your wallet with a password and enable biometric login
4. Start sending and receiving assets on the Miden network

SECURITY REMINDERS

• Always back up your seed phrase in a secure location
• Never share your seed phrase or private keys with anyone
• Enable biometric authentication for added security

Miden Wallet is open source. Visit our website to learn more about the Miden blockchain and our commitment to privacy and security.

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
Miden Wallet is a cryptocurrency wallet for the Miden blockchain.

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
- **App activity:** None tracked.
- **App info and performance — Crash logs / Diagnostics:** None collected (no crash reporter).
- **Device IDs:** None.

### Data shared with third parties
**None.** RPC/transport traffic to `rpc.testnet.miden.io` + `transport.miden.io` is public chain data, not user PII.

### Security practices
- Data encrypted at rest on device (Android Keystore / iOS Secure Enclave when biometric protection enabled)
- Users can request data deletion in-app ("Delete wallet" in Settings, plus uninstall)
- App is open source: https://github.com/0xMiden/miden-wallet

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

**Production App Store identity** (differs from the repo defaults, which are for
e2e/dev):

| | Repo default (e2e/dev) | App Store production |
|---|---|---|
| Bundle ID | `com.miden.wallet` | **`com.midenfi.wallet`** |
| Team | `YQ9XQQJ5ZM` | **`QT9F8G4KW7`** (current publishing team) |
| Provisioning profile | — | "midenwallet" (App Store, `com.midenfi.wallet`) |

The production identity is applied as **local, uncommitted overrides** at build
time — set `PRODUCT_BUNDLE_IDENTIFIER` + `DEVELOPMENT_TEAM` in
`ios/App/App.xcodeproj/project.pbxproj` and `teamID` in
`ios/App/ExportOptions.plist`, then **revert after building**. Don't commit them;
the repo stays on the dev defaults so e2e keeps working.

Prerequisites: Apple Developer membership for the publishing team, the Apple
Distribution cert + the App Store provisioning profile in the keychain, and Xcode
signed into that team (Settings → Accounts).

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
- *"PLA Update available" / "No profiles for com.midenfi.wallet were found"* — the
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
