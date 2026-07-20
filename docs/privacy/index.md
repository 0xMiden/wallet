---
title: Privacy Policy — Miden Wallet
permalink: /privacy/
---

# Miden Wallet — Privacy Policy

_Last updated: 2026-07-20_

Miden Wallet ("the App") is a non-custodial cryptocurrency wallet for the Miden blockchain, published by Miden.

## Data we collect

**None.** Miden does not collect, transmit, or store any data about you on our servers. The App has no user accounts, no analytics SDKs, no crash reporters, and no advertising identifiers. We never see your wallet contents.

## How the App uses your device

For transparency about how the App functions on your device (this is not data we receive or have access to):

- Your wallet's seed phrase, private keys, account names, transaction history, and balances are generated and held **only** on your device, encrypted at rest using your device's secure enclave (Android Keystore / iOS Secure Enclave) when biometric protection is enabled.
- This information never leaves your device unless **you** explicitly export it via the in-app "Export Wallet" function.

## Biometric authentication (Face ID, Touch ID, Fingerprint)

The App offers **optional** biometric unlock using your device's built-in authentication — Face ID or Touch ID on iOS, fingerprint or face authentication on Android.

**The App does not collect, access, receive, store, transmit, or share any face data, fingerprint data, or other biometric data.**

Biometric matching is performed entirely by your device's operating system inside secure hardware (Apple's Secure Enclave / Android's hardware-backed keystore). Your biometric templates are created, stored, and managed solely by iOS/Android and are never made available to the App. When you unlock with biometrics, the App receives only a yes/no result indicating whether authentication succeeded — it never receives any biometric data itself.

- **What we collect:** No face or fingerprint data. None is ever transmitted off your device; we operate no servers that could receive it.
- **How it is used:** A successful biometric check causes your device's operating system to release a wallet-unlock key held in secure hardware, allowing the App to decrypt your local wallet without you typing your password. This happens entirely on-device.
- **Sharing / third parties:** None. No biometric data exists in the App to share.
- **Storage:** No biometric data is stored by the App. Your biometric templates remain solely under your operating system's control in secure hardware.
- **Retention / deletion:** The App retains no biometric data. You manage your enrolled biometrics in your device's system settings. Disabling biometric unlock in the App, or uninstalling the App, removes the App's on-device unlock key and has no effect on and no access to your OS-level biometric enrollment.

## Network traffic

The App connects to the public Miden blockchain RPC endpoint (`rpc.testnet.miden.io`) and the Miden note transport service (`transport.miden.io`) to send and receive on-chain transactions. These requests contain only data needed to interact with the blockchain (transaction payloads, public account state) — never your private keys or seed phrase.

## Permissions

The App requests the following Android permissions:

- **INTERNET** — to reach the Miden RPC and transport endpoints
- **VIBRATE** — for haptic feedback on UI interactions
- **USE_BIOMETRIC** (Android 6+) — to unlock the wallet via fingerprint / face authentication

## Children

The App is not directed at children under 13. We do not knowingly collect any information from children.

## Changes

Material changes to this policy will be reflected on this page with an updated "Last updated" date.

## Contact

Open an issue at [github.com/0xMiden/wallet/issues](https://github.com/0xMiden/wallet/issues) or email privacy@miden.team.
