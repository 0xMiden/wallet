---
title: Privacy Policy — Miden Wallet
permalink: /privacy/
---

# Miden Wallet — Privacy Policy

_Last updated: 2026-05-28_

Miden Wallet ("the App") is a non-custodial cryptocurrency wallet for the Miden blockchain, published by Miden Labs.

## Data we collect

None. The App does not collect, transmit, or store any personal data on Miden Labs' servers. We have no user accounts, no analytics SDKs, no crash reporters, and no advertising identifiers.

## Data stored on your device

- Your wallet's seed phrase, private keys, account names, transaction history, and balances are stored locally on your device, encrypted at rest using your device's secure enclave (Android Keystore / iOS Secure Enclave) when biometric protection is enabled.
- This data never leaves your device unless YOU explicitly export it via the in-app "Export Wallet" function.

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
