# Platform-authenticated unlock for the extension

Discovery for #846: can the Chrome extension offer optional Touch ID or Windows
Hello unlock through the WebAuthn PRF extension, where, with what limits, and
what would the first implementation be.

Dev-only doc: excluded from the published site in `docs/_config.yml`.

Codebase citations are `path:line` at commit `f43a1f5a7`. Chromium source links
are pinned to commit `30c2a44f` of the GitHub mirror (2026-09-28). `<id>`
stands for the extension id. A source marked "(secondary)" is a vendor blog,
a forum or another project's issue; anything not settled by a primary source or
by the probe is marked **Unconfirmed**.

## Decision summary

To be written.

## Today's vault

The extension already keeps the key that encrypts the wallet apart from the
secret that unlocks it. A platform unlock would add a second way to unwrap the
first; everything in this section stays as it is.

### The vault key

- A random 32-byte key encrypts every stored secret. `generateVaultKey()` draws
  it from `crypto.getRandomValues` and does not derive it from the password
  (`src/lib/miden/passworder.ts:196-207`).
- It is imported as an AES-GCM `CryptoKey` with `extractable` set to false and
  only the `encrypt` and `decrypt` usages
  (`src/lib/miden/passworder.ts:212-217`).
- Each of the three setup paths generates a new one: create or seed import
  (`src/lib/miden/back/vault.ts:855-856`), private-key import
  (`src/lib/miden/back/vault.ts:1273-1274`) and encrypted-file restore
  (`src/lib/miden/back/vault.ts:1497-1498`).
- Each secret is stored as the hex of a 16-byte random IV followed by the
  AES-GCM ciphertext of its JSON (`src/lib/miden/back/safe-storage.ts:73-77`,
  `src/lib/miden/passworder.ts:25-41`), under a storage key that is the hex
  SHA-256 of its entity name (`src/lib/miden/back/safe-storage.ts:138-141`).
  No additional authenticated data is passed
  (`src/lib/miden/passworder.ts:28-35`).
- The encrypted entities include the check value, the mnemonic, each account's
  auth, cold and EVM secret keys, public keys, the accounts list and settings
  (`src/lib/miden/back/vault.ts:214-230`).
- On the extension the store is `browser.storage.local`
  (`src/lib/platform/storage-adapter.ts:59-74`, chosen at
  `src/lib/platform/storage-adapter.ts:158-165`).

### The password wrapping

- The password becomes a PBKDF2 base key: the SHA-256 of its UTF-8 bytes
  (`src/lib/miden/passworder.ts:117-120`), imported as raw PBKDF2 key material
  (`src/lib/miden/passworder.ts:145-147`).
- `deriveKey` runs PBKDF2-HMAC-SHA256 with 10,310,000 iterations by default
  over a 32-byte random salt and yields a non-extractable AES-GCM-256 key
  (`src/lib/miden/passworder.ts:122-143`).
- `encryptVaultKeyWithPassword` encrypts the 32 vault-key bytes under that key
  with a 16-byte IV and returns base64 of salt (32 bytes), IV (16 bytes) and
  ciphertext with tag (`src/lib/miden/passworder.ts:239-257`);
  `decryptVaultKeyWithPassword` reverses it
  (`src/lib/miden/passworder.ts:267-281`).
- The result is saved in plain storage under the literal key
  `vault_key_password` (`src/lib/miden/back/vault.ts:211`,
  `src/lib/miden/back/vault.ts:907-908`), through `savePlain`, which does not
  hash the key name (`src/lib/miden/back/safe-storage.ts:104-106`).
- A comment in onboarding says 20.31M iterations
  (`src/app/pages/Welcome.tsx:615-618`); the code runs 10,310,000.

### Unlock, and where the key lives

1. The Unlock page calls `unlock(passcode)` (`src/app/pages/Unlock.tsx:330`).
   The store sends `UnlockRequest` with the password in the message
   (`src/lib/store/index.ts:179-185`) over a `runtime.connect` port named
   `INTERCOM` (`src/lib/intercom/client.ts:271`).
2. The service worker's handler calls `Actions.unlock`
   (`src/lib/miden/back/main.ts:476-480`), which runs `Vault.setup(password)`
   on the accounts write queue (`src/lib/miden/back/actions.ts:360-367`, queue
   alias at `src/lib/miden/back/actions.ts:106`).
3. `unlockWithPassword` reads `vault_key_password`, unwraps it and imports the
   bytes as the vault key (`src/lib/miden/back/vault.ts:807-827`). The `Vault`
   keeps that `CryptoKey` in a private field
   (`src/lib/miden/back/vault.ts:323`).
4. `unlocked({ vault, ... })` puts the vault into the service worker's store
   (`src/lib/miden/back/actions.ts:399-406`,
   `src/lib/miden/back/store.ts:98-107`). Pages receive only the state that
   `toFront` builds, which has no vault field
   (`src/lib/miden/back/store.ts:17-35`).
5. The extension page then reloads (`src/app/pages/Unlock.tsx:337-341`).

The unwrapped key lives only in service-worker memory. The popup never runs
`Actions.init` and never signs (`src/lib/miden/back/actions.ts:151-155`). No
code in `src` uses `chrome.storage.session`, so nothing of the unlock survives
a service-worker restart.

What locks it:

- A `LockRequest`: `lock()` replaces the store with a fresh state whose `vault`
  is null and retires the old vault (`src/lib/miden/back/actions.ts:341-358`,
  `src/lib/miden/back/store.ts:82-97`). The key is dropped, not zeroed.
- A service-worker restart: the store starts with `vault: null`
  (`src/lib/miden/back/store.ts:66-75`), and `start()` runs `Actions.init()`
  (`src/lib/miden/back/main.ts:94`), whose `inited(vaultExist)` sets the status
  to Locked (`src/lib/miden/back/actions.ts:162-165`,
  `src/lib/miden/back/store.ts:76-81`).
- Auto-lock after 10 minutes (`src/lib/fixed-times.ts:5-7`), always enabled
  (`src/lib/lock-up/index.ts:1-5`). The check runs in the page, not in the
  service worker: when a page opens as the only extension view and at least 10
  minutes have passed since `last-page-closure-timestamp`, it sends
  `LockRequest` (`src/lib/lock-up/checks.ts:11-32`,
  `src/lib/lock-up/checks.ts:90-95`). Open pages refresh the
  timestamp every 10 seconds (`src/lib/lock-up/checks.ts:46-63`), and the
  service worker stamps it when a page's `Popup Connection` port closes
  (`vite.background.config.ts:203-209`).

Wrong passwords are throttled in the page only: a lockout that grows by 60
seconds (`src/app/pages/Unlock.tsx:30`) for each three attempts
(`src/app/pages/Unlock.tsx:40-41`) and a random 1 to 3 second delay on later
attempts (`src/app/pages/Unlock.tsx:311`).

### Legacy wallets

- A wallet from before the vault-key model stores neither wrapped key. Unlock
  then falls back to `legacyPasswordUnlock`, which returns the PBKDF2 base key
  itself as the vault's key (`src/lib/miden/back/vault.ts:817-818`,
  `src/lib/miden/back/vault.ts:833-842`).
- In that mode every item carries its own 32-byte salt and its own PBKDF2 run
  (`src/lib/miden/back/safe-storage.ts:78-86`, read at
  `src/lib/miden/back/safe-storage.ts:42-51`), with a read fallback to 310,000
  iterations (`src/lib/miden/back/safe-storage.ts:169-180`,
  `src/lib/miden/passworder.ts:160-162`).
- Nothing migrates such a wallet: `vault_key_password` is written only by the
  three setup paths (`src/lib/miden/back/vault.ts:908`,
  `src/lib/miden/back/vault.ts:1342`, `src/lib/miden/back/vault.ts:1528`).
  Legacy wallets exist only on the extension
  (`src/lib/miden/back/protector-probe.ts:12-17`).
- A legacy wallet therefore has no random vault key for a second wrapping to
  protect.

### The mobile and desktop hardware protector

- On mobile and desktop a hardware key can wrap the same vault-key bytes:
  `setupHardwareProtector` encrypts the base64 vault key with the platform key
  and saves it as `vault_key_hardware`
  (`src/lib/miden/back/vault.ts:3071-3127`, key name at
  `src/lib/miden/back/vault.ts:212`).
- It replaces the password wrapping rather than sitting beside it. Setup takes
  `useHardwareOnly = !password` and stores `vault_key_hardware` in one branch
  and `vault_key_password` in the other
  (`src/lib/miden/back/vault.ts:877-909`; the same branch in the other setup
  paths at `src/lib/miden/back/vault.ts:1327-1343` and
  `src/lib/miden/back/vault.ts:1507-1529`). The protector probe says it
  directly: "wallet setup stores exactly one of them"
  (`src/lib/miden/back/protector-probe.ts:6-8`).
- A hardware-only wallet has no password path. A password is refused with
  "This wallet uses biometric unlock only"
  (`src/lib/miden/back/vault.ts:809-816`); a failed hardware unwrap ends in
  "Password required" (`src/lib/miden/back/vault.ts:650-656`), and the Unlock
  page then offers only "Try again" and "Reset Wallet"
  (`src/app/pages/Unlock.tsx:220-228`, `src/app/pages/Unlock.tsx:484-516`).
  Recovery is the seed phrase or an encrypted backup file.
- Onboarding picks hardware-only for the mobile biometric choice
  (`src/app/pages/Welcome.tsx:651-656`) and for every import on mobile or
  desktop when hardware reports available (`src/app/pages/Welcome.tsx:687-697`,
  `src/app/pages/Welcome.tsx:710-719`, `src/app/pages/Welcome.tsx:731-743`).
  Create on the extension and on desktop takes a password
  (`src/app/pages/Welcome.tsx:63-74`, `src/app/pages/Welcome.tsx:745-753`).
- The extension never uses it: the onboarding availability check,
  `hasHardwareProtector` and the Unlock page's hardware attempt all return
  early off mobile and desktop (`src/app/pages/Welcome.tsx:35-38`,
  `src/lib/miden/back/vault.ts:568-571`, `src/app/pages/Unlock.tsx:166-169`).
- The platform keys:
  - iOS: a Secure Enclave key created with
    `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` and only the
    `.privateKeyUsage` flag (`ios/App/App/LocalBiometricPlugin.swift:263-267`).
    The unlock plugin's comments expect a Face ID prompt at the key exchange
    (`ios/App/App/LocalBiometricPlugin.swift:482-484`), while the hot-key
    plugin states that `.privateKeyUsage` "does NOT prompt for authentication
    when the key is used" (`ios/App/App/HotKeyPlugin.swift:110-111`). Which one
    holds on a device is **Unconfirmed**.
  - Android: a Keystore AES-256-GCM key that requires authentication on every
    use, by strong biometric or device credential on API 30 and later
    (`android/app/src/main/java/com/miden/wallet/HardwareSecurityPlugin.kt:108-123`).
  - macOS desktop: a Secure Enclave key requiring user presence (Touch ID or
    the login password) and private-key usage, accessible when unlocked on
    this device only (`src-tauri/src/secure_storage/macos.rs:61-66`).
  - Windows desktop: a placeholder. It reports hardware available and no key,
    and every key operation returns "not yet implemented"
    (`src-tauri/src/secure_storage/windows.rs:13-38`,
    `src-tauri/src/secure_storage/windows.rs:50-70`), so a hardware-only setup
    there throws "Hardware security setup failed"
    (`src/lib/miden/back/vault.ts:885-889`). Linux desktop is not supported
    (`src-tauri/src/secure_storage/mod.rs:7`).

### Other password prompts

Unlock is not the only place the password is asked for. Each of these unwraps
the vault key again, which on the extension is a full PBKDF2 run. The issue
scopes the work to unlock; they are listed so that line is visible.

| Action | Where the vault key is unwrapped again |
|---|---|
| Reveal the seed phrase | `src/lib/miden/back/vault.ts:2695-2702` |
| Reveal an account's private key | `src/lib/miden/back/vault.ts:2722-2729` |
| Export the encrypted wallet file | `src/lib/miden/back/vault.ts:664-669` |
| Export an account file | `src/lib/miden/back/vault.ts:2746-2758` |
| Remove the seed phrase | `src/lib/miden/back/actions.ts:920-924` |
| Spending-limit strict authentication | `src/lib/miden/back/vault.ts:586-593`, via `src/lib/miden/back/actions.ts:613-615` |

Strict authentication picks the password on the extension
(`src/lib/auth/strict-action-authentication.ts:22-29`) and is required for
every spending-limit change except lowering an existing limit
(`src/lib/miden/spending-limits/change.ts:5-11`).

## Mechanism

What a platform unlock would add, in the terms of the code above. None of it
exists yet: nothing in the repo calls `navigator.credentials`.

### PRF, and the key it yields

- The WebAuthn `prf` extension asks the authenticator to evaluate a
  pseudo-random function bound to one credential over an input the caller
  chooses. The client first hashes the input as
  SHA-256("WebAuthn PRF" || 0x00 || input)
  ([WebAuthn Level 3 section 10.1.4][webauthn-l3], W3C Recommendation
  2026-08-25). With user verification, one credential and one input give the
  same output; the probe saw 32-byte outputs, equal for one salt and different
  for another (Support matrix, below).
- Over CTAP2 `hmac-secret` a credential has two PRFs, one used with user
  verification and one without, and WebAuthn exposes only the first
  ([WebAuthn Level 3 section 10.1.4][webauthn-l3]). Chromium raises user
  verification to at least "preferred" when PRF is requested and drops the PRF
  inputs when a verification-capable authenticator did not verify
  ([`get_assertion_request_handler.cc`][cr-get-assertion]). iCloud Keychain
  returned different values with and without verification, one reason Chrome
  disabled its PRF support before launch ([Chromium 58e4f0f7][cr-icloud-uv],
  2024-10-09), and an Apple engineer confirms the PRF uses "different seeds
  depending on whether UV (passcode/biometrics) was performed or not"
  ([Apple developer forums][apple-forum-prf], 2024-09). Every ceremony
  therefore asks for `userVerification: 'required'` and checks the UV flag.
- The output is key material, not a key. HKDF-SHA256 turns it into a
  non-extractable AES-GCM-256 key; WebCrypto's `deriveKey` supports HKDF with
  an AES-GCM target ([MDN `deriveKey`][mdn-derivekey], modified 2025-09-17).
  Proposed parameters: the PRF output as input keying material, the raw
  credential-id bytes (not their base64url text) as salt, and a versioned
  `info` such as `miden-wallet:vault-key-platform:v1`.
- That key wraps the same 32 vault-key bytes the password wraps, under a fresh
  random 12-byte IV, the length NIST recommends for GCM
  ([NIST SP 800-38D][nist-gcm], 2007-11). The repo's other AES-GCM uses take
  16-byte IVs (`src/lib/miden/passworder.ts:27`,
  `src/lib/miden/passworder.ts:244`); the new record does not copy that.
- The additional authenticated data is one version byte followed by the raw
  credential-id bytes, so a record cannot be replayed under another version or
  credential.
- The vault key and every item encrypted under it stay as they are.

### The stored record

A third plain-storage key, `vault_key_platform`, next to the other two
(`src/lib/miden/back/vault.ts:210-212`) and written the same way
(`src/lib/miden/back/safe-storage.ts:104-106`):

| Field | Content |
|---|---|
| `version` | Record format, starting at 1; carried in the HKDF `info` and as the first byte of the additional data |
| `credentialId` | The credential's raw id, stored as base64url; passed in `allowCredentials` at unlock, and its raw bytes are the HKDF salt and follow the version byte in the additional data |
| `prfSalt` | 32 random bytes, the PRF input, one per credential |
| `rpId` | `chrome-extension://<id>` at enrollment, so a changed extension id is caught before a ceremony |
| `wrappedKey` | 12-byte IV, then AES-GCM ciphertext and tag of the 32 vault-key bytes |

The salt is not secret: it is stored next to the wrapped key.

### Where the ceremony runs

- In an extension page: the popup, side panel, full-page tab or confirm window
  (Surfaces and focus, below).
- Never in the service worker. `CredentialsContainer` is exposed on `Window`
  only ([Credential Management][credman], editor's draft, read 2026-09-28),
  and the probe found `'credentials' in navigator` false in an MV3 service
  worker.
- Not in the offscreen document the service worker already spawns for
  proving (`vite.extension.config.ts:399-402`): offscreen documents "can't be
  focused" ([chrome.offscreen][chrome-offscreen], read 2026-09-28), and Chrome
  refuses WebAuthn from a page that is not visible (Surfaces and focus). That a
  ceremony fails there is an inference, **Unconfirmed**.

### How the result reaches the service worker

Unlock, as proposed:

1. The page gets the record's credential id and salt, both public.
2. It runs `navigator.credentials.get()` with that id in `allowCredentials`,
   `userVerification: 'required'`, a random challenge and
   `prf: { eval: { first: prfSalt } }`.
3. It sends the 32-byte PRF output to the service worker in an unlock request
   over the same `INTERCOM` port the password travels on today
   (`src/lib/store/index.ts:179-185`, `src/lib/intercom/client.ts:271`).
4. The service worker derives the wrapping key, unwraps the vault-key bytes,
   imports them with `importVaultKey` and continues exactly as `Vault.setup`
   does after `unlockWithPassword` (`src/lib/miden/back/vault.ts:647-662`).

No server checks the assertion's signature. The AES-GCM tag is the check: a
wrong PRF output fails the unwrap, and the service worker reports a failed
unlock as it does for a wrong password.

### Why enrollment needs the password

- The unlocked vault holds only a non-extractable `CryptoKey`
  (`src/lib/miden/back/vault.ts:323`, imported non-extractable at
  `src/lib/miden/passworder.ts:216`). WebCrypto refuses to export such a key
  with `InvalidAccessError` ([MDN `exportKey`][mdn-exportkey], modified
  2024-09-25), so the repo's `exportKey` helper
  (`src/lib/miden/passworder.ts:222-226`) cannot recover its bytes.
- The raw 32 bytes exist only by unwrapping `vault_key_password` again with
  the password (`src/lib/miden/passworder.ts:267-281`). Enrollment therefore
  asks for the password, which also shows that the person enrolling knows it.

Enrollment, as proposed:

1. The page asks for the password and runs `navigator.credentials.create()`
   with the default RP ID (no `rp.id`), `userVerification: 'required'` and
   `prf: { eval: { first: prfSalt } }` for a new random salt.
2. Outputs at create are optional ([WebAuthn Level 3 section
   10.1.4][webauthn-l3]). If the response has no `prf.results.first`, the page
   runs `get()` once with the new credential in `allowCredentials`. No output
   from either means the authenticator has no PRF, and enrollment stops with
   nothing stored in the wallet. The `create()` has already made a credential
   in the provider, though: on macOS the likely case is a Chrome-profile
   passkey, which stays listed in `chrome://settings/passkeys` until the user
   deletes it there ([Chromium 5c360860][cr-cbd-m126]).
   `signalUnknownCredential` is known to hide only GPM entries
   ([delegate][cr-delegate]); its effect on iCloud Keychain is
   **Unconfirmed**.
3. The page sends the password, credential id, salt and PRF output to the
   service worker.
4. The service worker unwraps the vault-key bytes with the password, wraps
   them under the PRF-derived key, unwraps the result once to check it, and
   only then saves `vault_key_platform`.

A legacy wallet has no `vault_key_password` to unwrap, so this path does not
apply to it as written.

## Support matrix

Chrome stable on 2026-09-28 is 155 ([Chromium Dash][chromiumdash]). The
manifest accepts Chrome 114 and later (`public/manifest.json:58`), older than
every PRF release below, so no row can be assumed from the Chrome version
alone.

| OS | Authenticator Chrome uses | PRF | Since | Synced | Source |
|---|---|---|---|---|---|
| macOS | Chrome profile (Chrome's own Touch ID store) | No | never | No | [`authenticator.mm`][cr-mac-authenticator] sets no `supports_prf` (default false, [`authenticator_supported_options.h`][cr-supported-options]); [MetaMask #45783][metamask-45783] (2026-08-26, secondary) |
| macOS 15+ | iCloud Keychain | Yes, create and get; with a `chrome-extension://` RP ID **Unconfirmed** | Chrome 132 (stable 2025-01-14) | Yes | [`icloud_keychain.mm`][cr-icloud]; [Chromium 52fceaad][cr-icloud-launch] (2025-03-17, "launched since M132"); [Apple][apple-icloud-security] (2024-09-16) |
| macOS, Windows, Linux, ChromeOS | Google Password Manager | Yes, create and get; with a `chrome-extension://` RP ID, secondary evidence only | GPM desktop passkeys, 2024-09-19 | Yes | [`enclave_protocol_utils.cc`][cr-enclave]; [`webauthn_credential_specifics.proto`][cr-gpm-proto]; [Google][google-gpm-blog] (2024-09-19); extension RP ID: [MetaMask #46400][metamask-46400] (2026-09-16, secondary) |
| Windows 11 | Windows Hello, through `webauthn.dll` | **Unconfirmed** | Chrome passes PRF at get on every Windows API version; at create from Chrome 147 (stable 2026-04-07), and only where `webauthn.dll` reports API version 8 or later (`supports_hmac_secret_mc = api_version >= WEBAUTHN_API_VERSION_8`); which Windows build ships API version 8 is **Unconfirmed** | No | [`win/authenticator.cc`][cr-win-authenticator] ([line 68][cr-win-hmac-mc]); [Chromium af1aabea][cr-win-prf-create] (2026-02-23); [Microsoft `webauthn.h`][ms-webauthn-v8] (API version 8 added 2025-01-30); [Bitwarden forum][bitwarden-hello-thread] (2026-03-23, secondary); [MetaMask #46400][metamask-46400] (2026-09-16, secondary) |
| Windows 10 | Windows Hello | No, **Unconfirmed** | - | No | [Corbado][corbado] (2026-09-22, secondary); [Bitwarden help][bitwarden-help-passkeys] (read 2026-09-28, secondary) |
| Linux | No OS authenticator; Google Password Manager only | Yes, through GPM | as GPM | Yes | [Google supported environments][google-envs] (updated 2025-05-19) |
| ChromeOS | ChromeOS platform authenticator | No | - | No | [`cros/authenticator.cc`][cr-cros] |
| any | Security key with CTAP2 `hmac-secret` | Yes, if the key supports `hmac-secret` | Chrome 116 | No | [MDN browser-compat-data][mdn-bcd] (8.1.3, 2026-09-24); [blink-dev intent][blink-dev-prf] (2023-04-29) |

Notes on the rows:

- On macOS Chrome offers three stores: its own profile store, iCloud Keychain
  (macOS 13.5+) and Google Password Manager
  ([Google supported environments][google-envs]). iCloud Keychain became the
  default in Chrome 118 ([Chrome blog][chrome-icloud-blog], 2023-10-03); which
  store Chrome offers first now that GPM also saves desktop passkeys is
  **Unconfirmed**.
- Windows Hello: Chrome maps PRF onto `hmac-secret` for `webauthn.dll`
  ([`win/authenticator.cc`][cr-win-authenticator]). A community report saw PRF
  assertions from Hello on Windows 11 25H2 build 26200.8037
  ([Bitwarden forum][bitwarden-hello-thread], secondary), and Corbado ties it
  to update KB5077181 ([Corbado][corbado], secondary), but that update's
  release notes ([Microsoft][ms-kb5077181]) and Microsoft's passkeys page
  ([Microsoft Learn][ms-passkeys], 2026-05-12) do not mention PRF. MetaMask,
  whose RP ID is also its extension origin, reports that Windows Hello fails
  its PRF check ([MetaMask #46400][metamask-46400], secondary). A device test
  on a current Windows 11 with Chrome 147 or later settles it.
- Windows 11 24H2 and later ask for per-app passkey consent; if the user
  declines, passkeys stop working for that app
  ([Microsoft Learn][ms-passkeys], 2026-05-12).
- iCloud Keychain with an RP ID of `chrome-extension://<id>` is
  **Unconfirmed**; MetaMask lists the same open question
  ([MetaMask #46400][metamask-46400], secondary).
- Telling synced from device-bound: `authenticatorAttachment: 'platform'`
  admits iCloud Keychain and GPM, and `hints` are advisory
  ([Chrome blog][chrome-hints]). The backup-eligibility (BE) flag in the
  authenticator data is readable only after creation
  ([WebAuthn Level 3][webauthn-l3]); GPM sets it
  ([`passkey_model_utils.cc`][cr-passkey-model-utils]) and Chrome's macOS
  profile store never does: its `MakeAuthenticatorData` sets only the UP, UV
  and AT flags ([`mac/util.mm`][cr-mac-util]).
- Capability detection cannot answer for the authenticator: Blink returns
  `extension:prf` true from `getClientCapabilities()` unconditionally
  ([`public_key_credential.cc`][cr-pkc], Chrome 133+). Only a PRF result from
  a real ceremony shows support.

### Extension-origin constraints

- Chrome lets `chrome-extension://` pages of an enabled extension call
  WebAuthn ([`chrome_web_authentication_delegate.cc`][cr-delegate],
  `OverrideCallerOriginAndRelyingPartyIdValidation`), and Chromium's guidance
  is to leave the RP ID blank ([`origins.md`][cr-origins-md]).
- The default RP ID is rewritten to the whole origin,
  `chrome-extension://<id>` ([delegate][cr-delegate],
  `MaybeGetRelyingPartyIdOverride`;
  [`authenticator_common_impl.cc`][cr-authenticator-common];
  [MDN][mdn-ext-webauthn], modified 2026-07-08).
- The id, and with it the RP ID, is derived from the extension's key, so a Web
  Store reinstall keeps it ([`id_util.h`][cr-id-util];
  [manifest `key`][chrome-manifest-key], read 2026-09-28). Whether another
  store (Edge Add-ons) gives the same id is **Unconfirmed**.
- A web RP ID needs a host permission: allowed from Chrome 122
  ([W3C list][w3c-list-2023], 2023-12; [MDN][mdn-ext-webauthn]), and since
  Chrome 148 only for the exact `https://<rp id>` origin
  ([Chromium ecf43dd2][cr-m148-host], 2026-03-30). The wallet's manifest grants
  `https://*.miden.fi/*` among its host permissions
  (`public/manifest.json:26-31`); whether that lets it claim `miden.fi` under
  the Chrome 148 rule is **Unconfirmed**.
- Related Origin Requests do not help: a non-HTTP(S) caller is refused before
  they are consulted ([`webauthn_security_utils.cc`][cr-security-utils]).
- No service worker ([Credential Management][credman]; probe, below).

### What the probe showed

A CDP virtual authenticator (`ctap2`, `internal`, resident keys, user
verification) in Chrome for Testing 149.0.7827.55, driving a minimal MV3
extension page with the wallet's CSP and isolation headers
(`public/manifest.json:33-41`). The method and full results are in the
appendix. Excerpt of `probe-results.json`:

```json
{
  "chromium": "149.0.7827.55",
  "create": {
    "ok": true,
    "rpIdHashMatches": "chrome-extension://<id>",
    "prfEnabled": true,
    "prfFirstAtCreateLength": 32
  },
  "get": {
    "ok": true,
    "prfFirstLength": 32,
    "sameSaltSameOutput": true,
    "otherSaltDifferentOutput": true
  },
  "capabilityWithoutPrf": true,
  "serviceWorkerHasCredentials": false
}
```

| Row | What it shows | What it does not show |
|---|---|---|
| RP ID | `create()` and `get()` succeed from an extension page; the RP ID hashed into the authenticator data is the full `chrome-extension://<id>` origin | The same on a real platform authenticator |
| PRF | A virtual authenticator evaluates PRF at create and get, the same bytes for one salt and different bytes for another | Anything about Touch ID, iCloud Keychain, GPM or Windows Hello |
| Capability | `getClientCapabilities()['extension:prf']` stayed true with an authenticator set to `hasPrf: false`, so the flag cannot predict a device's PRF support | Nothing further |
| Service worker | `navigator.credentials` does not exist in the MV3 service worker, so the ceremony must run in a page | Nothing further |
| Web RP ID | `rp.id: 'example.com'` without a host permission was refused with `SecurityError` | Which check fired: the message is Chromium's generic origin text |

## Surfaces and focus

### Where unlock can run

The build's HTML entries are listed at `vite.extension.config.ts:394-398`.
`options.html` renders only a reset page, not the wallet
(`src/options.tsx:26-32`, `src/options.tsx:42-66`), so it never shows Unlock.
A locked wallet shows Unlock in the popup, side panel and full-page tab
through the router (`src/app/PageRouter.tsx:140-145`), and in the confirm
window through `ConfirmPage` instead (`src/app/App.tsx:88-89`,
`src/app/ConfirmPage.tsx:67-68`). The confirm window renders as
`WindowType.Popup` (`src/confirm.tsx:20`), so like the popup and side panel it
counts as compact (`src/app/env.ts:38-40`), and Forgot password closes it
(`src/app/pages/Unlock.tsx:392-402`).

| Surface | Entry | How it opens | Notes |
|---|---|---|---|
| Popup | `popup.html`, `src/popup.tsx:27` | Toolbar action (`public/manifest.json:67-68`) | Opens the full page and closes itself when it is not a real popup or popup mode is off (`src/popup.tsx:29-33`); popup mode defaults to on and no code turns it off (`src/lib/popup-mode/index.ts:1-13`) |
| Side panel | `sidepanel.html`, `src/sidepanel.tsx:22` | Declared at `public/manifest.json:63-65`; after onboarding it becomes the toolbar's action (`src/lib/extension/side-panel-handoff.ts:66-96`) | |
| Full-page tab | `fullpage.html`, `src/fullpage.tsx:23` | `openInFullPage` (`src/app/env.ts:136-148`); on first install (`vite.background.config.ts:197-202`) | |
| Confirm window | `confirm.html`, `src/confirm.tsx:20` | `windows.create({ type: 'popup' })`, 380 by 676 (`src/lib/miden/back/dapp.ts:273-275`, `src/lib/miden/back/dapp.ts:2484-2491`) | Renders its own Unlock (`src/app/ConfirmPage.tsx:67-68`); declines the dApp request after 120 seconds (`src/lib/miden/back/dapp.ts:276`, `src/lib/miden/back/dapp.ts:2516`) |

### Chrome's visibility requirement

- Chrome ends a create or get with `NOT_FOCUSED` when the page is not focused
  ([`authenticator_common_impl.cc`][cr-authenticator-common]), and for Chrome
  "focused" means the page's WebContents is `VISIBLE`
  ([delegate][cr-delegate]).
- Chromium's tests pin the behaviour: the error is "NotAllowedError: The
  operation is not allowed at this time because the page does not have
  focus."; opening a new tab during a request fails it; opening a new window
  does not ([`webauthn_focus_interactive_uitest.cc`][cr-focus-test]).
- The WebAuthn Level 3 Recommendation dropped its advice to abort when the
  document loses focus ([WebAuthn Level 3][webauthn-l3], changes section), so
  this is Chrome's rule, not the spec's.

### The popup and the native OS sheets

Known from Chromium source:

- An extension popup does not close because the OS focuses another app. It
  closes when another widget in the browser window's widget tree activates or
  the active tab changes ([`extension_popup.cc`][cr-extension-popup];
  [Chromium ec62e3da][cr-popup-m126], 2024-05-02, Chrome 126).
- From Chrome 133 a popup stays open while a web-modal dialog such as Chrome's
  own WebAuthn dialog is showing; the bug it fixed was titled
  "navigator.credentials.create and navigator.credentials.get leads to
  extension focus loss and close" ([Chromium eb80440c][cr-popup-m133],
  2024-11-25).
- A change landed on 2026-09-21, after the Chrome 155 branch, force-closes
  popups whenever a security dialog (WebAuthn, FedCM, Payment Request) is
  present, except dialogs that descend from the popup's own widget
  ([Chromium 4b8e494e][cr-popup-m156]). It ships in Chrome 156 at the
  earliest.

**Unconfirmed**, and not testable with the probe, whose virtual authenticator
shows no UI:

- Whether a popup survives the native sheets Chrome hands off to: the Windows
  Hello dialog from `webauthn.dll` and the macOS passkey sheet for iCloud
  Keychain. Read from the code above, focus returning to the browser window
  when the sheet closes activates a widget in its tree, which would close the
  popup and drop the pending promise.
- Whether the Chrome 156 force-close applies to a ceremony started from the
  popup.
- Whether Chrome's WebAuthn dialog is still clipped inside a popup, as
  reported for Chrome 107 on ChromeOS
  ([bitwarden/clients#4365][bitwarden-4365], 2022-12-31, secondary).
- Field reports: Bitwarden's passkey unlock fails in its popup on Linux unless
  popped out ([Bitwarden forum][bitwarden-popout], Chrome 145, 2026-02,
  secondary); MetaMask documents that a cancelled or failed prompt in its side
  panel is not reported for up to 30 seconds
  ([MetaMask help][metamask-help], read 2026-09-28, secondary).

### The tab or window fallback

- A full-page tab or a `windows.create({ type: 'popup' })` window, as the
  confirm window already is, runs the ceremony in an ordinary browser window.
  The ceremony has to start there: a new tab opened during a request fails it
  ([`webauthn_focus_interactive_uitest.cc`][cr-focus-test]).
- The repo already moves one flow this way: Forgot password opens the full
  page and closes the compact window (`src/app/pages/Unlock.tsx:392-402`,
  `src/app/env.ts:136-148`).
- Prior art does the same: Bitwarden forces a popout for passkey login on
  Linux ([`platform-popout.guard.ts`][bitwarden-guard], secondary), and
  MetaMask points side-panel users to full screen and caps side-panel
  ceremonies at 30 seconds ([`passkey-ceremony.ts`][metamask-ceremony],
  secondary).

## Lifecycle

The record lives in this profile's `chrome.storage.local`; the credential
lives with its provider. An event can remove either. `vault_key_password` sits
in the same storage as `vault_key_platform`, so an event that wipes the storage
removes both, and recovery is then the seed phrase or an encrypted backup file,
as it is today.

| Event | What happens to the credential | What the user sees | Password still unlocks? |
|---|---|---|---|
| Enrollment | A new credential under RP ID `chrome-extension://<id>` in the provider Chrome offers (which one comes first on macOS: **Unconfirmed**); `vault_key_platform` is written next to `vault_key_password`. An authenticator with no PRF output leaves nothing in the wallet, but `create()` has already made its credential: on macOS most likely a Chrome-profile passkey, which stays listed in `chrome://settings/passkeys` ([Chromium 5c360860][cr-cbd-m126]). `signalUnknownCredential` is known to hide only GPM entries ([delegate][cr-delegate]); for iCloud Keychain **Unconfirmed**. | The password prompt, then Chrome's or the OS's passkey sheet; on a refusal, a message that this authenticator cannot be used, and a leftover entry in that provider. | Yes: `vault_key_password` is not touched. |
| Re-enrollment | The new record replaces `vault_key_platform`; the old credential stays in its provider unless removed. `PublicKeyCredential.signalUnknownCredential` (Chrome 132+, [MDN browser-compat-data][mdn-bcd]) asks the provider to hide it; Chrome acts on it for GPM ([delegate][cr-delegate]), and for iCloud Keychain it is **Unconfirmed**. After Forgot password, setup wipes every storage key but the preserved ones (`src/lib/miden/reset.ts:22-42`, `src/lib/miden/reset.ts:67-81`), so the record goes and the new vault key needs a new enrollment. | The enrollment flow again; the old entry may stay listed in the provider. | Yes. |
| Device loss | The record was on the lost device. A synced credential (iCloud Keychain, GPM) stays usable elsewhere but has no record to unwrap there; a device-bound one is gone. | On a new device: restore from the seed phrase or a backup file, set a password, enroll again. | Not applicable: the vault was on the lost device; recovery is the seed phrase or backup, as today. |
| Browser-profile reset | Deleting the profile deletes its `chrome.storage.local`, record included. "Reset settings" resets "Extensions and themes" and "Cookies and site data" and keeps saved passwords ([Chrome Help][chrome-reset], read 2026-09-28); whether extension storage survives it is **Unconfirmed**. iCloud Keychain, GPM and Windows Hello keep the credential outside the profile (**Unconfirmed** as documented behaviour). | Profile deleted: onboarding. Reset settings: unlock as before if storage survived (**Unconfirmed**). | Yes while the storage survives; both wrappings go if it does not. |
| Clearing browsing data | `chrome.storage.local` persists when the user clears cache and history ([chrome.storage][chrome-storage], read 2026-09-28). Chrome's macOS profile passkeys left Clear Browsing Data in Chrome 126 ([Chromium 5c360860][cr-cbd-m126], 2024-05-09), and the remover deletes platform credentials only on ChromeOS ([remover delegate][cr-cbd]). Whether clearing passwords removes GPM passkeys: **Unconfirmed** (the remover has no GPM passkey deletion). | Nothing changes. | Yes. |
| Uninstall and Web Store reinstall | Removal clears `chrome.storage.local` ([chrome.storage][chrome-storage]), so both wrapped keys go. The credential stays in its provider under `chrome-extension://<id>` (how it is listed: **Unconfirmed**). The reinstalled extension keeps its id and RP ID ([`id_util.h`][cr-id-util]) but has no record for the old credential. From another store the id may differ: **Unconfirmed**. | A fresh install opens onboarding in a tab (`vite.background.config.ts:197-202`); restore from the seed phrase or backup, then enroll again. | No: `vault_key_password` is gone too; recovery is the seed phrase or backup, as today. |
| Windows Hello PIN reset | A destructive PIN reset deletes the keys in the user's Windows Hello container, listed for Microsoft accounts ([Microsoft Learn][ms-pin-reset], 2026-03-29). Whether consumer passkeys sit in that container: **Unconfirmed**. Reports conflict on whether a PIN change drops passkeys ([Microsoft Q&A][ms-qa-pin], 2025-05, secondary). | Platform unlock fails with no credential found; the password form. | Yes. |
| Touch ID re-enrollment | Chrome's profile keys use private-key usage and user presence, not the current biometric set ([`credential_store.mm`][cr-credential-store]), so a new fingerprint does not invalidate them (inference); they have no PRF anyway. For iCloud Keychain passkeys Apple documents nothing: **Unconfirmed**. | Expected: nothing. If the credential stopped working: the password form. | Yes. |
| A synced passkey on another device | GPM syncs the credential's `hmac-secret` inside its encrypted entity ([`webauthn_credential_specifics.proto`][cr-gpm-proto]). For iCloud Keychain an Apple engineer wrote that PRF values over hybrid differing from local ones was a bug that "should be fixed in the current iOS 18.4 and macOS 15.4 betas" ([Apple developer forums][apple-forum-prf], 2025-02). A GPM passkey therefore yields the same PRF output on every synced device; for iCloud Keychain that is the expected reading, **Unconfirmed**. The record exists only in this profile. | The passkey is listed in the provider on the user's other devices. Another install of the wallet has no record for it and does not offer platform unlock until it enrolls its own. | Yes, on every install. |

## Security comparison

To be written.

## Recommendation and scope

To be written.

## Open questions

To be written.

## Appendix: probe

To be written.

[apple-forum-prf]: https://developer.apple.com/forums/thread/764730
[apple-icloud-security]: https://support.apple.com/en-us/102195
[bitwarden-4365]: https://github.com/bitwarden/clients/issues/4365
[bitwarden-guard]: https://github.com/bitwarden/clients/blob/main/apps/browser/src/auth/popup/guards/platform-popout.guard.ts
[bitwarden-hello-thread]: https://community.bitwarden.com/t/encryption-prf-via-windows-hello-passkey/94236/21
[bitwarden-help-passkeys]: https://bitwarden.com/help/login-with-passkeys/
[bitwarden-popout]: https://community.bitwarden.com/t/unlock-with-passkey-does-not-unlock-unless-popped-out/93649
[blink-dev-prf]: https://groups.google.com/a/chromium.org/g/blink-dev/c/iTNOgLwD2bI
[chrome-hints]: https://developer.chrome.com/blog/passkeys-updates-chrome-129
[chrome-icloud-blog]: https://developer.chrome.com/blog/passkeys-on-icloud-keychain
[chrome-manifest-key]: https://developer.chrome.com/docs/extensions/reference/manifest/key
[chrome-offscreen]: https://developer.chrome.com/docs/extensions/reference/api/offscreen
[chrome-reset]: https://support.google.com/chrome/answer/3296214
[chrome-storage]: https://developer.chrome.com/docs/extensions/reference/api/storage
[chromiumdash]: https://chromiumdash.appspot.com/releases?platform=Mac
[corbado]: https://www.corbado.com/blog/passkeys-prf-webauthn
[cr-authenticator-common]: https://github.com/chromium/chromium/blob/30c2a44f19b32e0dc50175f3fa392ec41bd741e6/content/browser/webauth/authenticator_common_impl.cc
[cr-cbd]: https://github.com/chromium/chromium/blob/30c2a44f19b32e0dc50175f3fa392ec41bd741e6/chrome/browser/browsing_data/chrome_browsing_data_remover_delegate.cc
[cr-cbd-m126]: https://chromium.googlesource.com/chromium/src/+/5c36086096ecd6c6f90762a1ae032eba71f0cf68
[cr-credential-store]: https://github.com/chromium/chromium/blob/30c2a44f19b32e0dc50175f3fa392ec41bd741e6/device/fido/mac/credential_store.mm
[cr-cros]: https://github.com/chromium/chromium/blob/30c2a44f19b32e0dc50175f3fa392ec41bd741e6/device/fido/cros/authenticator.cc
[cr-delegate]: https://github.com/chromium/chromium/blob/30c2a44f19b32e0dc50175f3fa392ec41bd741e6/chrome/browser/webauthn/chrome_web_authentication_delegate.cc
[cr-enclave]: https://github.com/chromium/chromium/blob/30c2a44f19b32e0dc50175f3fa392ec41bd741e6/device/fido/enclave/enclave_protocol_utils.cc
[cr-extension-popup]: https://github.com/chromium/chromium/blob/30c2a44f19b32e0dc50175f3fa392ec41bd741e6/chrome/browser/ui/views/extensions/extension_popup.cc
[cr-focus-test]: https://github.com/chromium/chromium/blob/30c2a44f19b32e0dc50175f3fa392ec41bd741e6/chrome/browser/webauthn/webauthn_focus_interactive_uitest.cc
[cr-get-assertion]: https://github.com/chromium/chromium/blob/30c2a44f19b32e0dc50175f3fa392ec41bd741e6/device/fido/get_assertion_request_handler.cc
[cr-gpm-proto]: https://github.com/chromium/chromium/blob/30c2a44f19b32e0dc50175f3fa392ec41bd741e6/components/sync/protocol/webauthn_credential_specifics.proto
[cr-icloud]: https://github.com/chromium/chromium/blob/30c2a44f19b32e0dc50175f3fa392ec41bd741e6/device/fido/mac/icloud_keychain.mm
[cr-icloud-launch]: https://chromium.googlesource.com/chromium/src/+/52fceaad1b36e8e93938e5aa457964ecf44e3216
[cr-icloud-uv]: https://chromium.googlesource.com/chromium/src/+/58e4f0f7ccfa9a725a1dee6f08ca6bd3886b72a1
[cr-id-util]: https://github.com/chromium/chromium/blob/30c2a44f19b32e0dc50175f3fa392ec41bd741e6/components/crx_file/id_util.h
[cr-m148-host]: https://chromium.googlesource.com/chromium/src/+/ecf43dd2aa505fc586380559884f304e1846c32d
[cr-mac-authenticator]: https://github.com/chromium/chromium/blob/30c2a44f19b32e0dc50175f3fa392ec41bd741e6/device/fido/mac/authenticator.mm
[cr-mac-util]: https://github.com/chromium/chromium/blob/30c2a44f19b32e0dc50175f3fa392ec41bd741e6/device/fido/mac/util.mm#L92-L106
[cr-origins-md]: https://github.com/chromium/chromium/blob/30c2a44f19b32e0dc50175f3fa392ec41bd741e6/content/browser/webauth/origins.md
[cr-passkey-model-utils]: https://github.com/chromium/chromium/blob/30c2a44f19b32e0dc50175f3fa392ec41bd741e6/components/webauthn/core/browser/passkey_model_utils.cc
[cr-pkc]: https://github.com/chromium/chromium/blob/30c2a44f19b32e0dc50175f3fa392ec41bd741e6/third_party/blink/renderer/modules/credentialmanagement/public_key_credential.cc
[cr-popup-m126]: https://chromium.googlesource.com/chromium/src/+/ec62e3daab1452a7aab97e017ba6d236f048d3d2
[cr-popup-m133]: https://chromium.googlesource.com/chromium/src/+/eb80440c5a1533072b9605c87746f0ef77740d47
[cr-popup-m156]: https://chromium.googlesource.com/chromium/src/+/4b8e494ea39fbac80a26968fa0189502a263bec6
[cr-security-utils]: https://github.com/chromium/chromium/blob/30c2a44f19b32e0dc50175f3fa392ec41bd741e6/components/webauthn/core/browser/webauthn_security_utils.cc
[cr-supported-options]: https://github.com/chromium/chromium/blob/30c2a44f19b32e0dc50175f3fa392ec41bd741e6/device/fido/authenticator_supported_options.h
[cr-win-authenticator]: https://github.com/chromium/chromium/blob/30c2a44f19b32e0dc50175f3fa392ec41bd741e6/device/fido/win/authenticator.cc
[cr-win-hmac-mc]: https://github.com/chromium/chromium/blob/30c2a44f19b32e0dc50175f3fa392ec41bd741e6/device/fido/win/authenticator.cc#L68
[cr-win-prf-create]: https://chromium.googlesource.com/chromium/src/+/af1aabea3579861072872d9209bad47b3ff5b8e6
[credman]: https://w3c.github.io/webappsec-credential-management/
[google-envs]: https://developers.google.com/identity/passkeys/supported-environments
[google-gpm-blog]: https://blog.google/innovation-and-ai/technology/safety-security/google-password-manager-passkeys-update-september-2024/
[mdn-bcd]: https://github.com/mdn/browser-compat-data
[mdn-derivekey]: https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey
[mdn-exportkey]: https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/exportKey
[mdn-ext-webauthn]: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Use_the_web_authn_api
[metamask-45783]: https://github.com/MetaMask/metamask-extension/issues/45783
[metamask-46400]: https://github.com/MetaMask/metamask-extension/pull/46400
[metamask-ceremony]: https://github.com/MetaMask/metamask-extension/blob/main/shared/lib/passkey/passkey-ceremony.ts
[metamask-help]: https://support.metamask.io/configure/wallet/passkeys/
[ms-kb5077181]: https://support.microsoft.com/en-us/topic/february-10-2026-kb5077181-os-builds-26200-7840-and-26100-7840-f0fa9e54-a22a-4a06-96b6-bf5b2aded506
[ms-passkeys]: https://learn.microsoft.com/en-us/windows/security/identity-protection/passkeys/
[ms-pin-reset]: https://learn.microsoft.com/en-us/windows/security/identity-protection/hello-for-business/pin-reset
[ms-qa-pin]: https://learn.microsoft.com/en-us/answers/questions/3856049/
[ms-webauthn-v8]: https://github.com/microsoft/webauthn/commit/706d98d73a8c3d888e77f0d524f630d551b194c3
[nist-gcm]: https://csrc.nist.gov/pubs/sp/800/38/d/final
[w3c-list-2023]: https://lists.w3.org/Archives/Public/public-webauthn/2023Dec/0078.html
[webauthn-l3]: https://www.w3.org/TR/webauthn-3/
