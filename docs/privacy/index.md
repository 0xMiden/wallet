---
title: Privacy Policy — Bread Wallet by Miden
permalink: /privacy/
---

# Bread Wallet by Miden — Privacy Policy

_Last updated: 2026-08-21_

Bread Wallet by Miden ("the App") is a non-custodial cryptocurrency wallet for the Miden blockchain, published by Miden.

## Data we collect

The App collects nothing about you unless you turn on **Share usage data**, which is **off by default**. If you never turn it on, the App sends us nothing — no product events, no crash reports.

You are asked once, after you create or import a wallet, and you can say no. Whatever you choose then, you can change it at any time in **Settings → General → Help improve Wallet**. Turning it off stops sending: the setting is checked before every single send, so nothing that was waiting gets sent later.

Everything below describes what is sent **only while that setting is on**.

### Usage data

When the setting is on, the App reports the start and the end of a small set of activities. Each report is a single message with no free-form text in it — there is no field an address, an amount, or an error message could occupy. A message contains only these:

| What | Values |
|---|---|
| Which activity | One of: opening the app, unlocking, creating a wallet, importing a wallet, recovering a wallet, returning to the app, funding, sharing your receive address, sending, handling an incoming note, viewing activity |
| Whether it started or ended | `started` or `ended` |
| How it ended | `completed`, `cancelled`, or `errored` |
| Broad error category, if it failed | One of: network, rpc, proving, validation, storage, auth, timeout, unknown |
| How long it took | A duration in milliseconds |
| App version | For example, `1.15.21` |
| Platform | `extension`, `ios`, or `android` |
| A short random number for that one activity | Explained under "Identifiers" below |

That is the complete list. There is no other field, and the error category is chosen from the eight names above — the underlying error message is read to pick a category and is never sent.

### Crash reports

When the setting is on, a crash sends the error type, the error's message, and the stack trace — the list of code locations the error passed through — plus the app version. Where one error was caused by another, each error in that chain is included. Text is scrubbed before it leaves your device: addresses, amounts, long hex values, credentials in URLs, and values under names like `password` or `seed` are replaced with `[redacted]`. A message that scrubs down to nothing useful is dropped rather than sent as a row of markers, and if anything in the report looks like a recovery phrase, the whole report is thrown away rather than sent.

Crash reports do not include the page you were on, your browser's user-agent string, your language, your timezone, or a recording of your screen or clicks. Alongside the error, each report carries the time it happened, a severity level, its own random report id generated for that one report, and the name and version of the reporting library — the standard technical envelope, with nothing about you in it.

Please read "What scrubbing can and cannot promise" below, which is the honest limit of this.

### What we never collect

Not when the setting is on, not when it is off, not ever:

- Your private keys, recovery phrase, or password
- Your account addresses, balances, or transaction amounts
- The contents of your transactions, your notes, or your note IDs
- Your name, email address, or contacts
- Your location — the App asks for no location permission and reads no location sensor
- Any advertising identifier, and anything that would let us or anyone else follow you across other apps or websites. The App does not show Apple's App Tracking Transparency prompt, because it has nothing to ask permission for.

And nothing collected is ever sold, or shared with data brokers or ad networks.

We also do not call this data anonymous. Sending anything over the internet means the receiving server sees the IP address the request came from, exactly as it does for any other network request — and an IP address indicates a rough region. Our processors are configured not to store it, but we are not going to describe data as anonymous when a server saw where it came from.

## Identifiers

The App holds **no persistent identifier for you** — no user id, no device id, no install id, no cookie, no advertising identifier. Nothing in the usage data or the crash reports says "this is the same person as last week", or even "as five minutes ago".

The one identifier involved is the short random number in the table above. It is created when an activity starts, exists only in memory, is used only to match that activity's "started" message to its "ended" message, is never written to disk, and is never reused. Once the activity is over, it is gone.

### What that means for deleting your data

It means we cannot delete your data on request, and we would rather say so than promise otherwise.

There is no identifier in this data by which we could find your records. If you asked us to delete your usage data or your crash reports, we would have no way to tell yours apart from everyone else's — the records simply do not say who they came from.

This is a deliberate trade-off, not a way of avoiding the request. The alternative is to attach a durable identifier to every message so that we *could* find your data later, which would mean building the exact tracking capability we chose not to have. We decided that not being able to identify you is worth more than being able to service a deletion request, and this paragraph is the cost of that decision stated plainly.

Two things do follow from it, in your favour:

- **Turning the setting off is complete.** There is no profile left behind to keep, because there was never a profile.
- **Everything expires on its own.** All usage data and all crash reports are deleted **90 days** after they are received. Nothing is kept longer, and nothing needs a request to make that happen.

Everything the App stores about *your wallet* — your keys, accounts, balances, and history — is on your device, and you can delete it yourself with "Delete wallet" in Settings, or by uninstalling the App. That is unaffected by any of the above.

## What scrubbing can and cannot promise

The scrubbing described under "Crash reports" is thorough but it is a filter, not a guarantee, and you should know its limits before deciding to turn the setting on.

It works by recognising what secrets look like. That is reliable for the things that have a recognisable shape — a Miden address, a long hex value, a run of digits, a credential in a URL, or any value stored under a name like `password`. Two kinds of thing can get past it:

- **A recovery phrase broken into small pieces.** The filter spots runs of consecutive words from the recovery-phrase wordlist, and a real phrase is 12 or 24 words. A phrase scattered two or three words at a time across many separate fields of one report could fall below that threshold and survive.
- **A password with nothing around it.** If a password were ever the entire text of an error message, with no field name and no URL to identify it, the filter has nothing to go on: by shape alone it is indistinguishable from a harmless request id.

Neither is a known leak. No part of the App puts a recovery phrase or a password into an error, and automated tests run on every change assert that. They are the residual risk if some future code did, and we would rather name them than imply the filter is perfect.

## Who processes this data

Only if the setting is on:

| Data | Processor | Where |
|---|---|---|
| Usage data | Aptabase | European Union (Germany) |
| Crash reports | Sentry | European Union |

Both are configured to delete data after 90 days, to store no IP addresses, and to forward nothing onward. Neither is permitted to use the data for its own purposes, and no third party receives it for advertising or resale.

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

If **Share usage data** is on, the App also reaches the two processors named above. If it is off, it does not contact them at all.

The App loads no fonts, scripts, or images from third-party servers. Everything it needs to draw itself ships inside the App.

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
