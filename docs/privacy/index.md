---
title: Privacy Policy — Bread Wallet by Miden
permalink: /privacy/
---

# Bread Wallet by Miden — Privacy Policy

_Last updated: 2026-09-28_

Bread Wallet by Miden ("the App") is a non-custodial cryptocurrency wallet for the Miden blockchain, published by Miden.

## Data we collect

The App collects nothing about you unless you turn on **Share usage data**, which is **off by default**. If you never turn it on, the App sends us nothing — no product events, no crash reports.

You are asked once, after you create or import a wallet, and you can say no. Whatever you choose then, you can change it at any time in **Settings → General → Help improve Wallet**. Turning it off stops sending: the setting is checked before every single send, so nothing that was waiting gets sent later.

**On Firefox, there is a second switch, and both have to be on.** Firefox asks separately whether the extension may collect technical and interaction data — at install time, and afterwards under `about:addons` → Permissions and data. The App reads Firefox's answer as well as its own setting and sends only when both say yes. Turning either one off is enough to stop it. Other browsers have no equivalent switch, so there the App's own setting is the only one.

Everything below describes what is sent **only while that setting is on**.

### Usage data

When the setting is on, the App reports the start and the end of a small set of activities. Each report is a single message with no free-form text in it — there is no field an address, an amount, or an error message could occupy. A message contains only these:

| What | Values |
|---|---|
| Which activity | One of: opening the app, unlocking, creating a wallet, importing a wallet, recovering a wallet, returning to the app, funding, sharing your receive address, sending, swapping, earning, connecting a dApp, approving a dApp request, changing your guardian, handling an incoming note, viewing activity |
| Which kind of work, for work the App did on your behalf | One of: sending, receiving, swapping, earning, bridging, a guardian change, a dApp's transaction, another transaction, proving, or one of three services being unreachable. A category of work, never a recipient, an amount, an asset, a dApp, or an endpoint. See "Work the App does on your behalf" below |
| Whether it started or ended | `started` or `ended`, or `settled` for work the App did on your behalf |
| How it ended | `completed`, `cancelled`, or `errored` |
| Broad error category, if it failed | One of: network, rpc, proving, validation, storage, auth, timeout, unknown |
| How long it took | A duration in milliseconds |
| How far you got | For an activity, the name of the furthest screen it reached, from a fixed list — for example `select_amount` or `review`. The screen's name only, never anything you typed on it. For work the App did on your behalf, the stage it reached instead — for example `proving` or `submitting` |
| App version | For example, `1.15.21` |
| Platform | `extension`, `ios`, or `android` |
| Network | `mainnet`, `testnet`, `devnet`, or `localnet` |
| A short random number for that one activity | Explained under "Identifiers" below |
| A short random number for that run of the App | Explained under "Identifiers" below |

That is the complete list. There is no other field, and the error category is chosen from the eight names above — the underlying error message is read to pick a category and is never sent.

#### Work the App does on your behalf

The App also reports whether the work it does on your behalf actually succeeded. When you send, swap, claim, earn, bridge, or change your guardian, the App has to prove and submit a transaction after you have finished asking for it, and that part can fail for reasons that have nothing to do with you — a prover or a node being down or unreachable. Without this, a failure affecting everyone would be invisible to us, because by then the activity above has already been reported as finished.

Those reports use the same fields as the table above and add nothing that describes you or your money. Nothing about the transaction itself travels with them: not who you sent to, not how much, not which asset, not which dApp, not which endpoint.

They also carry **no activity identifier**, which means we cannot tell which of your activities a piece of work belonged to. That is deliberate rather than an oversight: linking the two would mean writing one of those random values onto the transaction record the App keeps on disk, and a value written to disk outlives the run it was made for — which is exactly the durable identifier this design refuses to hold.

Three more things travel with each message as part of the technical envelope our analytics provider defines: the time the message was sent, a flag saying whether the App was a development build or a released one, and a fixed name and version number for the piece of our own code that sent it (`miden-wallet-aptabase@1.0.0` — the same string for everyone). None of them varies with who you are or what device you use.

**We deliberately leave three of the provider's fields empty.** Aptabase's format has slots for your operating system version, your language or locale, and your device model, and their own libraries fill all three in. We send none of them. Each one is a fingerprinting signal — a combination of them narrows a crowd down to a person — and none is needed to find out where the wallet breaks. Automated tests fail the build if any of the three ever appears in an outgoing message, which is what stops someone filling them in later because the field was there.

### Crash reports

Handled transaction failures are also reported when sharing is enabled, including failures after submission and transactions whose network outcome remains unknown. These reports contain only fixed transaction, stage and execution-route categories, bundled software versions, the network the App was on, known public protocol error identities, the fixed failure reasons and refusal codes listed below, and authentication-code compatibility, preparation, layout and commitment-match categories calculated locally. They never include the transaction request, an account or transaction identifier, addresses, amounts, signatures, salts, commitments or dApp URLs. Unknown assertion numbers and raw failure text are not sent. Historical rows imported from a backup do not generate new failure reports.

A failure report can also say why the transaction failed, using only these fixed values:

- **The App's own reason**, when the App itself ended the transaction: `user_cancelled` (you cancelled it), `interrupted_on_startup` (the App closed while it was running), `stuck_reaped` (it ran too long and the App stopped waiting for it), `queued_expired` (it waited in the queue too long), `rotation_key_pending` (the account's everyday key was not active yet, so the App did not claim the incoming transfer), `rotation_funding_note_unavailable` (the transfer the App was claiming to activate the account's everyday key was no longer available to claim), `rotation_funding_not_native` (the App could not confirm that the transfer it was claiming to activate the account's everyday key was a standard payment holding only the network's own token), `rotation_gate_refusal` (the App refused to claim a transfer while the account's everyday key was not active yet, for a reason other than the three before it), `consume_not_landed` (the network still showed the incoming transfer as unclaimed), `consume_landed_external` (the network showed the incoming transfer as claimed, but not by a transaction the App could prove was its own), `note_invalid` (the incoming transfer can never be claimed), or `never_committed` (the network showed that a transaction the App submitted was never included, so nothing moved). Any other value is sent as `other`. With `never_committed`, the report can also say which check showed it: `expired` (its time to be included ran out), `superseded` (the account moved on with another transaction), `spent_elsewhere` (a transfer it claimed was claimed by another transaction), or `mixed` (the App had tried more than once, and different checks showed it for different tries). Any other check is sent as `other`.
- **A guardian refusal**: `guardian_http_` followed by the HTTP status the guardian answered with, as its number, such as `409`, when it is a whole number from 100 to 599, and as `other` when it is not. It also carries the guardian's error code when it is one the guardian's published client defines: `account_already_exists`, `account_data_unavailable`, `account_not_found`, `account_paused`, `account_released`, `authentication_failed`, `authentication_replay`, `authorization_failed`, `candidate_landed`, `commitment_mismatch`, `configuration_error`, `conflict_pending_delta`, `conflict_pending_proposal`, `data_unavailable`, `delta_not_found`, `insufficient_operator_permission`, `insufficient_signatures`, `invalid_account_id`, `invalid_commitment`, `invalid_cursor`, `invalid_delta`, `invalid_evm_proposal`, `invalid_input`, `invalid_limit`, `invalid_network_config`, `invalid_proposal_signature`, `invalid_status_filter`, `invalid_timestamp`, `network_error`, `pending_proposals_limit`, `proposal_already_signed`, `proposal_not_found`, `rate_limit_exceeded`, `rpc_unavailable`, `rpc_validation_failed`, `session_expired`, `session_revoked`, `signature_scheme_not_allowed`, `signer_not_authorized`, `signing_error`, `state_not_found`, `storage_error`, `unsupported_evm_chain`, `unsupported_for_network` or `wallet_signature_required`. Any other code is sent as `other`, and a refusal with no code as `none`.
- **A device key refusal**: `hot_key`, with the code the App's secure-hardware signing key was refused with, when it is one of `AUTH_FAILED`, `AUTH_UNAVAILABLE`, `BAD_CIPHERTEXT`, `BIOMETRIC_BUSY`, `DEVICE_LOCKED`, `HARDWARE_UNAVAILABLE`, `INVALID_INPUT`, `KEY_INVALIDATED`, `KEY_NOT_FOUND`, `LEGACY_CIPHER_INIT_FAILED`, `UNWRAP_FAILED` or `USER_CANCELLED`. Any other code is sent as `other`, and a refusal with no code as `none`.
- **A submit with no definite answer**: `submit_outcome_unknown`, when the network neither accepted nor refused a transaction the App submitted. It carries the kind of answer the App got instead, one of `unavailable`, `internal`, `cancelled`, `aborted`, `data_loss`, `deadline_exceeded` or `unknown` (any other is sent as `other`), and whether the App was in the background while it waited: `yes`, `no`, or `unavailable` when the App cannot tell.
- **A submit the network refused**: `submit_rejected`, when the network gave a definite refusal while the App submitted a transaction. It names the request that was refused, `submit_proven_transaction`, `submit_proven_batch`, `get_transaction_encryption_key` (the key the App seals a transaction with before it submits) or `other`; the kind of answer, one of `unavailable`, `internal`, `cancelled`, `aborted`, `data_loss`, `deadline_exceeded`, `unknown`, `not_found`, `invalid_argument`, `permission_denied`, `already_exists`, `resource_exhausted`, `failed_precondition`, `out_of_range`, `unimplemented` or `unauthenticated` (any other is sent as `other`); and the network's own reason when its fixed wording names one, `internal`, `expired`, `state_conflict`, `capacity_exceeded`, `missing_fee`, `consumes_inflight_fee_notes`, `invalid_fee_asset`, `batch_id_mismatch`, `authentication_failed` or `unknown_code`, else `none` when it gave no reason and `other` for any other. The network's own message is never sent.
- **Work the App stopped**: when the App stopped a transaction's work from outside because it ran too long or what was running it went away. On the extension, `offscreen_aborted_deadline` (the background document running it passed its time limit), `offscreen_aborted_deadline_no_kill` (one read passed its time limit while another transaction was running), `offscreen_aborted_doc_closed` (that document closed before it answered), `offscreen_aborted_transport` (the message to that document could not be delivered) or `offscreen_aborted_other`. On any platform, `wasm_lock_evicted_watchdog` (an operation held the transaction engine past its time limit), `wasm_lock_evicted_realm_error` (the transaction engine crashed while in use) or `wasm_lock_evicted_other`.
- **What the transaction software said went wrong**, when it could not build or run a transaction: `transaction_execution_failed` with the `cause` its own fixed wording names, one of `request_note_consumed` (a transfer being claimed was already claimed), `request_note_processing` (another transaction was already claiming it), `request_note_unauthenticated` (a transfer could not be proven to exist on the network), `request_duplicate_note` (the same transfer was included twice), `request_empty` (the transaction would change nothing), `request_fee_conversion` (the network fee could not be arranged for the account), `request_other` (any other problem with the request), `recency_check` (the App's copy of the network was too old), `account_locked` (the account's state may be out of date), `account_data_not_found` (the account's data was missing on the device), `output_mismatch` (the transaction did not produce the transfers it was asked to), `data_store`, `store` or `rpc` (reading the device's records or the network failed), `fetch_inputs`, `block_after_reference`, `account_not_in_store`, `block_not_in_store` or `fetch_asset_witness` (gathering what the transaction needed failed), `foreign_account_not_anchored` or `note_past_reference_block` (something the transaction used was newer than the network state it was built on), `kernel_program` (the transaction's program failed), `summary_block_unknown`, `summary_expiration_mismatch` or `summary_commitment_mismatch` (what the signers approve did not match the transaction), `signature_failed` (a signature could not be made), `executor_other` (any other failure while running it) or `other`. A check in the transaction's program that fails with a number the protocol does not publish is sent as `kernel_assertion_unknown`, or as `kernel_u32_assertion_unknown` when it is a range check.
- **The signing step**, when the transaction failed while it was being signed: `creating_proposal` (preparing it for the guardian), `signing_proposal` (signing what was prepared) or `signing_locally` (signing on this device alone).
- **Two failures the transaction engine names itself**: `advice_stack_read_failed` (the transaction's program asked for data it was not given) and `client_terminated` (the transaction engine was shut down while the transaction was using it).
- **A broad category**, when nothing above names the failure: one of `network`, `rpc`, `proving`, `validation`, `storage`, `auth`, `timeout` or `unknown`, chosen on the device by reading the failure's text, which is never sent.

None of these carries the text of the refusal, the guardian's response, or the address of the server that sent it.

When the setting is on, a crash sends the error type, the error's message, and the stack trace — the list of code locations the error passed through — plus the app version. Where one error was caused by another, each error in that chain is included. Text is scrubbed before it leaves your device: addresses, amounts, long hex values, credentials in URLs, and values under names like `password` or `seed` are replaced with `[redacted]`. A message that scrubs down to nothing useful is dropped rather than sent as a row of markers, and if anything in the report looks like a recovery phrase, the whole report is thrown away rather than sent.

Every crash report also names the network the App was on: `mainnet`, `testnet`, `devnet`, or `localnet`.

Every crash report also says how the error reached the reporter: reported by the App itself (`generic`, or `react` when a screen failed to show), or never caught and picked up by the App's global error handlers (`onerror` or `onunhandledrejection`). It names the platform (`extension`, `ios` or `android`) and the build the App came from: which build it was (`extension`, `mobile`, `desktop` or `background`, the extension's background part), the commit of the App's source code it was built from, which is the same for everyone running that build, and whether that source had changes not in the commit (`true` or `false`). A crash in one of three of the App's own operations names it: its messaging between its windows and its background (`intercom_request`), a dApp approval window reading its request (`confirm_payload`), or starting the built-in WebAssembly module (`sdk_initialize`). When a dApp approval window cannot read its request, the report says whether the window's address had no approval id at all or an empty one (`missing` or `empty`).

If the App's built-in WebAssembly module fails while starting, the report also says which startup step failed (`wasm_ready`, `client_create`, `mock_import` or `mock_create`) and, when it was building the App's client, whether that client ran in a worker (`enabled` or `disabled`). When the failure is a WebAssembly trap, it adds whether a fresh one-page block of shared memory could still grow (`grew`, `refused` or `unavailable`) and how many of the App's own pages were open, counting its hidden background page (`1`, `2-3`, `4+` or `unavailable`). None of these is an identifier.

A crash in the App's own messaging between its windows and its background also names the kind of request that failed, from the App's fixed list of request names, and, in the browser extension, whether the window had reconnected to the background before it failed (`true` or `false`). When a dApp approval window's request finds nothing in the background to answer it, the report also names the state the background held for that approval (`open`, `answered`, `window_closed`, `expired`, `payload_failed` or `unknown`). None of these includes the approval's id, the dApp, or anything the request carried.

A crash that is the App's connection to the WalletConnect relay failing is sent as a warning, at most once for each range of such failures in a window (the first, the second to fifth, and the sixth onward), so at most three times per window. Every such failure is counted, but none is sent while the device is offline: a range is sent with the first failure in it that happens while the device is online. Its message is WalletConnect's fixed wording with only the relay's host, none of the errors that caused it is sent, and it also carries these fixed values:

- **A WalletConnect relay connection that failed**: the label that says so (`walletconnect_relay`); whether the device's network connection had changed in the 30 seconds before (`just_changed` or `steady`); whether the App's window was on screen (`visible` or `hidden`); which App window it was (`popup`, `fullpage`, `sidepanel` or `confirm`); whether the connect-wallet screen was open in that window when the connection failed (`connect_modal` or `no_connect_modal`); whether the relay had connected in that window before (`true` or `false`); and how many relay failures that window had seen (`1`, `2-5` or `6+`). It never carries your connected wallet, its address, a session or pairing identifier, or the project key.

Crash reports do not include the page you were on, your browser's user-agent string, your language, your timezone, or a recording of your screen or clicks. Alongside the error, each report carries the time it happened, a severity level, its own random report id generated for that one report, and the name and version of the reporting library — the standard technical envelope, with nothing about you in it.

Please read "What scrubbing can and cannot promise" below, which is the honest limit of this.

### What we never collect

Not when the setting is on, not when it is off, not ever:

- Your private keys, recovery phrase, or password
- Your account addresses, balances, or transaction amounts
- The contents of your transactions, your notes, or your note IDs
- Your name, email address, or contacts
- Your location — the App asks for no location permission and reads no location sensor
- Your operating system version, your language or locale, your timezone, or your device model — see the note under "Usage data"
- Any advertising identifier, and anything that would let us or anyone else follow you across other apps or websites. The App does not show Apple's App Tracking Transparency prompt, because it has nothing to ask permission for.

And nothing collected is ever sold, or shared with data brokers or ad networks.

We also do not call this data anonymous. Sending anything over the internet means the receiving server sees the IP address the request came from, exactly as it does for any other network request — and an IP address indicates a rough region. Our processors are configured not to store it. A processor may still derive something coarse from it before discarding it, such as which country a request came from, and keep that alongside the message; we are not going to describe data as anonymous when a server saw where it came from.

## Identifiers

The App holds **no persistent identifier for you** — no user id, no device id, no install id, no cookie, no advertising identifier. Nothing in the usage data or the crash reports says "this is the same person as last week", or even "as yesterday".

Two short random numbers are involved, and both live only in memory:

- **One per activity.** Created when an activity starts, used only to match that activity's "started" message to its "ended" message, never written to disk, never reused. Once the activity is over, it is gone.
- **One per run of the App.** Created when the App starts and shared by the activities you perform in that run, so that a sequence like "opened the wallet, went to swap, changed your mind, sent instead" can be read as one visit rather than as unconnected fragments. It is never written to disk, so closing the App or reloading the extension ends it permanently and the next run gets an unrelated value. It also renews itself after 30 minutes with no activity, so a window left open does not accumulate a long trail.

**What that second number does and does not allow, stated plainly.** Within one run of the App, the activities you performed can be seen as belonging together. Across runs — and across devices, and across people — nothing can. This is a deliberate trade: the earlier design used the per-activity number for both purposes, and the result was data in which every session held exactly one activity and lasted zero seconds, which could not answer the only question the feature exists to answer, namely where people get stuck.

**One thing worth spelling out, because our provider's naming suggests otherwise.** Aptabase calls the field this number travels in a "session id", and their own libraries store it on your device and reuse it on a four-hour timeout — which makes it survive restarts. Ours does not exist anywhere but memory. That is also the only option available to us: the App has no way to store such a value at all, and a test asserts it stays that way.

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

Usage data goes straight from the App to Aptabase's European endpoint, one message per request, with no server of ours in between and nothing batched up in the meantime. We use neither company's own tracking library: the App builds each message itself, out of the fixed list of fields above, and sends it directly.

Both are configured to delete data after 90 days, to store no IP addresses, and to forward nothing onward. Neither is permitted to use the data for its own purposes, and no third party receives it for advertising or resale.

## How the App uses your device

For transparency about how the App functions on your device (this is not data we receive or have access to):

- Your wallet's recovery phrase, private keys, account names, transaction history, and balances are generated and held **only** on your device, encrypted at rest using your device's secure enclave (Android Keystore / iOS Secure Enclave) when biometric protection is enabled.
- This information never leaves your device unless **you** explicitly export it via the in-app "Encrypted Wallet File" export.

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

The App connects to the public Miden blockchain RPC endpoint (`rpc.testnet.miden.io`) and the Miden note transport service (`transport.miden.io`) to send and receive on-chain transactions. These requests contain only data needed to interact with the blockchain (transaction payloads, public account state) - never your private keys or recovery phrase.

It also downloads public data. Miden's verified-token list and update notices come from GitHub (`raw.githubusercontent.com`) and carry nothing about you. The logos of listed tokens come from the same GitHub list, so GitHub sees which listed tokens' logos the App draws (the listed tokens you hold or open), never your account, address or balance. Explore's catalog of apps and their icons come from GitHub too, so GitHub sees which network's catalog and which of its icons the App requests, never your account, address or balance. Token prices and charts come from Binance (`api.binance.com`), which sees which tokens' prices the App requests (the priced tokens you hold or open), never your address, keys or balances.

Three features send the service behind them only what that feature needs. Requesting test tokens sends your account address and the amount to the Miden faucet (`faucet-api.testnet.miden.io`). Tracking a bridge transfer sends its destination address to the bridge's status service (`miden-testnet-bridge.dev.eu-north-3.gateway.fm`). A swap quote sends the two tokens and their amounts to the swap-quote service (`35-175-40-181.sslip.io`), never your address.

If **Share usage data** is on, the App also reaches the two processors named above. If it is off, it does not contact them at all.

Apart from those token logos and Explore icons, and the site icons the dApp browser on mobile fetches from Google's favicon service, the App loads no fonts, scripts, or images from third-party servers. Everything else it needs to draw itself ships inside the App.

## Permissions

The App requests the following Android permissions:

- **INTERNET** - to reach the Miden RPC and transport endpoints and the services named under Network traffic
- **VIBRATE** — for haptic feedback on UI interactions
- **USE_BIOMETRIC** (Android 6+) — to unlock the wallet via fingerprint / face authentication

## Children

The App is not directed at children under 13. We do not knowingly collect any information from children.

## Changes

Material changes to this policy will be reflected on this page with an updated "Last updated" date.

## Contact

Open an issue at [github.com/0xMiden/wallet/issues](https://github.com/0xMiden/wallet/issues) or email privacy@miden.team.
