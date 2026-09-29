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

**Go.** The owner took the decisions below on #846, so the implementation builds
passkey unlock on macOS 15 or later and Windows 11, the systems the owner's
device test runs on (milestone 1): iCloud Keychain with Touch ID and Google
Password Manager on macOS 15 or later, and Windows Hello and Google Password
Manager on Windows 11, each where that test shows it returning a PRF output for
the extension's RP ID with user verification (Go/no-go). Linux, ChromeOS,
Windows 10 and macOS before 15 keep password-only unlock until a device test
covers them from the side panel and the confirm window (questions 2 and 26).

WebAuthn PRF, allowed in extension pages, can wrap the vault key a second time,
leaving the password wrapping and seed recovery as they are. Chrome's Touch ID
store has no PRF; iCloud Keychain and Google Password Manager sync the
credential and have PRF, with the extension's RP ID **Unconfirmed**; Windows
Hello's PRF is **Unconfirmed**. A synced passkey adds a second route: a copy of
this profile's storage plus the user's Apple or Google account. The existing
route, the copy plus enough password guesses, stays. A device test on macOS 15+
and Windows 11 comes first and stops the work if none passes.

Owner decisions, all taken on #846:

1. Accept synced PRF passkeys as the second wrapping.
2. Accept the OS password or PIN as equal to Touch ID or Windows Hello,
   which the wallet cannot tell apart.
3. No periodic password check: platform unlock works until the user disables it.
4. Every ceremony, enrollment and unlock, runs in the side panel, where the
   wallet lives, and unlock also runs in the confirm window for a dApp request.
   In the toolbar popup and the full-page tab the Unlock page keeps only the
   password form, and Settings points to the side panel for enrollment.

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
  verification to at least "preferred" when PRF is requested, and clears the
  PRF inputs before the request when a verification-capable authenticator
  would not be asked to verify
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
- The version in `info` and the credential id as salt bind the wrapped key to
  its record: a record replayed under another version or credential derives a
  different key and fails the AES-GCM tag, as does one with another
  `prfSalt`, whose PRF output differs. `backupEligible` (The stored record) is
  the one field bound by nothing, and it stays out of AES-GCM additional data:
  it is an unauthenticated display hint, never an input to a decision. No step
  of the design decides on it, since owner decision 1 accepts synced and
  device-bound credentials alike, so a changed value changes only what the
  Settings row says (milestone 2).
- The vault key and every item encrypted under it stay as they are.

### The stored record

A third plain-storage key, `vault_key_platform`, next to the other two
(`src/lib/miden/back/vault.ts:210-212`) and written the same way
(`src/lib/miden/back/safe-storage.ts:104-106`):

| Field | Content |
|---|---|
| `version` | Record format, starting at 1; carried in the HKDF `info` |
| `credentialId` | The credential's raw id, stored as base64url; passed in `allowCredentials` at unlock, and its raw bytes are the HKDF salt |
| `prfSalt` | 32 random bytes, the PRF input, one per credential |
| `wrappedKey` | 12-byte IV, then AES-GCM ciphertext and tag of the 32 vault-key bytes |
| `backupEligible` | The BE flag from the authenticator data at enrollment, set for a credential that can sync (Support matrix); the Settings row shows it (milestone 2) |

The salt is not secret: it is stored next to the wrapped key.

Rotating the salt with `eval.second` on each unlock, as WebAuthn Level 3
suggests ([section 10.1.4][webauthn-l3]), is left out of the first scope.
Leaving it out has a cost: one captured PRF output opens the record in every
later profile copy until the user re-enrolls, as a captured password opens
`vault_key_password` in every copy. Rotation would limit a captured output to
copies taken before the next unlock. Neither rotation nor removal is revocation:
a profile copy holds the record and the vault it unwraps as they were when it
was taken, so the PRF output for its salt, which the passkey yields while it
survives in its provider, still opens that copy.

### Where the ceremony runs

- In the side panel, and for unlock also in the confirm window (owner decision
  4; Surfaces and focus, below). The popup and the full-page tab run no
  ceremony: their Unlock page keeps only the password form, and their Settings
  row points to the side panel (First implementation scope, milestone 2).
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
   (`src/lib/store/index.ts:179-185`, `src/lib/intercom/client.ts:271`), under a
   field name the crash-report redaction treats as secret (First implementation
   scope, milestone 2).
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
   with the default RP ID (no `rp.id`) and
   `prf: { eval: { first: prfSalt } }` for a new random salt. The other
   options:
   - `authenticatorAttachment: 'platform'`, which admits iCloud Keychain, GPM,
     Windows Hello and Chrome's profile store and leaves out security keys
     (Recommendation and scope).
   - `userVerification: 'required'`, and `residentKey: 'preferred'`: unlock
     always names the credential in `allowCredentials`, so a discoverable one
     is not needed. MetaMask sends the same attachment, verification and
     resident-key values ([`PasskeyController.ts`][metamask-controller],
     secondary).
   - `user.id`: 64 random bytes, and `user.name` and `user.displayName`: a
     fixed label naming the wallet. None carries personal data, since
     authenticators may reveal the user handle without user verification
     ([WebAuthn Level 3 section 14.6.1][webauthn-l3]).
   - `excludeCredentials`: empty at first enrollment; on re-enrollment, the
     current record's credential, as WebAuthn Level 3 asks for existing
     credentials (section 5.4), so a provider that holds it steers the user
     elsewhere or fails. Re-enrolling in the same provider removes the old
     enrollment first (milestone 4).
   - `hints: ['client-device']`, which asks for this computer's authenticator
     rather than a phone; hints are advisory ([Chrome blog][chrome-hints]).
2. Outputs at create are optional ([WebAuthn Level 3 section
   10.1.4][webauthn-l3]). If the response has no `prf.results.first`, the page
   runs `get()` once with the new credential in `allowCredentials`. No output
   from either means the authenticator has no PRF, and enrollment stops with no
   record saved; its credential id goes to the to-signal list (Design points,
   below). The `create()` has already made a credential in the provider, though:
   on macOS the likely case is a Chrome-profile passkey, which stays listed in
   `chrome://settings/passkeys` until the user deletes it there ([Chromium
   5c360860][cr-cbd-m126]). A credential that a re-enrollment replaces stays in
   its provider the same way. `PublicKeyCredential.signalUnknownCredential`
   (Chrome 132+, [MDN browser-compat-data][mdn-bcd-pkc], v8.1.3) asks the
   provider to hide such an entry and is known to hide only GPM entries
   ([delegate][cr-delegate]); its effect on iCloud Keychain is **Unconfirmed**
   (Open question 12).
3. The page sends the password, credential id, salt and PRF output and the BE
   flag to the service worker, the PRF output under a field name the
   crash-report redaction treats as secret (First implementation scope,
   milestone 2).
4. The service worker unwraps the vault-key bytes with the password, wraps them
   under the PRF-derived key, unwraps the result once to check it, and only then
   saves `vault_key_platform`, through the write queue and its checks (Design
   points, below).

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
| Windows 11 | Windows Hello, through `webauthn.dll` | **Unconfirmed** | Chrome passes PRF at get on every Windows API version; at create from Chrome 147 (stable 2026-04-07), and only where `webauthn.dll` reports API version 8 or later ([line 68][cr-win-hmac-mc]); which Windows build ships API version 8 is **Unconfirmed** | No | [`win/authenticator.cc`][cr-win-authenticator]; [Chromium af1aabea][cr-win-prf-create] (2026-02-23); [Microsoft `webauthn.h`][ms-webauthn-v8] (API version 8 added 2025-01-30); [Bitwarden forum][bitwarden-hello-thread] (2026-03-23, secondary); [MetaMask #46400][metamask-46400] (2026-09-16, secondary) |
| Windows 10 | Windows Hello | No, **Unconfirmed** | - | No | [Corbado][corbado] (2026-09-22, secondary); [Bitwarden help][bitwarden-help-passkeys] (read 2026-09-28, secondary) |
| Linux | No OS authenticator; Google Password Manager only | Yes, through GPM | as GPM | Yes | [Google supported environments][google-envs] (updated 2025-05-19) |
| ChromeOS | ChromeOS platform authenticator | No | - | No | [`cros/authenticator.cc`][cr-cros] |
| any | Security key with CTAP2 `hmac-secret` | Yes, if the key supports `hmac-secret` | Chrome 116 | No | [MDN browser-compat-data][mdn-bcd] (v8.1.3, 2026-09-24); [blink-dev intent][blink-dev-prf] (2023-04-29) |

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
- Other Chromium browsers (Edge, Brave, Opera) are untested and outside the
  device test. Because PRF is detected from a real result, one whose
  authenticator returns none refuses enrollment and keeps the password;
  Ambire's code says Brave's profile passkeys return none
  ([`webauthnBiometrics.ts`][ambire-biometrics], secondary, **Unconfirmed**).

### Extension-origin constraints

- Chrome lets `chrome-extension://` pages of an enabled extension call
  WebAuthn ([`chrome_web_authentication_delegate.cc`][cr-delegate],
  `OverrideCallerOriginAndRelyingPartyIdValidation`), and Chromium's guidance
  is to leave the RP ID blank ([`origins.md`][cr-origins-md]).
- The default RP ID is rewritten to the whole origin,
  `chrome-extension://<id>` ([delegate][cr-delegate],
  `MaybeGetRelyingPartyIdOverride`;
  [`authenticator_common_impl.cc`][cr-authenticator-common]; probe, below).
- The id, and with it the RP ID, is derived from the extension's key, so a Web
  Store reinstall keeps it ([`id_util.h`][cr-id-util];
  [manifest `key`][chrome-manifest-key], read 2026-09-28). Whether another
  store (Edge Add-ons) gives the same id is **Unconfirmed**.
- A web RP ID needs a host permission: allowed from Chrome 122
  ([W3C list][w3c-list-2023], 2023-12; [MDN][mdn-ext-webauthn], modified
  2026-07-08), and since
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
(`public/manifest.json:33-41`), headed on macOS, in a tab rather than the
action popup. The method is in the appendix. Excerpt of the recorded results:

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

### The confirm window and the full-page tab

- The confirm window is a `windows.create({ type: 'popup' })` window (Where
  unlock can run, above): an ordinary browser window, not the toolbar's
  extension popup whose closing rules are listed above. Whether a ceremony
  there completes with the native OS sheets is question 26.
- The full-page tab is an ordinary browser window too, but under owner
  decision 4 it runs no ceremony (Mechanism, Where the ceremony runs).
- Prior art moves ceremonies out of compact surfaces: Bitwarden forces a popout
  for passkey login on Linux ([`platform-popout.guard.ts`][bitwarden-guard],
  secondary), and MetaMask points side-panel users to full screen and caps
  side-panel ceremonies at 30 seconds
  ([`passkey-ceremony.ts`][metamask-ceremony], secondary). Whether a
  side-panel ceremony completes is also question 26; Go/no-go says what a
  failure there does.

## Lifecycle

The record lives in this profile's `chrome.storage.local`; the credential
lives with its provider. An event can remove either. `vault_key_password` sits
in the same storage as `vault_key_platform`, so an event that wipes the storage
removes both, and recovery is then the seed phrase or an encrypted backup file,
as it is today.

| Event | What happens to the credential | What the user sees | Password still unlocks? |
|---|---|---|---|
| Enrollment | A new credential under RP ID `chrome-extension://<id>` in the provider Chrome offers (which one comes first on macOS: **Unconfirmed**); `vault_key_platform` is written next to `vault_key_password`. An authenticator with no PRF output leaves no record in the wallet but leaves its credential in the provider (Mechanism, enrollment step 2; Open question 12). | The password prompt, then Chrome's or the OS's passkey sheet; on a refusal, a message that this authenticator cannot be used, and a leftover entry in that provider. | Yes: `vault_key_password` is not touched. |
| Re-enrollment | The new record replaces `vault_key_platform`; the old credential stays in its provider unless removed (Mechanism, enrollment step 2; Open question 12). After Forgot password, setup wipes every storage key but the preserved ones (`src/lib/miden/reset.ts:22-42`, `src/lib/miden/reset.ts:67-81`), so the record goes and the new vault key needs a new enrollment. | The enrollment flow again; the old entry may stay listed in the provider. | Yes. |
| Device loss | The record was on the lost device. A synced credential (iCloud Keychain, GPM) stays usable elsewhere but has no record to unwrap there; a device-bound one is gone. | On a new device: restore from the seed phrase or a backup file, set a password, enroll again. | Not applicable: the vault was on the lost device; recovery is the seed phrase or backup, as today. |
| Browser-profile reset | Deleting the profile deletes its `chrome.storage.local`, record included. "Reset settings" resets "Extensions and themes" and "Cookies and site data" and keeps saved passwords ([Chrome Help][chrome-reset], read 2026-09-28); whether extension storage survives it is **Unconfirmed**. iCloud Keychain, GPM and Windows Hello keep the credential outside the profile (**Unconfirmed** as documented behaviour). | Profile deleted: onboarding. Reset settings: unlock as before if storage survived (**Unconfirmed**). | Yes while the storage survives; both wrappings go if it does not. |
| Clearing browsing data | `chrome.storage.local` persists when the user clears cache and history ([chrome.storage][chrome-storage], read 2026-09-28). Chrome's macOS profile passkeys left Clear Browsing Data in Chrome 126 ([Chromium 5c360860][cr-cbd-m126], 2024-05-09), and the remover deletes platform credentials only on ChromeOS ([remover delegate][cr-cbd]). Whether clearing passwords removes GPM passkeys: **Unconfirmed** (the remover has no GPM passkey deletion). | Nothing changes. | Yes. |
| Uninstall and Web Store reinstall | Removal clears `chrome.storage.local` ([chrome.storage][chrome-storage]), so both wrapped keys go. The credential stays in its provider under `chrome-extension://<id>` (how it is listed: **Unconfirmed**). The reinstalled extension keeps its id and RP ID ([`id_util.h`][cr-id-util]) but has no record for the old credential. From another store the id may differ: **Unconfirmed**. | A fresh install opens onboarding in a tab (`vite.background.config.ts:197-202`); restore from the seed phrase or backup, then enroll again. | No: `vault_key_password` is gone too; recovery is the seed phrase or backup, as today. |
| Windows Hello PIN reset | A destructive PIN reset deletes the keys in the user's Windows Hello container, listed for Microsoft accounts ([Microsoft Learn][ms-pin-reset], 2026-03-29). Whether consumer passkeys sit in that container: **Unconfirmed**. Reports conflict on whether a PIN change drops passkeys ([Microsoft Q&A][ms-qa-pin], 2025-05, secondary). | Platform unlock fails with no credential found; the password form. | Yes. |
| Touch ID re-enrollment | Chrome's profile keys use private-key usage and user presence, not the current biometric set ([`credential_store.mm`][cr-credential-store]), so a new fingerprint does not invalidate them (inference); they have no PRF anyway. For iCloud Keychain passkeys Apple documents nothing: **Unconfirmed**. | Expected: nothing. If the credential stopped working: the password form. | Yes. |
| Password forgotten while platform unlock still works | The credential and both wrappings stay. | Unlock works, but every action that asks for the password fails, among them revealing the seed phrase (`src/lib/miden/back/vault.ts:2695-2702`) and exporting the backup file (`src/lib/miden/back/vault.ts:664-669`). The wallet has no change-password flow: no message type sets a new password (`src/lib/shared/types.ts:12-163`). Forgot password wipes the storage and needs the seed phrase (`src/app/pages/ForgotPassword/ForgotPassword.tsx:113-140`). MetaMask lists the same question ([MetaMask #46400][metamask-46400], open question 3, secondary). | No, and the fallback is gone. When the credential stops working, recovery is the seed phrase or backup file; a user who never backed up the seed phrase can no longer reveal it. There is no periodic password check (owner decision 3), so this row's answer is the seed phrase backup. |
| Credential gone from the provider | The user deleted the passkey in the provider, or the provider no longer offers it on this device (turning off iCloud Keychain, signing Chrome out of GPM: which of these removes it is **Unconfirmed**). `vault_key_platform` stays, now stale. | Platform unlock finds no credential and the password form shows; the wallet should then offer to remove the record or enroll again. | Yes. |
| A synced passkey on another device | GPM syncs the credential's `hmac-secret` inside its encrypted entity ([`webauthn_credential_specifics.proto`][cr-gpm-proto]). For iCloud Keychain an Apple engineer wrote that PRF values over hybrid differing from local ones was a bug that "should be fixed in the current iOS 18.4 and macOS 15.4 betas" ([Apple developer forums][apple-forum-prf], 2025-02). A GPM passkey therefore yields the same PRF output on every synced device; for iCloud Keychain that is the expected reading, **Unconfirmed**. The record exists only in this profile. | The passkey is listed in the provider on the user's other devices. Another install of the wallet has no record for it and does not offer platform unlock until it enrolls its own. | Yes, on every install. |

## Security comparison

The password wrapping stays in every case below, so every attack on today's
vault still works; the question is what `vault_key_platform` adds. Two cases
differ: a device-bound credential (Windows Hello if the device test confirms
it) and a synced one (iCloud Keychain, Google Password Manager). The owner's
bar is weighed at the end of the section.

| Threat | Password vault today | Adding a device-bound record | Adding a synced record |
|---|---|---|---|
| Offline attack on a copy of the profile | Guess the password; each guess costs 10,310,000 PBKDF2 iterations | No new path | The copy, plus the user's Apple or Google account on a device the attacker holds |
| A person at the unlocked OS session | Needs the wallet password | Needs what the OS accepts as user verification, which can be its PIN or password | The provider's own user verification applies; which methods count is **Unconfirmed** (Open question 4) |
| Script injection or malware in the extension | Reads the password at the next unlock | Reads the PRF output at the next unlock | Same as device-bound |
| Phishing | A page can ask for the password | No page and no other extension can use the credential; the password prompt is unchanged | Same as device-bound |

### Offline attack on a stolen profile

- A copy of the profile's extension storage holds `vault_key_password`. Each
  password guess costs a SHA-256 and 10,310,000 PBKDF2-HMAC-SHA256 iterations
  before the AES-GCM tag check (`src/lib/miden/passworder.ts:117-137`).
- The onboarding password step accepts any password that passes two of its
  five checks (`src/screens/onboarding/common/CreatePassword.tsx:110-123`,
  used at `src/screens/onboarding/navigator.tsx:323`), so a 3-character
  password such as `aB1` (mixed case, letters with a digit) is accepted.
- The record adds a second ciphertext of the same 32 bytes under a key derived
  from a PRF output. PRF outputs are 32 bytes
  ([WebAuthn Level 3 section 10.1.4][webauthn-l3]) computed from a secret the
  authenticator holds; the credential id and salt stored in the record are
  inputs, not secrets. The record gives an offline attacker nothing to guess, so
  the password stays the cheapest target, as it is today.
- That holds while the PRF secret stays out of reach: on one device for a
  device-bound credential, and for a synced one see below.

### Synced passkeys

- With GPM the PRF secret is on every device of the user's provider account:
  GPM syncs the `hmac-secret` inside the credential's encrypted entity
  ([`webauthn_credential_specifics.proto`][cr-gpm-proto]). iCloud Keychain
  syncs passkeys end to end encrypted ([Apple][apple-icloud-security],
  2024-09-16); that they give the same PRF output on every synced device is
  **Unconfirmed** (Open question 5), so the secret must be assumed to be on
  every synced device. The second wrapping is then as strong as that account,
  not as the device.
- An attacker needs all three of:
  1. a copy of this profile's extension storage, for the record and its salt
     (the copy the offline attack starts from);
  2. the provider account on a device they hold. For GPM: the Google account
     and the GPM PIN, six digits by default, or an Android screen lock
     ([Google][google-gpm-blog], 2024-09-19). For iCloud Keychain: the Apple
     Account password and a six-digit code, then either sponsorship by one of
     the user's devices or keychain recovery, which asks for an SMS code and a
     device passcode and allows 10 attempts ([Apple][apple-icloud-security]);
  3. a user verification on that device, which they set up themselves.
- The RP ID does not stop them: a Web Store install on their device has the
  same extension id and so the same RP ID ([`id_util.h`][cr-id-util]).
- Today the copy and enough password guesses open the vault. The synced record
  adds a second route through the provider account; which route is cheaper
  depends on the user's password and on their account's security, and this doc
  has no numbers for the second.
- A device-bound credential needs the copy and the device itself.

### A person at the unlocked OS session

- Today a locked wallet asks for its own password, which need not match the OS
  password.
- With the record, the provider's user verification takes its place. Windows
  Hello accepts "biometrics or PIN" ([Microsoft Learn][ms-passkeys],
  2026-05-12). Apple says that where Touch ID or Face ID is available it "can
  be used to authorize use of the passkey" ([Apple][apple-icloud-security]);
  which other methods the macOS passkey sheet accepts for iCloud Keychain, and
  how GPM verifies the user on macOS, Windows and Linux, are **Unconfirmed**.
- The wallet cannot tell which method was used. The authenticator data carries
  one UV bit ([WebAuthn Level 3 section 6.1][webauthn-l3]), Level 3 dropped
  the `uvm` extension (its changes section), and Blink does not offer it
  ([`public_key_credential.cc`][cr-pkc]).
- So a person who knows the OS PIN or password, and not the wallet password, can
  unlock a device-bound credential; a synced one depends on its provider (Open
  question 4). The hardware protector the owner's bar names already accepts the
  same: the macOS desktop key asks for "Touch ID or system password"
  (`src-tauri/src/secure_storage/macos.rs:61-63`), and the Android key accepts a
  device credential from API 30
  (`android/app/src/main/java/com/miden/wallet/HardwareSecurityPlugin.kt:118-123`).

### Script injection or malware in the extension

- Extension pages run scripts only from the package
  (`public/manifest.json:33-35`).
- Today the password is typed into the page and sent in `UnlockRequest`
  (`src/lib/store/index.ts:179-185`): code running in an extension page sees
  it, and code in the service worker holds the vault key after any unlock.
- The PRF output takes the same path (Mechanism, enrollment step 3 and unlock
  step 3), so the exposure is the same, provided it is kept out of crash reports
  as the password is (milestone 2). Code in a page can also start its own
  `get()` with the stored salt; the provider then shows its sheet and asks for
  the user's verification, which a user expecting an unlock may give.
- One difference: a captured PRF output opens only this record, while a
  captured password also works wherever the user reused it.
- Malware running as the user can read the profile's storage and wait for
  either secret; the record changes nothing there.

### Phishing

- The credential's RP ID is `chrome-extension://<id>` (Support matrix). A web
  page can use as an RP ID only its own domain, a registrable suffix of it, or
  a domain that lists it for Related Origin Requests
  ([WebAuthn Level 3][webauthn-l3], "RP ID" in section 4 and section 5.11),
  and none of these is an extension origin. Chrome lets no extension claim
  another extension's RP ID ([delegate][cr-delegate],
  `MaybeGetRelyingPartyIdOverride`). No web page and no other extension can
  get an assertion or a PRF output from the credential.
- The password prompt stays as the fallback, so a page that imitates the
  wallet can still ask for the password, as it can today.

### A web RP ID instead

- The manifest's `https://*.miden.fi/*` host permission
  (`public/manifest.json:26-31`) may let the extension claim `miden.fi` as its
  RP ID (**Unconfirmed**, Support matrix).
- With RP ID `miden.fi`, every page on `miden.fi` and its subdomains can run a
  ceremony against the same credential ([WebAuthn Level 3][webauthn-l3], "RP
  ID"). With one user verification, a compromised page on any of them gets
  the PRF output for any input it chooses. It also needs the wallet's salt and
  record, both in the profile's plain storage, so a profile copy plus one
  compromised `miden.fi` page and one prompt the user approves would be enough,
  where the extension RP ID requires the user's device or provider account.
- Chrome ties the claim to the extension's permission to script
  `https://miden.fi` ([Chromium ecf43dd2][cr-m148-host], 2026-03-30), so a user
  who withholds the extension's access to that site would lose platform unlock
  (**Unconfirmed**, an inference from that change).
- `chrome-extension://<id>` confines the credential to the extension's own
  pages: Chrome rewrites the RP ID to the whole origin so that it cannot
  collide with a web RP ID ([delegate][cr-delegate]).
- The design uses `chrome-extension://<id>`: a web RP ID would put every
  `miden.fi` page inside the vault key's trust boundary.

### Prior art

Four browser extensions implement passkey unlock; all four sources are other
projects' code (secondary), read at the pinned commits on 2026-09-28.

| Product | RP ID | What yields the wrapping key | Source |
|---|---|---|---|
| MetaMask | The extension origin | PRF, required for new setups; HKDF with the credential id as salt, as proposed in Mechanism. A comment in its setup hook rules out any fallback to a key derived from the user handle | [`usePasskeyPRFSupport.ts`][metamask-prf-hook]; [`key-derivation.ts`][metamask-key-derivation] |
| Bitwarden (Chromium extensions) | Its web-vault hostname | PRF, with one salt shared with its passkey login, and `userVerification: "preferred"` | [`default-webauthn-prf-unlock.service.ts`][bitwarden-prf-unlock] |
| Ambire | The extension id | PRF or legacy `hmac-secret`; for providers without either (its comment names Brave profile passkeys), a key derived from the user handle | [`webauthnBiometrics.ts`][ambire-biometrics] |
| Rabby | The extension id | The user handle, a random 64 bytes, through HKDF; the key encrypts the password itself | [`biometric.ts`][rabby-biometric] |

A key derived from the user handle is rejected here:

- The user handle is an account identifier, not a secret: "authenticators MAY
  reveal user handles without first performing user verification"
  ([WebAuthn Level 3 section 14.6.1][webauthn-l3]). A key derived from it is
  not gated by user verification, although Ambire's comment assumes it is.
- GPM keeps `user_id` as a plain field of the synced entity, while the private
  key and the `hmac-secret` sit inside the separately encrypted `Encrypted`
  message ([`webauthn_credential_specifics.proto`][cr-gpm-proto]).
- So the design requires a PRF output and has no user-handle path: an
  authenticator that returns none is refused at enrollment (Mechanism,
  enrollment step 2), as MetaMask now does.

### Against the owner's bar

| Property | The bar | Hardware protector (mobile, desktop) | PRF record, device-bound | PRF record, synced |
|---|---|---|---|---|
| Wraps the same vault-key bytes | Yes | Yes (Today's vault) | Yes | Yes |
| Password wrapping kept beside it | Yes: "next to the password wrapping" | No: it replaces the password wrapping (Today's vault) | Yes | Yes |
| Wrapping secret bound to one device | Yes | Yes on iOS, Android and macOS: the iOS and macOS keys are accessible on this device only (Today's vault), and the Android key lives in `AndroidKeyStore` (`android/app/src/main/java/com/miden/wallet/HardwareSecurityPlugin.kt:103-106`), whose key material "can't" be extracted ([Android keystore][android-keystore], updated 2026-03-06) | Yes | No: the PRF secret syncs (above) |
| User verification can be the OS password or PIN | Not stated | Yes on macOS desktop and Android (above) | Yes on Windows Hello | Which methods: **Unconfirmed** (above) |
| Available in Chrome on macOS today | - | - | No platform authenticator (Support matrix) | iCloud Keychain and GPM; with the extension RP ID **Unconfirmed** and secondary evidence only (Support matrix) |

## Recommendation and scope

### Against the bar as written

The owner's decision on #846 sets the bar: "a second, device-bound wrapping of
the vault key next to the password wrapping is acceptable, the model the
mobile and desktop hardware protector already use".

The table under "Against the owner's bar" (Security comparison) settles the
password wrapping, which the design keeps and the protector does not, and
macOS, where Chrome has no device-bound PRF platform authenticator. Beyond it:

- Device-bound, on Windows 11: buildable only if a device test confirms that
  Windows Hello evaluates PRF for the extension's RP ID (**Unconfirmed**;
  MetaMask reports that Hello fails its PRF check,
  [MetaMask #46400][metamask-46400], secondary).
- Elsewhere: Windows 10 has no Hello PRF (**Unconfirmed**), ChromeOS's platform
  authenticator has none, and Linux has no platform authenticator, only GPM
  (Support matrix).
- A security key with `hmac-secret` is device-bound on every OS from Chrome
  116, but it is not Touch ID or Windows Hello: it meets the bar and misses the
  issue's goal.
- A device-bound rule can be enforced only after creation, by refusing a
  credential whose BE flag is set (Support matrix), and each refusal leaves an
  entry in the provider (Mechanism, enrollment step 2).

**Verdict against the bar as written:** no-go on macOS, Linux, ChromeOS and
Windows 10 until a platform authenticator in Chrome offers a device-bound PRF
credential; on Windows 11, go only if the device test passes, as a Windows-only
feature, and even then only with owner decision 2 below, because Windows Hello
accepts its PIN.

### The recommended variant: accept synced PRF passkeys

Accept a synced PRF credential (iCloud Keychain, GPM) as the second wrapping,
and a device-bound one where the platform offers it. The reasons:

- The record lives only in this profile's `chrome.storage.local`, where "data
  is stored locally" ([chrome.storage][chrome-storage]), not in the storage
  area Chrome syncs; a synced credential alone unlocks nothing.
- The PRF output is 32 bytes and needs user verification (Mechanism); an
  offline attacker has nothing new to guess, and the route the record adds
  needs the user's provider account as well as a profile copy (Security
  comparison).
- The password wrapping, the seed phrase and the backup file stay as they are,
  so recovery does not depend on one device or one provider, as the issue
  asks, while the user still knows the password or has the seed phrase or
  backup file (Lifecycle, forgotten password).

The owner decisions it needs:

1. Accept synced credentials: the second wrapping then rests on the user's
   Apple or Google account (Security comparison, Synced passkeys).
2. Accept the OS password or PIN as user verification equal to Touch ID or
   Windows Hello: the wallet cannot tell them apart, and the hardware protector
   already accepts the device password on macOS desktop and Android. The
   device-bound Windows 11 path needs this decision too, since Windows Hello
   accepts its PIN.

The mechanism is the one in Mechanism, with RP ID `chrome-extension://<id>`
(Security comparison, A web RP ID instead).

### Go/no-go

**Go**, with the owner's decisions taken on #846. No probe result and no source
re-read for this doc argues against it.

- The implementation starts with the device test (milestone 1) and stops there
  if no provider returns a PRF output for the extension's RP ID, with user
  verification, on macOS 15 or later or on Windows 11.
- On macOS, iCloud Keychain is the one provider known both to verify with
  Touch ID and to return PRF, and its support for the extension RP ID is
  **Unconfirmed**. If only GPM passes there, how GPM verifies the user on macOS
  (**Unconfirmed**) decides whether the feature is still Touch ID unlock.
  Likewise on Windows 11: if Hello fails the PRF check, GPM may be the only
  path there, and the feature is then not Windows Hello unlock.
- The ceremony runs in the side panel and the confirm window (owner decision 4),
  so the popup's behaviour with the native OS sheets (Surfaces and focus) does
  not decide the go. If question 26 fails on an OS (a ceremony from the side
  panel or the confirm window does not complete with that OS's native sheet),
  the work stops on that OS and the choice of surface goes back to the owner. A
  wallet whose toolbar action still opens the popup (its side-panel handoff did
  not run or failed, or its side-panel restore failed at startup,
  `src/background.ts:18-33`) unlocks there with the password.

### First implementation scope

1. **Device test.** On macOS 15 or later and on a current Windows 11 (24H2 or
   25H2), with Chrome 155 and again with Chrome 156 when it ships, using the
   extension RP ID: each provider Chrome offers (its profile store, iCloud
   Keychain, GPM, Windows Hello), from the side panel and the confirm window,
   with and without a Google account signed in to Chrome (question 3). Record
   PRF at create and get, the UV and BE flags, the verification methods the
   sheet accepts, what the provider lists afterwards, and
   `WebAuthNGetApiVersionNumber` on each Windows build (question 7). An
   assertion with the same salt from a second Mac or an iPhone over hybrid
   checks a synced iCloud Keychain passkey (question 5). Linux, ChromeOS and
   Windows 10 are outside this run (Decision summary), so the Linux part of
   question 4 and question 8 wait for a device test on those systems. The
   harness is an extension built from the appendix's Method, with no virtual
   authenticator, extended with a side panel and a confirm-style window. Loaded
   unpacked, its id comes from its path, which serves every question here; the
   Web Store listing's public key in its manifest `key` ([manifest
   `key`][chrome-manifest-key]) gives it the store id, needed only to re-check
   on a device that a Web Store reinstall reaches the same credential
   (Lifecycle, uninstall row). It settles Open questions 1 to 7 and 26 (question
   4 without its Linux part) and decides, per OS, whether to continue, by the
   rules in Go/no-go. The owner runs it on a Mac with Touch ID and a Windows 11
   PC as part of the implementation PR.
2. **Enrollment in Settings, behind the password.** A row in Settings' Security
   group (`src/app/pages/Settings.tsx:183-201`) runs the enrollment flow in
   Mechanism, offered only on macOS 15 or later and Windows 11 (Decision
   summary) and only when `vault_key_password` exists; the page reads the
   version with
   `navigator.userAgentData.getHighEntropyValues(['platformVersion'])`, whose
   result also names the platform, treats a Windows major version of 13 or more
   as Windows 11 ([Microsoft Learn][ms-detect-win11], read 2026-09-29) and a
   macOS major version of 15 or more as macOS 15 or later (on macOS the value is
   the system's own major, minor and patch version, [User-Agent Client Hints
   section 3.10][ua-ch-platform-version], read 2026-09-29), and does not offer
   the row when the value is unavailable. It starts enrollment only in the side
   panel (owner decision 4; `useAppEnv`'s `sidePanel`, `src/app/env.ts:39`); in
   the popup and the full-page tab the row shows its state and points to the
   side panel. The row says whether the credential can sync (the BE flag), not
   whether it syncs, from the record's `backupEligible` field, a display hint
   that decides nothing (Mechanism, PRF, and the key it yields).
   - Crash-report redaction, in place before the first PRF output crosses the
     port: crash reports are scrubbed by key name
     (`src/lib/telemetry/crash.ts:144-148`,
     `src/lib/telemetry/redact.ts:350-355`), matching the parts of each key
     against a list (`src/lib/telemetry/redact.ts:242-288`,
     `src/lib/telemetry/redact.ts:313-325`). `password` is caught; a field named
     `prfOutput` would not be. The PRF output therefore travels under a key with
     a listed part, such as `prfSecret`, or `prf` joins the list, in both the
     enrollment and the unlock request, and a redaction test covers both.
3. **Unlock with PRF, and the password on every failure.** On the Unlock page in
   the side panel (`src/app/pages/Unlock.tsx:330`) and in the confirm window
   (`src/app/ConfirmPage.tsx:67-68`); the Unlock page in the popup and the
   full-page tab keeps only the password form (owner decision 4). A cancel, a
   `NotAllowedError`, a missing credential or PRF result, a clear UV flag or a
   failed AES-GCM tag each leaves the password form in place.
4. **Removal and re-enrollment.** Removal queues the record's credential id on
   the to-signal list, deletes `vault_key_platform`, and a page then calls
   `signalUnknownCredential` for it (Mechanism, enrollment step 2; Design
   points, below; Open question 12); re-enrollment replaces the record. A wallet
   setup already wipes every storage key but the preserved ones
   (`src/lib/miden/reset.ts:13-18`, `src/lib/miden/reset.ts:22-42`), so Forgot
   password removes the record. Removal is not revocation (Mechanism, The stored
   record), so the removal step also tells the user to delete the passkey in the
   provider. Open questions 12 to 18 are settled here, before release, by the
   device tests their rows name.

What stays out:

- Legacy wallets: they have no random vault key to wrap
  (`src/lib/miden/back/vault.ts:817-818`). This conflicts with the issue's
  "enable it without recreating their wallet" for those users. A follow-up that
  moves a legacy wallet to the vault-key model on its next password unlock
  would resolve it; whether to build it is the owner's call.
- The other password prompts (Today's vault): revealing secrets, the exports,
  removing the seed phrase and spending-limit strict authentication keep the
  password.
- Mobile and desktop, which keep the hardware protector.
- Firefox, which the manifest also targets (`public/manifest.json:48-56`):
  the issue asks for the Chrome extension, and Firefox's PRF support and its
  extension RP ID are untested here. MDN also documents that its extension
  popup closes when the credential prompt appears, with opening the page in a
  new tab as the workaround ([MDN][mdn-ext-webauthn]).

## Open questions

Every fact this doc marks **Unconfirmed**, and what would settle each. Questions
1 to 7 and 26 decide feasibility on macOS 15 or later and Windows 11 (milestone
1), 8 and the Linux part of 4 only once Windows 10 or Linux comes into scope
(Decision summary), 12 to 18 the lifecycle (milestone 4), and 19 to 25 are
narrower; 9 to 11 (the popup), 22, 23 and 25 are not relied on.

| # | Question | Relied on in | Settled by |
|---|---|---|---|
| 1 | Does iCloud Keychain return PRF at create and get for RP ID `chrome-extension://<id>` in Chrome on macOS 15+? MetaMask lists the same question ([MetaMask #46400][metamask-46400]) | Support matrix; Recommendation | Device test on macOS 15+ with Chrome 155 |
| 2 | Does GPM return PRF for that RP ID? The only evidence is secondary ([MetaMask #46400][metamask-46400]) | Support matrix; Recommendation | The same device test, on macOS 15 or later and Windows 11; Linux, ChromeOS, Windows 10 and macOS before 15 wait for their own device test (Decision summary) |
| 3 | Which store does Chrome on macOS offer first for a new platform credential, now that GPM also saves desktop passkeys? | Support matrix; Lifecycle (Enrollment) | Device test, with and without a Google account signed in to Chrome |
| 4 | Which user verification methods satisfy each provider: the macOS passkey sheet besides Touch ID (the login password), and GPM on macOS, Windows and Linux (the GPM PIN or the OS prompt)? | Security comparison; Recommendation (decision 2) | Device tests on macOS, Windows and Linux, declining the biometric prompt |
| 5 | Does a synced iCloud Keychain passkey give the same PRF output on a second device? Apple wrote a hybrid mismatch "should be fixed in the current iOS 18.4 and macOS 15.4 betas" ([Apple developer forums][apple-forum-prf]) | Security comparison (synced passkeys); Lifecycle (synced passkey) | Device test: enroll on one Mac, assert with the same salt from a second Mac or an iPhone over hybrid |
| 6 | Does Windows Hello evaluate PRF at create and get in Chrome 147+ on a current Windows 11, with the extension RP ID, and why does MetaMask report that it fails? | Support matrix; Recommendation (the bar on Windows) | Device test on Windows 11 24H2 or 25H2 after KB5077181, with Chrome 155 |
| 7 | Which Windows build first ships WebAuthn API version 8, which Chrome needs for PRF at create? | Support matrix | Calling `WebAuthNGetApiVersionNumber` ([`webauthn.h`][ms-webauthn-v8]) on each Windows build tested, or a Microsoft statement |
| 8 | Is there no Hello PRF on Windows 10, as secondary sources say? | Support matrix; Recommendation | Device test on Windows 10 22H2 |
| 9 | Does an extension popup survive the native OS sheets (the Windows Hello dialog, the macOS passkey sheet) in Chrome 155? Not relied on: the ceremony never runs in the popup (owner decision 4) | None | Device test from the popup on macOS and Windows |
| 10 | Does the Chrome 156 force-close ([Chromium 4b8e494e][cr-popup-m156]) apply to a ceremony started from the popup? Not relied on: the ceremony never runs in the popup (owner decision 4) | None | The same device test on Chrome 156 |
| 11 | Is Chrome's own WebAuthn dialog still clipped inside a popup, as reported for Chrome 107 ([bitwarden/clients#4365][bitwarden-4365])? Not relied on: the ceremony never runs in the popup (owner decision 4) | None | The same device test |
| 12 | Does Chrome accept `signalUnknownCredential` from a `chrome-extension://<id>` page, and with which `rpId`? Does it then remove or hide an iCloud Keychain entry, or only GPM ones? | Mechanism; Lifecycle; milestone 4; Design points | Device test: enroll, remove, call `signalUnknownCredential` with `rpId` set to `chrome-extension://<id>` and to `<id>`, recording whether each call resolves or rejects, then check the Passwords app and GPM's passkey list |
| 13 | How does each provider list an orphaned `chrome-extension://<id>` credential after the extension is removed? | Lifecycle (uninstall) | Device test in each provider's list |
| 14 | Does a consumer Windows Hello "I forgot my PIN" reset delete passkeys, and can a PIN change drop them? Reports conflict ([Microsoft Q&A][ms-qa-pin]) | Lifecycle (PIN reset) | Device test with a Microsoft account and with a local account |
| 15 | Does re-enrolling Touch ID fingerprints affect iCloud Keychain passkeys? Apple documents nothing | Lifecycle (Touch ID re-enrollment) | Device test: remove and add a fingerprint, then unlock |
| 16 | Does Chrome's "Reset settings" keep extension storage? | Lifecycle (profile reset) | Test on any OS with an enrolled wallet |
| 17 | Do iCloud Keychain, GPM and Windows Hello keep the credential when the Chrome profile is deleted? Believed yes, not documented | Lifecycle (profile reset) | Device test: delete the profile, check the provider's list |
| 18 | Which user actions remove the credential from Chrome on this device: clearing passwords in Clear Browsing Data (GPM), turning off iCloud Keychain, signing Chrome out of GPM? | Lifecycle (clearing data; credential gone from the provider) | Device test |
| 19 | Does the Edge Add-ons listing give the extension the same id, and so the same RP ID, as the Web Store? | Support matrix; Lifecycle (reinstall) | Comparing the two listings' ids, or Microsoft's Edge Add-ons documentation |
| 20 | Does a ceremony fail in the offscreen document, as inferred from "can't be focused" ([chrome.offscreen][chrome-offscreen])? | Mechanism | One probe run calling `create()` from an offscreen document |
| 21 | Does `https://*.miden.fi/*` let the extension claim `miden.fi` under the Chrome 148 exact-origin rule, and does withholding the extension's site access block the claim? | Support matrix; Security comparison (web RP ID) | One probe run with that host permission and `rp.id: 'miden.fi'`, then with site access withheld |
| 22 | Which Chrome version first accepted `chrome-extension://<id>` as an RP ID (only "before 122" is established)? Not relied on: support is detected by a PRF result, not a version | None | The Chromium history of `MaybeGetRelyingPartyIdOverride` |
| 23 | Which attestation does Windows Hello return for `attestation: 'direct'`? Not relied on: the design reads the BE flag, not attestation | None | Device test, only if attestation is ever needed |
| 24 | Does the iOS Secure Enclave key, created with only `.privateKeyUsage`, prompt at each use? The repo's comments conflict | Today's vault | Device test on an iPhone: a hardware unlock, watching for Face ID |
| 25 | Do other Chromium browsers (Edge, Brave, Opera) return PRF for the extension RP ID? Ambire's code says Brave's profile passkeys return none (secondary). Not relied on: PRF is detected from a real result, and the password stays | None | A device test in each browser, if one comes into scope |
| 26 | Does a ceremony started from the side panel, and one from the confirm window, complete with the native OS sheets (the Windows Hello dialog, the macOS passkey sheet) in Chrome 155 and in Chrome 156? | Decision summary (decision 4); Go/no-go | Milestone 1's device test from the side panel and the confirm window on macOS 15 or later and Windows 11; Linux, ChromeOS, Windows 10 and macOS before 15 wait for their own device test (Decision summary) |

### Design points the implementation settles

Review of this doc raised points that are design work for the implementation,
not facts a device test settles (first raised as #1253 and #1257). Each is
decided before the milestone that ships the step it names.

- **Every dropped credential, not only a removed one** (milestones 2 and 4).
  Re-enrollment into another provider, the setup wipes (Forgot password, Reset
  extension, Developer Settings' reset), an enrollment that stops without PRF,
  a page closed mid-enrollment and two enrollments racing each other all leave
  a wallet-created credential with no record. The wallet tracks each
  credential from the moment `create()` resolves: before the step-2 `get()`
  fallback and before step 3, the page hands the new id to the service worker
  as a pending enrollment, with the credential id of the record it read at
  step 1, or none. The enrollment is live while that page stays connected. A
  committed save drops the pending entry. A save the checks below refuse, a
  no-PRF stop or an abandoned enrollment (the page gives it up or goes away,
  or the service worker finds it pending when it starts) moves the id to the
  to-signal list, and a save is refused once its id is there. A page signals
  only an id that no record holds and no live enrollment owns, and the service
  worker drops it from the list once the call returns. Whether Chrome's signal
  path accepts an extension caller, and with which `rpId`, is part of
  question 12.

- **The to-signal list** (milestones 2 and 4). The pending enrollments and the
  ids to signal live in one plain-storage key, `platform_credentials_to_signal`,
  added to `PRESERVED_STORAGE_KEYS` (`src/lib/miden/reset.ts:13`), so neither
  `clearStorage` nor `resetStorageDestructive` deletes it. The service worker
  cannot signal (Mechanism, Where the ceremony runs), so before a setup wipe, a
  removal or a replacing save deletes a record, it queues the record's
  credential id on the list, and a later page signals it.

- **One writer at a time for the record** (milestone 2). Every write to
  `vault_key_platform` or to the to-signal list (the enrollment save, removal,
  the setup wipes and the list's own updates) runs on one serial queue in the
  service worker. Inside the queue, just before writing, the enrollment
  save re-reads `vault_key_platform` and the `vault_key_password` ciphertext
  its unwrap used, and writes only if both are unchanged: the record still
  holds the credential the enrollment started from, or still none, and no
  wipe or setup has replaced the password wrapping. A save then cannot land
  between a wipe's read and its remove (`src/lib/miden/reset.ts:34-35`),
  survive into a new wallet, or pass the check alongside a second save. Reset
  extension and Developer Settings' reset, which wipe from a page today
  (`src/options.tsx:92`,
  `src/screens/developer-settings/DeveloperSettings.tsx:231`), hand their
  storage wipe to that queue and keep today's pairing of wipe and reload: the
  page reloads the runtime once the wipe succeeds (`src/options.tsx:93`,
  `src/screens/developer-settings/DeveloperSettings.tsx:240`) and shows the
  error if it fails, as the options page does today (`src/options.tsx:94-98`).
  If the service worker does not answer within a few seconds, the page writes
  a preserved reset-request marker and reloads the runtime, and the fresh
  service worker runs the start-time reset below. A stuck worker is replaced
  by the reload, so the recovery tool never blocks, and no wipe deletes a
  record untracked or writes beside a live queue. The start-time reset: a
  service worker that starts with the marker set, once the nonce check (next
  bullet) accepts it, runs the reset as its first step, before anything else
  reads wallet storage. The side-panel restore (`src/background.ts:18-33`),
  the interrupted-transaction sweep (`src/background.ts:45-47`), the
  alarm-driven sync (`src/background.ts:54-56`), and the connectivity
  hydration, the endpoint overrides and `Actions.init`
  (`src/lib/miden/back/main.ts:84-94`) wait for it, and until it ends every
  request is answered only with "resetting". The reset is one task on the
  queue: it queues the credential id of the record, if there is one, moves
  the pending enrollments to the to-signal list, runs the wipe and removes
  the marker as the task's last step; the worker then reloads the runtime
  once more, so the next worker starts from wiped storage, as after today's
  reset. A restart mid-wipe finds the marker and runs the task again, and a
  finished wipe never runs twice. If the wipe fails, the marker stays and the
  worker stays reset-pending: it refuses setup and unlock and reports the
  error to the next page that connects.

- **Only the extension's own pages ask for these writes** (milestones 2 and
  4). The service worker accepts a request that wipes storage (a reset, or a
  wallet setup, `src/lib/miden/back/vault.ts:874`) or that edits
  `vault_key_platform`, the pending enrollments or the to-signal list only on
  a port whose sender origin or URL, which the browser sets, is the
  extension's own, `chrome-extension://<id>`, and refuses it on a
  content-script port. Today such a port passes: the manifest injects a
  content script into every https page (`public/manifest.json:92-98`), and
  the intercom server checks only the sender's extension id
  (`src/lib/intercom/server.ts:77`), which a content script shares. The
  reset-request marker's trust rests on `chrome.storage.local`, which content
  scripts can write too, so the start-time reset also runs the nonce check:
  the page writes a random nonce into the marker and the same nonce into a
  database of its own in the extension origin's IndexedDB, apart from the one
  the wipe deletes (`src/lib/miden/reset.ts:97`), which a content script,
  running with the web page's origin, cannot open. The reset runs only when
  the two nonces match and removes the nonce with the marker; a marker
  without a match is removed, and the worker starts as usual. A content script
  can also write `chrome.storage.local` directly, where the marker,
  `vault_key_platform`, the to-signal list, `vault_key_password` and every
  wallet key live, so one rule covers the whole area: at start, before any other
  listener, the service worker restricts it to the extension's own contexts with
  `chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })`
  ([chrome.storage][chrome-storage], read 2026-09-29), after which no content
  script can read or write any of those keys, and the IndexedDB nonce stays as
  defense in depth; the reference marks the method Chrome 102+, but it accepts
  `local` only from Chrome 140 ([Chromium a8f1f337][cr-storage-m140],
  2025-07-04), and on an older Chrome, which the manifest's minimum of 114 still
  admits (`public/manifest.json:58`), a content script can still write those
  keys directly.

- **Redaction of free text** (milestone 2). `src/lib/telemetry/redact.ts`
  matches structured fields and free text (an error message, a breadcrumb)
  against different lists, so the PRF output's key is covered in both, and
  the redaction test checks both request shapes as objects and as text.

- **The BE flag across sessions** (milestone 2). The Settings row reads it from
  the record's `backupEligible` field (Mechanism, The stored record), so removal
  and the setup wipes delete it with `vault_key_platform`.

## Appendix: probe

### Method

A throwaway MV3 extension, one HTML page and a service worker, carried the
wallet's extension-page CSP and cross-origin isolation headers
(`public/manifest.json:33-41`). It was loaded unpacked into a persistent
Playwright context: Playwright 1.61.0 launched Chrome for Testing
149.0.7827.55, the version the browser reported. Headless mode did not load
the extension, so both recorded runs were headed, on macOS; they agreed on
every field. An unpacked extension without a manifest `key` takes its id from
its path ([`id_util.h`][cr-id-util]); `<id>` stands for it.

The page was opened in a tab at `chrome-extension://<id>/probe.html`, and a
CDP virtual authenticator was attached to it with these options:

```json
{ "protocol": "ctap2", "transport": "internal", "hasResidentKey": true, "hasUserVerification": true, "isUserVerified": true, "hasPrf": true }
```

and, for the capability check, the same options with `"hasPrf": false`. The
page then:

1. ran `create()` with no `rp.id`, `authenticatorAttachment: 'platform'`, a
   required resident key, `userVerification: 'required'` and a 32-byte PRF
   input, and compared the first 32 bytes of the authenticator data with the
   SHA-256 of `chrome-extension://<id>` and of `<id>`;
2. ran `get()` three times with that credential in `allowCredentials`, twice
   with the same PRF input and once with another;
3. ran `create()` with `rp.id: 'example.com'`, a domain the extension had no
   host permission for;
4. read `PublicKeyCredential.getClientCapabilities()['extension:prf']` with
   only the authenticator without PRF attached;
5. checked `'credentials' in navigator` in the extension's service worker.


[ambire-biometrics]: https://github.com/AmbireTech/extension/blob/3f6c7af91fde4c056da96ff9ede5c39f53ed7083/src/web/services/webauthnBiometrics.ts
[android-keystore]: https://developer.android.com/privacy-and-security/keystore
[apple-forum-prf]: https://developer.apple.com/forums/thread/764730
[apple-icloud-security]: https://support.apple.com/en-us/102195
[bitwarden-4365]: https://github.com/bitwarden/clients/issues/4365
[bitwarden-guard]: https://github.com/bitwarden/clients/blob/bac4c6695c08d14b6100d2c1d22ea81887f9d61a/apps/browser/src/auth/popup/guards/platform-popout.guard.ts
[bitwarden-hello-thread]: https://community.bitwarden.com/t/encryption-prf-via-windows-hello-passkey/94236/21
[bitwarden-help-passkeys]: https://bitwarden.com/help/login-with-passkeys/
[bitwarden-popout]: https://community.bitwarden.com/t/unlock-with-passkey-does-not-unlock-unless-popped-out/93649
[bitwarden-prf-unlock]: https://github.com/bitwarden/clients/blob/bac4c6695c08d14b6100d2c1d22ea81887f9d61a/libs/key-management-ui/src/lock/services/default-webauthn-prf-unlock.service.ts
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
[cr-storage-m140]: https://chromium.googlesource.com/chromium/src/+/a8f1f337c692360aaec9470a0a91f965011d37a3
[cr-supported-options]: https://github.com/chromium/chromium/blob/30c2a44f19b32e0dc50175f3fa392ec41bd741e6/device/fido/authenticator_supported_options.h
[cr-win-authenticator]: https://github.com/chromium/chromium/blob/30c2a44f19b32e0dc50175f3fa392ec41bd741e6/device/fido/win/authenticator.cc
[cr-win-hmac-mc]: https://github.com/chromium/chromium/blob/30c2a44f19b32e0dc50175f3fa392ec41bd741e6/device/fido/win/authenticator.cc#L68
[cr-win-prf-create]: https://chromium.googlesource.com/chromium/src/+/af1aabea3579861072872d9209bad47b3ff5b8e6
[credman]: https://w3c.github.io/webappsec-credential-management/
[google-envs]: https://developers.google.com/identity/passkeys/supported-environments
[google-gpm-blog]: https://blog.google/innovation-and-ai/technology/safety-security/google-password-manager-passkeys-update-september-2024/
[mdn-bcd]: https://github.com/mdn/browser-compat-data/blob/v8.1.3/api/CredentialsContainer.json
[mdn-bcd-pkc]: https://github.com/mdn/browser-compat-data/blob/v8.1.3/api/PublicKeyCredential.json
[mdn-derivekey]: https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey
[mdn-exportkey]: https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/exportKey
[mdn-ext-webauthn]: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Use_the_web_authn_api
[metamask-45783]: https://github.com/MetaMask/metamask-extension/issues/45783
[metamask-46400]: https://github.com/MetaMask/metamask-extension/pull/46400
[metamask-ceremony]: https://github.com/MetaMask/metamask-extension/blob/a7977f64104bd573ebb2024f3c9f09f18b1c4d2d/shared/lib/passkey/passkey-ceremony.ts
[metamask-controller]: https://github.com/MetaMask/core/blob/4ac8715616b371b7b9f585718a7d44bad01875a9/packages/passkey-controller/src/PasskeyController.ts
[metamask-help]: https://support.metamask.io/configure/wallet/passkeys/
[metamask-key-derivation]: https://github.com/MetaMask/core/blob/4ac8715616b371b7b9f585718a7d44bad01875a9/packages/passkey-controller/src/key-derivation.ts
[metamask-prf-hook]: https://github.com/MetaMask/metamask-extension/blob/a7977f64104bd573ebb2024f3c9f09f18b1c4d2d/ui/hooks/usePasskeyPRFSupport.ts
[ms-detect-win11]: https://learn.microsoft.com/en-us/microsoft-edge/web-platform/how-to-detect-win11
[ms-kb5077181]: https://support.microsoft.com/en-us/topic/february-10-2026-kb5077181-os-builds-26200-7840-and-26100-7840-f0fa9e54-a22a-4a06-96b6-bf5b2aded506
[ms-passkeys]: https://learn.microsoft.com/en-us/windows/security/identity-protection/passkeys/
[ms-pin-reset]: https://learn.microsoft.com/en-us/windows/security/identity-protection/hello-for-business/pin-reset
[ms-qa-pin]: https://learn.microsoft.com/en-us/answers/questions/3856049/
[ms-webauthn-v8]: https://github.com/microsoft/webauthn/commit/706d98d73a8c3d888e77f0d524f630d551b194c3
[nist-gcm]: https://csrc.nist.gov/pubs/sp/800/38/d/final
[rabby-biometric]: https://github.com/RabbyHub/Rabby/blob/e2b98a27e9ef979ab121e81e591fcf5ad79d6e19/src/ui/utils/biometric.ts
[ua-ch-platform-version]: https://wicg.github.io/ua-client-hints/#get-the-platform-version
[w3c-list-2023]: https://lists.w3.org/Archives/Public/public-webauthn/2023Dec/0078.html
[webauthn-l3]: https://www.w3.org/TR/webauthn-3/
