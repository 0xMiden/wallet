# Sign in with Bread: a login key per site, and a secure sign-in sheet

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sites can sign users in with Bread. Bread gives each account one login key per site, derived from the account's EVM key and the site's registrable domain, so the same seed phrase brings the same login back after a restore, on every device and in every Bread app. On phones, Bread's in-app browser also gets a secure sign-in sheet, so a site can run Google or Apple sign-in, which both refuse embedded web views.

**Architecture:** A pure module derives a secp256k1 scalar with HKDF-SHA256 from the account's root key and the registrable domain that `tldts` reads from the request's real origin. The vault resolves the root (the stored EVM key; for an account created before Bread stored EVM keys, the EVM key from its seed phrase; for a single private-key import, that key), builds an ECDSA `AuthSecretKey` from the scalar, and returns its commitment or a signature. Two new dApp messages reach the background from every Bread app, and the signature is approved through the existing signature confirmation in a login variant that names the site. The extension, mobile and desktop `window.midenWallet` gain two methods. The sheet is `window.bread.auth.open(url)` in the in-app browser's document-start script, backed by ASWebAuthenticationSession on iOS and a Custom Tab on Android, and it returns at Bread's fixed callback address. Bread's desktop window gains an empty `window.bread`, so a site can tell it runs inside Bread.

**Tech Stack:** TypeScript, React, `@miden-sdk/miden-sdk` 0.17.3 (`AuthSecretKey`, `Word`), `@noble/hashes` (HKDF-SHA256), `tldts` 7, `viem` (EVM key derivation), Swift (AuthenticationServices), Java (`androidx.browser` Custom Tabs), Capacitor, Jest, Robolectric, XCTest, Playwright.

**Pull requests:** two, independent of each other.
- **PR A, the login key** (Tasks A1 to A6), branch `wiktor/dapp-login-key`. It goes first: a site's Bread sign-in depends on it, and every Bread app needs it.
- **PR B, the sign-in sheet** (Tasks B1 to B5), branch `wiktor/bread-sign-in-sheet`. Phones only, plus the desktop marker.

Each PR carries this plan file, as the repo's plans do. Both edit `src-tauri/scripts/dapp-injection.js` (A5 after `signBytes`, B4 after the injection guard) and `CHANGELOG.md`; whichever merges second rebases.

## The contract sites rely on

### Login key (PR A), on the extension, iOS, Android and desktop `window.midenWallet`

```ts
requestLoginKey(): Promise<{ loginKey: Uint8Array }>
signLoginBytes(data: Uint8Array, kind: 'word'): Promise<{ signature: Uint8Array }>
```

- `loginKey` is the 32-byte commitment of the connected account's login key for the page's registrable domain, in the same form as the account key commitment that `connect` returns as `publicKey`.
- `signature` is a serialized SDK signature: 66 bytes, `[0x01, r(32), s(32), v(1)]`, recoverable ECDSA over secp256k1 with Keccak, the bytes `signBytes` returns for an ECDSA account key.
- Neither method takes a domain or an origin. Bread reads the domain from the page's real origin: the extension's content-script `MessageEvent.origin`, the in-app browser's page URL, the desktop window's URL.
- Both reject with an error whose message contains `LOGIN_KEY_UNAVAILABLE` when the account's root key isn't on this device. On the extension that error is a `MidenWalletError`, which is not an `Error` instance, so sites read its `message` and never test `instanceof Error`. Bread never derives a login key from any other key.
- A Bread without the login key has neither method. Sites detect the methods, never a version.
- One key per account and site: `https://example.com` and `https://www.example.com` share one; `alpha.github.io` and `beta.github.io` don't (the Public Suffix List's private section counts). A host with no registrable domain, such as `localhost` or an IP address, uses the whole host. Pages that aren't https are refused, except on loopback hosts.
- The login key signs only 32-byte words. It is never added to an account's signers, so its signatures can't authorize a transaction or a key change. The EVM key itself never signs anything for a page. The user approves every login signature in Bread.

### Sign-in sheet (PR B), Bread mobile only

```ts
const result = await window.bread.auth.open(url);
// { url: string }      when the flow reaches Bread's callback address
// { cancelled: true }  when the user closes the sheet
```

- `window.bread` becomes `{ version: 1, presentation, auth }`, with `auth = { version: 1, open }`. Sites detect `auth` by its presence.
- Only the main frame can call it, and only with an https URL on the calling page's own origin.
- One sheet at a time; a second call while one is open is refused.
- Bread's callback address is `com.miden.wallet.auth://callback`. Bread resolves `{ url }` only while its own sheet is open and only for that address, and forwards the URL untouched. It reads, stores and logs nothing from it. On Android, Bread takes the callback out of the intent before any Capacitor plugin sees it.
- The page stays loaded throughout.
- iOS uses a non-ephemeral ASWebAuthenticationSession, so Safari's existing Google or Apple sign-in is reused; iOS shows its own "'Bread' Wants to Use '<domain>' to Sign In" prompt. Android opens a Custom Tab with no prompt; the callback returns to the same Bread task and closes the tab.
- Bread's desktop app gets an empty, frozen `window.bread`, with no `version`, `presentation` or `auth`, so a site can tell it runs inside Bread while the published `window.bread?.version === 1` checks keep skipping presentation there. The extension gets nothing.

## Global Constraints

- Follow `AGENTS.md` and `CLAUDE.md`. Every account Bread creates is a Guardian account; the code below also handles the other kinds Bread still holds (single private-key imports, older non-Guardian HD accounts).
- One worktree per PR, each branched from `origin/main`. Rebase onto `origin/main` before opening a PR; a PR's translation job may push `chore: update translation files` to its branch, so pull before the next push.
- Tests and builds run in CI, never locally: `pr.yml` (lint, types, Jest, coverage of at least 95% on every axis, i18n, mock E2E), `pr-compile-surfaces.yml` (Android build and unit tests, desktop build and `cargo check`, iOS build and `AppTests`), `pr-e2e-local.yml` (local Chrome E2E) and `changelog.yml`. Light checks that build nothing (a formatter or linter on the changed files) are fine locally.
- CI runs per batch, not per task, about four runs per PR: the PR opens as a draft once its first batch is committed, the next batch pushes once, and review fixes push together. Each task writes its tests before its code. A regression test for a bug found along the way gets its own red push first.
- Commits are signed (`git commit -S`), single-line and imperative, never amended, and carry no co-author or tool trailer. PR bodies follow `CLAUDE.md` (user impact, testing, platform notes, screenshots for UI).
- Every user-facing string goes through i18n: add keys to `public/_locales/en/en.json` by hand (placeholders as `$name$`, read with `t('key', { name })`); CI generates the other locales. UI work reads `skills/miden-wallet-frontend/SKILL.md` first.
- Each PR adds its CHANGELOG entries under the open `## X.Y.Z (TBD)` section, the first one in its first batch, so the changelog check passes from the first push.
- Never use an em dash or an en dash, in code, copy, docs or commits. Use a hyphen.
- The derivation is frozen once released: the salt `Bread login key`, the version `v1`, the info layout, the counter rule, the secure-origin rule and the domain rule. Changing any of them changes every user's login key on every site. The domain rule reads the Public Suffix List bundled in `tldts`, so a `tldts` upgrade that changes a site's suffix changes that site's login keys: treat such an upgrade as a login key change and say so in the CHANGELOG.
- Nothing logs a root key, a scalar, a word to sign, a signature, or a callback URL.
- Nothing in this plan deletes, moves or re-derives a stored EVM key: sites' logins depend on Bread keeping each account's EVM key for as long as it holds the account.

## Review Focus

1. **A page tries to choose its domain.** Extra `domain` or `origin` fields in a request change nothing. Test: `ignores a domain or origin in the request` (A3).
2. **The account's root key isn't on this device.** Expect a refusal containing `LOGIN_KEY_UNAVAILABLE` before any prompt, on every Bread app. Tests: `refuses without the root key` (A2), `refuses without a prompt when the account has no root key` (A3), the provider refusal tests (A5).
3. **A wallet created before Bread stored EVM keys, seed phrase on the device.** Expect the same login key a restore of that seed gives, and nothing written. Test: `derives an older account's EVM key from its seed phrase without saving it` (A2).
4. **A restore, a key-QR device and a device whose seed phrase was removed.** Expect one login key. Tests in A2.
5. **A hot-key rotation.** Expect the login key unchanged. Test: `stays the same after a hot key rotation` (A2).
6. **A login signature over transaction inputs.** Refused. Test: `refuses a login signature over anything but a 32-byte word` (A3).
7. **Domains:** `www` and the bare domain share a key, private-suffix sites don't, plain http is refused outside loopback. Tests in A1.
8. **The sheet:** an iframe, a cross-origin or non-https URL, and a second open are refused; cancel on the sheet and on iOS's prompt resolves `{ cancelled: true }`; the Android return closes the tab with the page still loaded. Tests in B1 to B3, and the device checks in B5.
9. **The Android callback** never reaches a Capacitor plugin and nothing logs it; a pause alone never cancels a sign-in. Tests: `callbackIntentResolvesTheUrlUntouched`, `consumeStripsACallbackWithNoSheet`, `aPauseAloneKeepsTheSheet` and `mainActivityConsumesCallbacksBeforeTheBridge` (B3).
10. **Desktop:** `window.bread` is empty and frozen, so the published `version === 1` snippet still skips presentation there. Test: `marks the top document with an empty, frozen window.bread` (B4).

---

## Part A: the login key

Batch A1 is Tasks A1 and A2: rebase onto `origin/main`, push, and open PR A as a draft (title `Sign in with a Bread login key per site`, body per `CLAUDE.md`). Batch A2 is Tasks A3 to A6: one push. Review fixes push together. Mark the PR ready when batch A2 is green and ask for review; merging needs Wiktor's approval.

### Task A1: Derive a login key scalar from a root key and a site's domain

**Files:**
- Create: `src/lib/miden/login-key/derive.ts`
- Modify: `src/lib/adapter/types.ts` (`MidenDAppErrorType` at line 233 gains `LoginKeyUnavailable = 'LOGIN_KEY_UNAVAILABLE'`)
- Modify: `CHANGELOG.md`, PR A's entry under the open `## X.Y.Z (TBD)`, Features: `- [FEATURE][all] Sites can sign users in with a Bread login key. Each account has one key per site, derived from the account's EVM key and the site's domain, so restoring the wallet from its seed phrase, adding a device by key QR or removing the seed phrase keeps the same sign-in. The login key signs only sign-in messages, never transactions, and is never one of the account's signers. A device without the account's root key refuses instead of falling back to another key.`
- Test: create `src/lib/miden/login-key/derive.test.ts`

**Interfaces:**
```ts
export type LoginKeySource = 'evm' | 'auth';
export function loginKeyDomain(origin: string): string;
export function deriveLoginKeyScalar(
  root: Uint8Array,
  source: LoginKeySource,
  domain: string,
  expand?: (info: Uint8Array) => Uint8Array // defaults to HKDF-SHA256 below; tests replace it to reach the retry path
): Uint8Array; // 32 bytes, big-endian, 0 < k < n
```
- `loginKeyDomain(origin)`:
  - `new URL(origin)`; a failure throws `Error('INVALID_PARAMS: not an origin')`.
  - Secure pages only: `https:`, or `http:` on `localhost`, a `*.localhost` name, `127.0.0.1` or `[::1]`. Anything else throws `Error('INVALID_PARAMS: login keys need an https page')`.
  - `host = url.hostname.toLowerCase()` (the URL parser has already converted an IDN to punycode). Port and scheme never enter the domain.
  - `parse(host, { allowPrivateDomains: true })` from `tldts`: an IP or no `domain` gives `host`; otherwise `domain`.
- `deriveLoginKeyScalar`:
  - `info` is the UTF-8 bytes of `v1\0<source>\0<domain>\0` followed by one counter byte, starting at 0.
  - `k = hkdf(sha256, root, utf8('Bread login key'), info, 32)` (`@noble/hashes/hkdf`, `@noble/hashes/sha2`).
  - Accept `k` when `0 < k < n`, with n = `0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141`. Otherwise try the next counter, up to 255, then throw `Error('LOGIN_KEY_UNAVAILABLE: no valid login key')`.

- [ ] **Step 1: Write the failing tests:**
```ts
const EVM_A = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const EVM_B = '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
it('derives the pinned v1 scalar for an EVM root')
  // deriveLoginKeyScalar(hex(EVM_A), 'evm', 'example.org') === '607827d898bffa220a2942a4bc23457f485826ce30694b6bd193d4b6ef6120cd'
it('gives each domain its own scalar')
  // EVM_A, 'evm', 'example.com' === '6242d05d8449dc0f6ea438cf0c8f127390e6fa3927320a675575daceedbe80ff'
it('gives each root its own scalar')
  // EVM_B, 'evm', 'example.org' === 'db78b03edcac22ab6005d12304cf939d2166682409c3fff5fac11e5be04a3cee'
it('separates EVM roots from single-key roots')
  // EVM_A, 'auth', 'example.org' === '13e56d3c6b31646c46723c78ae86c4ec7b079a2ce4759d0425104e57f8dbf4f2'
it('uses the whole host where there is no registrable domain')
  // EVM_A, 'evm', 'localhost' === 'dfdd85ac20ee8139d9092849f1c4f7263bf5e563961c77fc2bd13d9a1f8cf699';
  // loginKeyDomain: 'http://localhost:5198' -> 'localhost', 'http://127.0.0.1:5198' -> '127.0.0.1', 'http://[::1]:3000' -> '[::1]'
it('shares one key between www and the bare domain')
  // 'https://www.example.org', 'https://example.org:443' and 'https://WWW.Example.ORG' -> 'example.org'
it('keeps sites on a shared hosting suffix apart')
  // 'https://alpha.github.io' -> 'alpha.github.io'; 'https://beta.github.io' -> 'beta.github.io'
it('refuses pages that are not https')
  // 'http://example.org', 'http://localhost.example.com', 'null', 'file:///tmp/x', 'chrome-extension://abc' throw INVALID_PARAMS
it('retries past a value outside the curve order')
  // expand returns n, then the pinned bytes: the result is the pinned bytes; the two infos end in 0x00 then 0x01
it('refuses after 256 values outside the order')
  // expand always returns 32 zero bytes: throws LOGIN_KEY_UNAVAILABLE
```
The pinned values were computed with plain HKDF-SHA256 (RFC 5869) from the rules above.
- [ ] **Step 2: Implement** `derive.ts` and the error type, and add the CHANGELOG entry.
- [ ] **Step 3: CI**, with batch A1 (Tasks A1 and A2): `pr.yml` unit and coverage, `changelog.yml`. Expected: PASS.
- [ ] **Step 4: Commit:** `git commit -S -m "Derive a per-site login key scalar from an account root key"`

### Task A2: The vault resolves the root key and signs with the login key

**Files:**
- Modify: `src/lib/miden/back/vault.ts` (new public methods after `signData`, line 2219; they use `deriveEvmKeyPair` at line 2705, `accEvmSecretKeyStrgKey` at line 203, `mnemonicStrgKey` at line 194, `accAuthSecretKeyStrgKey` at line 196, `fetchSeedPhraseStatus`, and `deserializeHotSecretKey` from `lib/miden/guardian/hot-key-import`)
- Test: create `src/lib/miden/back/vault.login-key.test.ts` (harness as in `vault.evm.test.ts` and `vault.gaps.test.ts`)

**Interfaces:**
```ts
// Vault
async loginKeyCommitment(accountId: string, connectedCommitment: string, domain: string): Promise<string>; // base64, 32 bytes
async signWithLoginKey(accountId: string, connectedCommitment: string, domain: string, word: string): Promise<string>; // word: base64 of 32 bytes; returns base64 of 66 bytes
```
- `connectedCommitment` is the session's stored account key commitment (base64, as connect returned it). It is read only to find a single-key import's secret.
- The root, resolved in this order:
  1. `account.evmAddress` is set and its leaf is stored: source `evm`, the 32-byte leaf.
  2. `account.hdIndex >= 0` and the seed phrase is stored: source `evm`, `deriveEvmKeyPair(mnemonic, account.type, account.hdIndex)`, held in memory only. Nothing is persisted and the account record is untouched. When `account.evmAddress` is set, the derived address must equal it, or the request is refused. This covers accounts created before Bread stored EVM keys, which a restore of the same seed phrase gives the same key. Seed removal already refuses while any such account lacks its stored key (`vault.ts:378-383`), so these devices keep their seed phrase.
  3. Not a Guardian account, `hdIndex < 0` and no `evmAddress` (a single private-key import): source `auth`, the stored serialized `AuthSecretKey` at `accAuthSecretKeyStrgKey(<hex of connectedCommitment>)`.
  4. Anything else, or a lookup that finds nothing: refuse with a `PublicError` whose message starts with `LOGIN_KEY_UNAVAILABLE:` (a `PublicError`, so `withError` keeps the message). Never fall back to the hot key, the cold key or any other key.
- The scalar from `deriveLoginKeyScalar(root, source, domain)` becomes `deserializeHotSecretKey(<hex of scalar>)`, an ECDSA `AuthSecretKey`. The commitment is `publicKey().toCommitment().serialize()`; the signature is `sign(Word.deserialize(<32 bytes>)).serialize()`. Every WASM handle is freed in `finally`, and the root and scalar buffers are zeroed after use.

- [ ] **Step 1: Write the failing tests:**
```ts
it('derives from the stored EVM key')
  // a Guardian account 0 from the Hardhat test mnemonic: the commitment equals
  // deserializeHotSecretKey(hex(deriveLoginKeyScalar(leaf, 'evm', 'example.org'))).publicKey().toCommitment()
it('gives a restored wallet the same login key')            // a second vault restored from the same mnemonic: same commitment
it('gives a key-QR device the same login key')              // a vault holding the account from its hot:evm key pair and no mnemonic: same commitment
it('keeps the login key after the seed phrase is removed')  // after seed removal: same commitment
it("derives an older account's EVM key from its seed phrase without saving it")
  // an account record without evmAddress, mnemonic stored: the restored wallet's commitment; accounts and stored keys unchanged afterwards
it('refuses an account whose seed phrase gives another EVM key')
  // evmAddress set, leaf missing, the mnemonic derives a different address: LOGIN_KEY_UNAVAILABLE
it('refuses without the root key')
  // Guardian account, no evmAddress, no seed phrase: LOGIN_KEY_UNAVAILABLE; neither the hot nor the cold key was decrypted
it('derives a single-key import from that key, the same after reimporting')
  // importAccountFromPrivateKey in two fresh vaults: same commitment, different from every EVM-derived one
it("never matches one of the account's signing keys")      // differs from the Guardian account's hot and cold key commitments
it('signs a word with a 66-byte ECDSA signature that verifies against the login key')
  // byte 0 is 0x01; the signature verifies under the login key's public key (SDK verify, or playwright/e2e/helpers/signature-recovery.ts)
it('stays the same after a hot key rotation')               // a new hotPublicKey on the account record: same commitment
it('gives each domain its own key')                         // 'example.com' gives another commitment
it('gives each account its own key')                        // account 1 of the same mnemonic gives another commitment
```
- [ ] **Step 2: Implement** the two methods and the root resolution.
- [ ] **Step 3: CI**, with batch A1: `pr.yml` unit and coverage. Expected: PASS.
- [ ] **Step 4: Commit:** `git commit -S -m "Resolve an account's root key and sign with its login key in the vault"`

### Task A3: Two dApp messages for the login key, handled for every Bread app

**Files:**
- Modify: `src/lib/adapter/types.ts` (`MidenDAppMessageType` at line 53, request and response interfaces beside `MidenDAppSignRequest` at line 166, the request and response unions)
- Modify: `src/lib/miden/back/dapp.ts` (`requestLoginKey` after `requestGuardianInfo`, line 1164; `requestLoginSign` after `requestSign`, line 686)
- Modify: `src/lib/miden/back/actions.ts` (`processDApp`, line 1042)
- Test: create `src/lib/miden/back/dapp.login-key.test.ts` (harness as in `dapp.extended.test.ts`); modify `src/lib/dapp-browser/message-handler.test.ts`

**Interfaces:**
```ts
LoginKeyRequest = 'LOGIN_KEY_REQUEST', LoginKeyResponse = 'LOGIN_KEY_RESPONSE',
LoginSignRequest = 'LOGIN_SIGN_REQUEST', LoginSignResponse = 'LOGIN_SIGN_RESPONSE'
interface MidenDAppLoginKeyRequest  { type: LoginKeyRequest;  sourceAccountId: string }
interface MidenDAppLoginKeyResponse { type: LoginKeyResponse; loginKey: string }   // base64, 32 bytes
interface MidenDAppLoginSignRequest { type: LoginSignRequest; sourceAccountId: string; payload: string; kind: 'word' } // payload: base64, 32 bytes
interface MidenDAppLoginSignResponse { type: LoginSignResponse; signature: string } // base64, 66 bytes
```
- Both handlers: `sourceAccountId` is required, else `INVALID_PARAMS`; `getDApp(origin, sourceAccountId)`, else `NOT_GRANTED`; `assertRequestAccountIsCurrent(dApp.accountId)`; `domain = loginKeyDomain(origin)`, from the `origin` argument only. Every other request field is ignored.
- `requestLoginKey`: no prompt. A locked wallet follows `requestGuardianInfo`: `runPrepare`, then `prepareAfterUnlock` on mobile and desktop, `requestUnlockOnly` on the extension. The vault call passes `dApp.publicKey` as `connectedCommitment`.
- `requestLoginSign`:
  - `kind` must be `'word'` and the payload must decode to 32 bytes, else `INVALID_PARAMS`.
  - While the wallet is unlocked, resolve the root before any prompt (`loginKeyCommitment`), so a missing root refuses with `LOGIN_KEY_UNAVAILABLE` and no prompt.
  - Then `requestSign`'s flow: mobile and desktop `waitForUnlockOnNonExtension` then `confirmOnNonExtension('loginSign', ...)`; the extension `requestConfirm` with payload type `'loginSign'` (Task A4). Decline gives `NOT_GRANTED`. Approval runs `assertDappSendStillAuthorized`, then `vault.signWithLoginKey(...)`.
- `processDApp` routes both through `getDappQueue()`, as `SignRequest`.

- [ ] **Step 1: Write the failing tests:**
```ts
it("answers the login key for the session's account and the page's domain")
  // origin https://www.example.org: loginKeyCommitment(accountId, dApp.publicKey, 'example.org'); LOGIN_KEY_RESPONSE
it('ignores a domain or origin in the request')
  // request with domain 'evil.example' and origin 'https://evil.example': still 'example.org'
it('refuses a page without a session')                     // NOT_GRANTED; vault untouched
it('refuses a page that is not https')                     // origin http://example.org: INVALID_PARAMS
it('unlocks before answering a locked wallet')             // mobile waits for unlock; the extension goes through requestUnlockOnly
it('refuses a login signature over anything but a 32-byte word') // kind 'signingInputs', or a 31-byte payload: INVALID_PARAMS, no prompt
it('refuses without a prompt when the account has no root key')
  // loginKeyCommitment rejects with LOGIN_KEY_UNAVAILABLE: the rejection keeps it; no confirmOnNonExtension or requestConfirm call
it("asks with the site's domain and signs on approval")
  // confirmation type 'loginSign' with domain 'example.org'; approval: LOGIN_SIGN_RESPONSE with the vault's signature
it('refuses on decline')                                   // NOT_GRANTED; signWithLoginKey not called
it('routes both messages through processDApp')             // both reach their handlers through the queue; dApp access off: NOT_GRANTED
// message-handler.test.ts
it('passes a login key refusal to the in-app page with its code') // the error sent back contains LOGIN_KEY_UNAVAILABLE
```
- [ ] **Step 2: Implement** the types, handlers and routing.
- [ ] **Step 3: CI**, with batch A2 (Tasks A3 to A6): `pr.yml` unit and coverage. Expected: PASS.
- [ ] **Step 4: Commit:** `git commit -S -m "Answer login key requests and login signatures from dApps"`

### Task A4: The login approval names the site

**Files:**
- Modify: the confirmation payload types that hold `type: 'sign'` (find with `rg -n "type: 'sign'" src/lib/miden/types.ts src/lib/dapp-browser`), adding `{ type: 'loginSign'; origin; networkRpc; appMeta; domain: string; accountId: string }`
- Modify: `src/app/ConfirmPage.tsx` (content near line 168, approval near line 536, header near line 700; `'loginSign'` approves through `confirmDAppSign`), `src/lib/dapp-browser/confirmation-store.ts` (line 85: `'loginSign'` titles with `dappLoginSignRequest`), and the mobile and desktop modals that render `'sign'` (find with `rg -ln "dappSignRequest|OPAQUE_SIGNATURE_WARNING" src`)
- Modify: `public/_locales/en/en.json`, `src/app/pages` selectors file that defines `ConfirmPageSelectors` (add `LoginSign_AcceptButton` and `LoginSign_RejectButton`)
- Test: the existing tests for `ConfirmPage`, `confirmation-store` and the modal (find with `rg -l "SignData_AcceptButton|dappSignRequest" src --glob '*.test.*'`)

**Interfaces:**
- English copy:
  - `"confirmLoginSignature": "Sign in to $domain$"`
  - `"dappLoginSignRequest": "This site wants you to sign in to $domain$ with Bread"`
  - `"loginSignatureNote": "Bread signs with a key made only for $domain$. It can't move funds or change your account."`
- The approval shows the title, the note and the account, and no opaque-signature warning: the login key can only sign in to that site.
- Approve and decline reuse the signature confirmation message, so the background's existing `DAppSignConfirmationRequest` handling settles it.

- [ ] **Step 1: Write the failing tests:**
```ts
it("shows a login approval with the site's domain") // 'Sign in to example.org', the note and the account; no opaque-signature warning
it('approves and declines through the signature confirmation') // accept: confirmDAppSign(id, true); reject: confirmDAppSign(id, false)
it('titles an in-app login request with the domain') // confirmation-store: 'loginSign' -> dappLoginSignRequest with the domain
```
- [ ] **Step 2: Implement** the screen, store mapping, modal and copy, following `skills/miden-wallet-frontend/SKILL.md`.
- [ ] **Step 3: CI**, with batch A2: `pr.yml` unit, coverage and i18n. Expected: PASS. Attach a screenshot of the extension approval and the phone sheet to the PR.
- [ ] **Step 4: Commit:** `git commit -S -m "Show a login approval that names the site"`

### Task A5: The page methods on every Bread app

**Files:**
- Modify: `src/lib/adapter/client.ts` (`requestLoginKey` and `signLoginBytes` after `signBytes`, line 182)
- Modify: `src/lib/adapter/midenWindowObject.ts` (methods after `signBytes`, line 78)
- Modify: `src/lib/dapp-browser/injection-script.ts` (methods after `signBytes`, line 340)
- Modify: `src-tauri/scripts/dapp-injection.js` (methods after `signBytes`, line 419)
- Test: `src/lib/adapter/midenWindowObject.test.ts`, `src/lib/adapter/client.test.ts`, `src/lib/dapp-browser/injection-script.test.ts`, `src/lib/desktop/dapp-injection.test.ts`

**Interfaces:** the contract above, on all three providers:
- `requestLoginKey()` sends `{ type: 'LOGIN_KEY_REQUEST', sourceAccountId: this.address }` and decodes `loginKey` from base64 into a real `Uint8Array`, as connect decodes `publicKey`.
- `signLoginBytes(data, kind)` sends `{ type: 'LOGIN_SIGN_REQUEST', sourceAccountId: this.address, payload: <base64 of data>, kind }` and decodes `signature`.
- Refusals keep the background's message, so `LOGIN_KEY_UNAVAILABLE` stays in it: the extension's `createError` copies the message into a `MidenWalletError`, not an `Error`; the in-app script rejects with `new Error(error)`; desktop does the same.
- The conformance suite's `KNOWN_GAPS` stay as they are: these are additions to the adapter's interface.

- [ ] **Step 1: Write the failing tests:**
```ts
// midenWindowObject.test.ts
it('requests the login key for the connected account') // request {type:'LOGIN_KEY_REQUEST', sourceAccountId}; loginKey instanceof Uint8Array, 32 bytes
it('signs login bytes as base64 with the kind')        // payload is base64 of data, kind 'word'; signature is a 66-byte Uint8Array
// client.test.ts
it('keeps LOGIN_KEY_UNAVAILABLE in the error message')  // an error response 'LOGIN_KEY_UNAVAILABLE: ...' rejects with a message containing it
// injection-script.test.ts
it('gives the in-app provider the login key methods')  // both are functions
it('returns the login key as a Uint8Array')            // native response {loginKey: base64}: Uint8Array of 32
it('rejects with the refusal code as text')            // native error 'LOGIN_KEY_UNAVAILABLE: ...': Error message contains it
// dapp-injection.test.ts
it('gives the desktop provider the login key methods') // the same request shapes and decoding over the desktop bridge
```
- [ ] **Step 2: Implement** the methods on the three providers and the client.
- [ ] **Step 3: CI**, with batch A2: `pr.yml` unit and coverage, `pr-compile-surfaces.yml` desktop build. Expected: PASS.
- [ ] **Step 4: Commit:** `git commit -S -m "Expose requestLoginKey and signLoginBytes on every Bread provider"`

### Task A6: A real extension signs in with its login key

**Files:**
- Modify: `playwright/e2e/helpers/dapp-matrix.ts` (`L1` and `L2` in `DAPP_JOURNEY_CELLS.R`, after `G4`)
- Modify: `playwright/e2e/tests/dapp/signing-and-refusals.spec.ts` (the two cells, beside `G1` and `G3`, which they mirror)
- Modify: `playwright/e2e/test-dapp/protocol.ts` and `playwright/e2e/test-dapp/test-dapp.ts` (commands `loginKey` and `signLoginWord`, which call `window.midenWallet` directly because the published adapter has neither method; a provider without the method throws a `HarnessCheckError`)
- Modify: `playwright/e2e/helpers/confirm-actions.ts` (a `loginSign` kind with `ConfirmPage/LoginSign/AcceptButton` and `ConfirmPage/LoginSign/RejectButton`)
- No new `login-key.spec.ts`: the dApp workflow runs every test as a journey of cells, and its judge fails a test that writes no cell records, so the round trip is two more cells of the signing journey, R.

**Interfaces:**
```ts
// L1: a site gets one login key and a verifiable login signature
// loginKey twice, each without a prompt (expectNoPrompt): the same 32 bytes, different from connect's publicKeyHex;
// signLoginWord(word): approved with LoginSign_AcceptButton through answerPrompt, naming the dApp's origin; 66 bytes starting with 1;
// while that popup is open (whileOpen), its title names the page's domain, exactly "Sign in to localhost" for dApp one,
// since localhost, the fixture's host, has no registrable domain and loginKeyDomain gives the whole host;
// the signature recovers to a key whose commitment is the login key (playwright/e2e/helpers/signature-recovery.ts, then verifySignature, as G1)
// L2: a declined login signature rejects
// signLoginWord declined with LoginSign_RejectButton: refusal('NotGrantedMidenWalletError', 'NOT_GRANTED')
```
- [ ] **Step 1: Write the cells** above.
- [ ] **Step 2: Wire** the fixture commands and the `loginSign` confirm kind.
- [ ] **Step 3: CI**, with batch A2: no pull request workflow runs `playwright.dapp.config.ts`, so dispatch `e2e-dapp.yml` on this branch with `part: core`, since R is in core. Expected: PASS, with `L1` and `L2` passing on both axes.
- [ ] **Step 4: Commit:** `git commit -S -m "Test a login key round trip in the extension"`

---

## Part B: the sign-in sheet

Batch B1 is Tasks B1 and B2: rebase onto `origin/main`, push, and open PR B as a draft (title `A secure sign-in sheet in Bread's in-app browser`, body per `CLAUDE.md`). If PR A hasn't merged yet, PR B carries this plan file too. Batch B2 is Tasks B3, B4 and B5: one push. Review fixes push together. Mark the PR ready when batch B2 is green and the device checks in B5 are recorded; merging needs Wiktor's approval.

Line numbers below are from `def2b853f`; if `main` has moved, find the line by the symbol named beside it. B1 is inert on its own (`auth` appears only when a native transport exists), so B1, B2 and B3 can land in any order inside the PR.

### Rules B1 to B3 share

**Page API**
- `window.bread = Object.freeze({ version: 1, presentation, auth })`, with `auth = Object.freeze({ version: 1, open(url) })`. `auth` exists only when the native `breadAuth` transport does; the top-level version stays 1.
- `open(url)` resolves to a frozen `{ url: string }` or a frozen `{ cancelled: true }`, or rejects with an `Error` whose message is exactly one of `AUTH_NOT_MAIN_FRAME`, `AUTH_INSECURE_PAGE`, `AUTH_INVALID_URL`, `AUTH_BUSY`, `AUTH_UNAVAILABLE`, `AUTH_FAILED`.

**iOS wire:** the page calls `window.webkit.messageHandlers.breadAuth.postMessage({ url })`, which returns a Promise. Native replies exactly once: `replyHandler(["url": s], nil)`, `replyHandler(["cancelled": true], nil)` or `replyHandler(nil, "AUTH_...")`.

**Android wire:** the page calls `window.breadAuth.postMessage(JSON.stringify({ id, url }))`. Native replies once, on that message's `JavaScriptReplyProxy`: `{"id":id,"url":s}`, `{"id":id,"cancelled":true}` or `{"id":id,"error":"AUTH_..."}`. `id` is `<document token>_auth_<n>`; native ignores a message without a string `id` of 1 to 128 characters, because it can't address a reply.

**Check order, both platforms**
1. The main frame, else `AUTH_NOT_MAIN_FRAME`.
2. The page origin native reports is https with a host, else `AUTH_INSECURE_PAGE`.
3. The URL rule, else `AUTH_INVALID_URL`.
4. No sheet open anywhere in the app, else `AUTH_BUSY`.
5. Presentable now: the browser is visible, not parked or closing, and the app is in the foreground, else `AUTH_UNAVAILABLE`. A session that can't start or present is also `AUTH_UNAVAILABLE`.
6. Any other failure is `AUTH_FAILED`.

**URL rule.** All of these hold:
- A string of 1 to 4096 UTF-16 units.
- Every character is in the RFC 3986 set `A-Z a-z 0-9 - . _ ~ : / ? # [ ] @ ! $ & ' ( ) * + , ; = %`. This drops backslashes, spaces and non-ASCII, so our parser and the browser's can't disagree.
- Scheme `https` with a non-empty host, and no userinfo.
- The host equals the page's host, ignoring ASCII case, on the same effective port: an absent port means 443, and iOS `WKSecurityOrigin.port == 0` and Android `Uri.getPort() == -1` mean the default.
- Relative URLs are refused, never resolved.

**Callback rule.** The URL starts with `com.miden.wallet.auth://callback` (ASCII case-insensitive) and ends there or continues with `?` or `#`; any path, such as `callback/`, fails with `AUTH_FAILED`. It resolves only while that platform's sheet is open and is forwarded byte for byte: native never parses its query, stores it or logs it.

### Task B1: window.bread.auth in the mobile page script

**Files:**
- Modify: `src/lib/dapp-browser/presentation-script.ts`
  - Export the Android wire types after `PresentationResponse` (lines 10-15).
  - Inside `PRESENTATION_SCRIPT`, capture the auth transports next to the presentation transports (lines 21-24).
  - Add the auth helpers after `__breadPresentationUpdate` (ends line 97).
  - Line 99 defines `window.bread` with `auth` when it exists. Line 98 (`presentation`) is unchanged.
- Modify: `CHANGELOG.md`, PR B's mobile entry under the open `## X.Y.Z (TBD)`, Features: `- [FEATURE][mobile] Sites in Bread's in-app browser can run Google or Apple sign-in in a secure sign-in sheet: window.bread.auth.open(url) opens the system sign-in sheet on iOS and a Custom Tab on Android for an https page on its own origin, one sheet at a time, and resolves when the flow reaches Bread's callback address.`
- Test: `src/lib/dapp-browser/presentation-script.test.ts`

**Interfaces:**
- `export interface AuthRequest { id: string; url: string }` and `export interface AuthReply { id: string; url?: string; cancelled?: true; error?: string }` (the Android wire, for tests and docs).
- Transports, captured at document start:
  - `const iosAuth = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.breadAuth;`
  - `const androidAuth = ios ? undefined : window.breadAuth;`, where `ios` is the existing presentation transport at line 21, so on iOS a page can never steer the Android path.
- `auth = Object.freeze({ version: 1, open: url => openAuth(url) })`, defined only when `(iosAuth || androidAuth).postMessage` is a function. Line 99 becomes `Object.defineProperty(window, 'bread', { value: Object.freeze(auth ? { version: 1, presentation, auth } : { version: 1, presentation }) });`, with the same descriptor as today.
- `openAuth(url)`:
  - A fast path, not a security boundary: a non-string `url` or one over 4096 characters rejects `AUTH_INVALID_URL` without posting.
  - No timeout and no count cap, unlike `request()` at lines 40-58: a sign-in can take minutes, and native answers every extra call with `AUTH_BUSY` straight away.
  - Android replies are matched by `token + '_auth_' + n`, using the document token from line 29. The listener is `androidAuth.addEventListener('message', ...)`, or `androidAuth.onmessage` when `addEventListener` is missing, and it ignores non-JSON, non-object, unknown and already-settled ids.
- `authError(e)` keeps a message that is one of the six codes and turns anything else into `AUTH_FAILED`. `authResult(reply)` gives a frozen `{ cancelled: true }` for `cancelled === true`, a frozen `{ url }` for a string `url`, and throws `AUTH_FAILED` otherwise.

- [ ] **Step 1: Write the failing tests.** First give `page()` (lines 21-38) a third parameter, `auth = false`. On iOS it adds `webkit.messageHandlers.breadAuth`, whose `postMessage` records the body and returns a promise the test settles. On Android it adds `breadAuth = { postMessage, addEventListener }` and a `nativeReply(reply: AuthReply | string)` helper that sends `{ data }` to the captured listener. Widen `PageWindow` (lines 4-20) with `breadAuth` and `bread.auth`, without `any` or `as`.
```ts
it('adds a frozen auth API beside presentation when the auth transport exists') // keys version, presentation, auth; both frozen; auth.version 1
it('omits auth when only the presentation transport exists')   // 'auth' in win.bread is false; presentation.ready() still posts
it('iOS: posts {url} once and resolves a frozen {url} untouched') // 'com.miden.wallet.auth://callback?login=a%2Fb&x=1', frozen
it('iOS: resolves a frozen {cancelled: true}')
it.each(SIX_CODES)('rejects with the native code %s on both transports') // iOS Error(code) and Android {id, error: code}
it('maps an unknown native error or a malformed reply to AUTH_FAILED') // Error('boom'), {} and {url: 1}
it('rejects a non-string or over-long url locally as AUTH_INVALID_URL') // open(1) and 4097 characters post nothing; 4096 posts
it('Android: correlates out-of-order replies by document-scoped id') // ids match /^[0-9a-f]{32}_auth_[12]$/
it('Android: ignores malformed, unknown and repeated replies')   // invalid JSON, 'null', a foreign id, a second reply
it('keeps a sign-in pending past the presentation timeout')      // pending after jest.advanceTimersByTime(600000); a later reply resolves it
it('turns a throwing transport into a rejected promise')         // a throwing Android postMessage rejects AUTH_FAILED; a later reply is ignored
// extend 'preserves the document token and frozen API on reinjection' (lines 84-97): win.bread.auth is the same object
// extend 'exposes nothing in ordinary browsers or child frames' (lines 155-164): both auth transports present and win.top = {}: no win.bread, nothing posted
```
- [ ] **Step 2: Implement** inside the template string, after line 97:
```js
const AUTH_ERRORS = ['AUTH_NOT_MAIN_FRAME', 'AUTH_INSECURE_PAGE', 'AUTH_INVALID_URL', 'AUTH_BUSY', 'AUTH_UNAVAILABLE', 'AUTH_FAILED'];
const authPending = new Map();
let authSequence = 0;
function authError(error) {
  const code = typeof error === 'string' ? error : error && error.message;
  return new Error(AUTH_ERRORS.includes(code) ? code : 'AUTH_FAILED');
}
function authResult(reply) {
  if (reply && reply.cancelled === true) return Object.freeze({ cancelled: true });
  if (reply && typeof reply.url === 'string') return Object.freeze({ url: reply.url });
  throw new Error('AUTH_FAILED');
}
function openAuth(url) {
  if (typeof url !== 'string' || url.length > 4096) return Promise.reject(new Error('AUTH_INVALID_URL'));
  if (iosAuth) {
    try {
      return Promise.resolve(iosAuth.postMessage({ url })).then(authResult, error => { throw authError(error); });
    } catch (error) {
      return Promise.reject(authError(error));
    }
  }
  return new Promise((resolve, reject) => {
    const id = token + '_auth_' + (++authSequence);
    authPending.set(id, { resolve, reject });
    try {
      androidAuth.postMessage(JSON.stringify({ id, url }));
    } catch (error) {
      authPending.delete(id);
      reject(authError(error));
    }
  });
}
function authMessage(event) {
  let reply;
  try { reply = JSON.parse(event.data); } catch (error) { return; }
  const call = reply && typeof reply.id === 'string' ? authPending.get(reply.id) : undefined;
  if (!call) return;
  authPending.delete(reply.id);
  if (typeof reply.error === 'string') { call.reject(authError(reply.error)); return; }
  try { call.resolve(authResult(reply)); } catch (error) { call.reject(error); }
}
```
  Then, after line 98:
```js
const authTransport = iosAuth || androidAuth;
const auth = authTransport && typeof authTransport.postMessage === 'function'
  ? Object.freeze({ version: 1, open: url => openAuth(url) })
  : undefined;
if (auth && androidAuth) {
  if (typeof androidAuth.addEventListener === 'function') androidAuth.addEventListener('message', authMessage);
  else androidAuth.onmessage = authMessage;
}
```
  Replace line 99 as in Interfaces. The provider already passes `PRESENTATION_SCRIPT` on every mobile dApp open (`DappBrowserProvider.tsx` lines 961-980), so nothing else changes.
- [ ] **Step 3: CI**, with batch B1: `pr.yml` unit (lint, types, Jest), coverage and the `ci` gate, and `changelog.yml`. The script is a string constant, so coverage is unchanged. Expected: PASS.
- [ ] **Step 4: Commit:** `git commit -S -m "Add window.bread.auth to the mobile dApp page script"`

### Task B2: Open dApp sign-in in ASWebAuthenticationSession on iOS

**Files:**
- Create: `packages/dapp-browser/ios/Sources/InAppBrowserPlugin/BreadAuthState.swift` (Foundation only; mirrors `BreadPresentationState.swift`, a plain `final class` at line 3)
- Create: `packages/dapp-browser/ios/Sources/InAppBrowserPlugin/BreadAuthController.swift` (WebKit and AuthenticationServices; mirrors `BreadPresentationController.swift`: a plain `final class ...: NSObject` at line 25, owned by `WKWebViewController`, with a `deinit`)
- Modify: `packages/dapp-browser/ios/Sources/InAppBrowserPlugin/WKWebViewController.swift`
  - Line 135: `var breadAuth: BreadAuthController?` beside `var breadPresentation`.
  - Lines 679-682: inside `if let options = breadOptions { ... }` in `initWebview`, create the controller and register `breadAuth` before the existing `breadPresentation` handler and user script.
  - Line 1143: `breadAuth?.close()` immediately before `breadPresentation?.close()`, the first line of `cleanupWebView()` (lines 1142-1173). Every close path reaches it: `InAppBrowserPlugin.swift` lines 814, 1119 and 1377, and `WKWebViewController.swift` line 463.
  - Line 1160: beside `removeScriptMessageHandler(forName: "breadPresentation")`, add `removeScriptMessageHandler(forName: "breadAuth", contentWorld: .page)`.
- Modify: `ios/App/App.xcodeproj/project.pbxproj`: the four AppTests entries for the new test file, with the unused IDs `BCAD00000000000000000003` (build file) and `BCAD00000000000000000004` (file reference): PBXBuildFile beside line 10, PBXFileReference beside line 47, the AppTests group `E82100000000000000000008` beside line 146, and the AppTests Sources phase `E8210000000000000000000B` beside line 278.
- Test: create `ios/App/AppTests/BreadAuthTests.swift`

The two package files need no pbxproj entries and no manual registration: SwiftPM compiles everything under `ios/Sources/InAppBrowserPlugin`, and `InAppBrowserPlugin` is already a bridged package plugin. No `Info.plist` change: ASWebAuthenticationSession catches its own callback scheme, and registering `com.miden.wallet.auth` in `CFBundleURLTypes` would let any app deliver it to `AppDelegate.application(_:open:options:)` (lines 36-41), which hands every URL to `ReownPlugin.handleDeeplink`.

The logic lives in `BreadAuthController.swift`, not in `WKWebViewController` or `InAppBrowserPlugin`: the sheet lives as long as one browser instance, its anchor is that instance's window, and its teardown is `cleanupWebView()`, exactly like `breadPresentation`.

**Interfaces:**
```swift
enum BreadAuthError: String, Error {
    case notMainFrame = "AUTH_NOT_MAIN_FRAME", insecurePage = "AUTH_INSECURE_PAGE", invalidURL = "AUTH_INVALID_URL",
         busy = "AUTH_BUSY", unavailable = "AUTH_UNAVAILABLE", failed = "AUTH_FAILED"
}
struct BreadAuthPageOrigin { let scheme: String; let host: String; let port: Int }   // from WKSecurityOrigin; port 0 is the default
final class BreadAuthState {
    static let callbackScheme = "com.miden.wallet.auth"
    static let callbackAddress = "com.miden.wallet.auth://callback"
    static let maxURLLength = 4096
    private(set) var openTicket: Int?
    func begin() -> Int?                 // nil while any sheet is open
    func end(_ ticket: Int)              // a stale ticket changes nothing
    static func validate(mainFrame: Bool, page: BreadAuthPageOrigin, url: Any?) -> Result<URL, BreadAuthError>
    static func isCallback(_ url: String) -> Bool
}
protocol BreadAuthWebSession: AnyObject {
    var presentationContextProvider: ASWebAuthenticationPresentationContextProviding? { get set }
    var prefersEphemeralWebBrowserSession: Bool { get set }
    func start() -> Bool
    func cancel()
}
extension ASWebAuthenticationSession: BreadAuthWebSession {}
final class BreadAuthController: NSObject, WKScriptMessageHandlerWithReply, ASWebAuthenticationPresentationContextProviding {
    static var state = BreadAuthState()  // one sheet across every browser instance; tests replace it
    static var makeSession: (URL, String, @escaping (URL?, Error?) -> Void) -> BreadAuthWebSession
    var canPresent: () -> Bool           // the container window is present and not hidden, the app is active, not closing
    init(owner: WKWebViewController)     // weak owner
    func handle(body: Any, mainFrame: Bool, page: BreadAuthPageOrigin, reply: @escaping (Any?, String?) -> Void)
    func close()                         // if open: reply ["cancelled": true], then session.cancel(), then free the slot
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor // owner.viewIfLoaded?.window
}
final class WeakScriptMessageReplyHandler: NSObject, WKScriptMessageHandlerWithReply // replies AUTH_UNAVAILABLE once the delegate is gone
```
An open sheet ends with exactly one reply and `end(ticket)`:

| Event | Reply |
| --- | --- |
| Completion with a callback URL that passes `isCallback` | `["url": callbackURL.absoluteString]` |
| Completion with any other callback URL | `AUTH_FAILED` |
| `.canceledLogin` (includes Cancel on the system prompt) | `["cancelled": true]` |
| `.presentationContextNotProvided` or `.presentationContextInvalid` | `AUTH_UNAVAILABLE` |
| Any other error | `AUTH_FAILED` |
| `start() == false` | `AUTH_UNAVAILABLE` |
| `close()` or `deinit` | `["cancelled": true]`, then `session.cancel()` |

A completion after `close()` finds another ticket or none and is ignored. The session has `prefersEphemeralWebBrowserSession = false`, is held strongly while open, and uses the controller as its presentation context provider.

- [ ] **Step 1: Write the failing tests** in `BreadAuthTests.swift`: `@MainActor final class BreadAuthTests: XCTestCase` with `@testable import InappbrowserPlugin`. `setUp` installs a fresh `BreadAuthController.state` and a fake `makeSession` that records its arguments and returns a `FakeSession`; `tearDown` restores both. Live tests copy the controller and window setup of `testRealFramesCannotBypassDocumentCloseAuthority` (`BreadPresentationTests.swift` lines 477-499) and its `eventually` helper (lines 577-583).
```swift
testValidationChecksMainFrameFirst            // a child frame on an http page with a bad url: AUTH_NOT_MAIN_FRAME
testValidationRejectsNonHttpsPages            // page schemes http, about and "", and an empty host: AUTH_INSECURE_PAGE
testValidationRejectsUrlsOutsideThePageOrigin // nil, a number, relative, http, another host, :444, user@, a backslash,
                                              // a space, a non-ASCII host, 4097 characters: AUTH_INVALID_URL
testValidationAcceptsSameOriginWithDefaultPortAndHostCase // page (https, game.example, 0) accepts https://GAME.example:443/auth?x=1#y and 4096 characters
testCallbackAddressIsExactWithAnyQuery        // accepts ...://callback, ...callback?login=a%2Fb, ...callback#f, an upper-case scheme;
                                              // rejects ...://callbacks, ...://callback/, ...://callback/x, ...://other, com.miden.wallet://callback
testOneSheetAcrossTheApp                      // a second begin() is nil; end(stale) keeps it busy; end(current) frees it
testOpenStartsANonEphemeralSessionForTheCallbackScheme // the exact url and com.miden.wallet.auth; not ephemeral; provider is the controller; start() once; no reply yet
testCallbackResolvesTheUrlUntouched           // com.miden.wallet.auth://callback?login=a%2Fb&x=1 replies ["url": that string] once and frees the slot
testForeignCallbackFails                      // com.miden.wallet.auth://other: AUTH_FAILED
testCanceledLoginResolvesCancelled            // ASWebAuthenticationSessionError(.canceledLogin): ["cancelled": true]
testPresentationErrorsAreUnavailableAndOtherErrorsFail
testStartFailureIsUnavailableAndFreesTheSlot  // start() false: AUTH_UNAVAILABLE; the next open starts a session
testSecondOpenFromAnyBrowserIsBusy            // a second controller: AUTH_BUSY; the first session untouched
testHiddenOrInactiveBrowserIsUnavailable      // canPresent false: AUTH_UNAVAILABLE, no session
testCleanupCancelsTheSessionAndRepliesOnce    // owner.cleanupWebView(): cancelled once, cancel() called, slot freed; a late completion replies nothing
testAnchorIsTheInAppBrowserWindow             // presentationAnchor(for:) is the instance's container window
testRealWebKitRepliesWithExactCodes           // live page at https://example.test: https://other.test/ gets AUTH_INVALID_URL;
                                              // https://example.test/auth gets AUTH_UNAVAILABLE (the window is never shown);
                                              // a srcdoc iframe gets AUTH_NOT_MAIN_FRAME (written to parent.__authFrame, polled)
testAuthSchemeIsNotRegisteredWithTheSystem    // Bundle.main CFBundleURLTypes has no com.miden.wallet.auth
```
- [ ] **Step 2: Implement.** Registration, replacing lines 679-682:
```swift
if let options = breadOptions {
    let auth = BreadAuthController(owner: self)
    breadAuth = auth
    userContentController.addScriptMessageHandler(WeakScriptMessageReplyHandler(auth), contentWorld: .page, name: "breadAuth")
    userContentController.add(weakHandler, name: "breadPresentation")
    userContentController.addUserScript(WKUserScript(source: options.script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
}
```
  The entry point checks the frame natively, because `.page` handlers are visible to every frame:
```swift
func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                           replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
    let origin = message.frameInfo.securityOrigin
    handle(body: message.body, mainFrame: message.frameInfo.isMainFrame,
           page: BreadAuthPageOrigin(scheme: origin.protocol, host: origin.host, port: origin.port),
           reply: { value, error in replyHandler(value, error) })
}

func handle(body: Any, mainFrame: Bool, page: BreadAuthPageOrigin, reply: @escaping (Any?, String?) -> Void) {
    let url: URL
    switch BreadAuthState.validate(mainFrame: mainFrame, page: page, url: (body as? [String: Any])?["url"]) {
    case .failure(let error): reply(nil, error.rawValue); return
    case .success(let valid): url = valid
    }
    guard let ticket = Self.state.begin() else { reply(nil, BreadAuthError.busy.rawValue); return }
    guard canPresent() else { Self.state.end(ticket); reply(nil, BreadAuthError.unavailable.rawValue); return }
    let session = Self.makeSession(url, BreadAuthState.callbackScheme) { [weak self] callback, error in
        DispatchQueue.main.async { self?.complete(ticket, callback: callback, error: error) }
    }
    session.presentationContextProvider = self
    session.prefersEphemeralWebBrowserSession = false
    self.ticket = ticket; self.session = session; self.reply = reply
    if !session.start() { finish(ticket, nil, BreadAuthError.unavailable.rawValue) }
}
```
  - `complete` maps outcomes per the table. `finish(ticket, value, error)` returns unless `self.ticket == ticket`, then clears `ticket`, `reply` and `session`, calls `Self.state.end(ticket)`, and calls the saved reply once. `close()` finishes with `["cancelled": true]`, then calls `cancel()` on the session it kept. `deinit { close() }`.
  - `canPresent` defaults to `{ [weak owner] in guard let owner, owner.managedClose?.closing != true, let window = owner.viewIfLoaded?.window else { return false }; return !window.isHidden && UIApplication.shared.applicationState == .active }` (`managedClose` is the weak property at line 133).
  - `validate` follows the URL rule, using `URLComponents(string:)` after the character check and comparing `components.port ?? 443` with `page.port == 0 ? 443 : page.port`. `isCallback` is a string prefix check per the callback rule.
  - `WeakScriptMessageReplyHandler` mirrors `WeakScriptMessageHandler` (`WKWebViewController.swift` lines 3467-3478), except that a nil delegate gets `replyHandler(nil, "AUTH_UNAVAILABLE")`: WebKit needs exactly one reply per message.
  - Swift 5 language mode (tools 5.9, `SWIFT_VERSION = 5.0`, no warnings-as-errors): keep the classes plain like `BreadPresentationController`. Concurrency mismatches against the iOS 26 SDK show up as warnings, and the iOS 15 initializer `init(url:callbackURLScheme:completionHandler:)`, deprecated from 17.4, only warns.
- [ ] **Step 3: CI**, with batch B1: `pr-compile-surfaces.yml` job `ios` ("Compile iOS"): "Build App scheme" and "Run iOS unit tests" (`-only-testing:AppTests`, which also runs `BreadPresentationTests`, guarding the shared registration and cleanup). Also `pr.yml` and `changelog.yml`. `packages/dapp-browser/ios/Tests/run.sh` runs in no workflow, so no tests go there. Expected: PASS.
- [ ] **Step 4: Commit:** `git commit -S -m "Open dApp sign-in in ASWebAuthenticationSession on iOS"`

### Task B3: Open dApp sign-in in a Custom Tab on Android

**Files:**
- Create in `packages/dapp-browser/android/src/main/java/ee/forgr/capacitor_inappbrowser/`: `BreadAuthState.java` (plain Java; mirrors `BreadPresentationState.java`), `BreadAuthController.java`, and `BreadAuthCallbacks.java` (public: the one entry `MainActivity` calls).
- Modify: `packages/dapp-browser/android/src/main/java/ee/forgr/capacitor_inappbrowser/WebViewDialog.java`
  - Line 109: `private BreadAuthController auth;` beside `presentation`.
  - Lines 931-934: create and install `auth` before `presentation.install()`, both before `loadUrl` at line 935.
  - Line 2902: in `finishDismiss()`, `if (auth != null) auth.close();` immediately before `if (presentation != null) presentation.close();`. `forceClose()` (line 128) and `handleOnDestroy()` both end here.
- Modify: `packages/dapp-browser/android/src/main/java/ee/forgr/capacitor_inappbrowser/InAppBrowserPlugin.java`
  - `BreadAuthController.hostResumed();` as the first statement of `handleOnResume()` (line 1195).
  - A new `@Override protected void handleOnStop() { super.handleOnStop(); BreadAuthController.hostStopped(); }` (Capacitor 8.4.0 `Plugin.handleOnStop`, `Plugin.java` line 995).
  - `handleOnPause()` is unchanged: a pause alone (a system dialog, a permission prompt, split screen) never touches the sheet. A Custom Tab stops Bread's activity; a dialog only pauses it.
- Modify: `packages/dapp-browser/android/src/main/AndroidManifest.xml`: the `<queries>` element (lines 2-8) gains `<intent><action android:name="android.support.customtabs.action.CustomTabsService" /></intent>`, which `CustomTabsClient.getPackageName` needs on Android 11+. The manifest merge dedupes it if `androidx.browser` declares it too.
- Modify: `android/app/src/main/AndroidManifest.xml`: inside `.MainActivity` (line 30, `singleTask` at line 33), after the `com.miden.wallet` filter (lines 42-49):
```xml
<intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="com.miden.wallet.auth" android:host="callback" />
</intent-filter>
```
- Modify: `android/app/src/main/java/com/miden/wallet/MainActivity.java`: the callback leaves the intent before Capacitor's Bridge sees it (see below).
- Modify: `packages/dapp-browser/android/src/test/java/ee/forgr/capacitor_inappbrowser/BreadPresentationControllerTest.java`: in `supportedInstallsBothTransportsBeforeFirstNavigation` (lines 1505-1510), the expected list at line 1507 becomes `List.of("listener:breadAuth", "listener:breadPresentation", "script:window.bread={version:1}")`, and the test is renamed `supportedInstallsEveryTransportBeforeFirstNavigation`. `unsupported()` (line 1470) stays green, because auth needs the same two WebView features.
- Test: create `BreadAuthStateTest.java` and `BreadAuthControllerTest.java` in `packages/dapp-browser/android/src/test/java/ee/forgr/capacitor_inappbrowser/`, and `android/app/src/test/java/com/miden/wallet/BreadAuthManifestTest.kt`.

**Why the callback is taken in `MainActivity`.** Capacitor's `Bridge.onNewIntent` hands every intent to every plugin, with no way to consume it. `@capacitor/app` 8.1.0's `AppPlugin.handleOnNewIntent` keeps every VIEW URL as a retained `appUrlOpen` event for the life of the process, and `ReownPlugin` queues any data string or logs AppKit's error with it. `MainActivity` therefore hands the callback to the sheet and passes the Bridge the same intent without data, both before `super.onCreate` (a cold start, including the launch intent `BridgeActivity.load()` replays through `onNewIntent(getIntent())` at line 51) and in `onNewIntent`. With no data, `AppPlugin` returns early and `ReownPlugin` sees nothing, so neither needs a change.

No ProGuard change: only the app's release build is minified (`android/app/build.gradle` lines 77-79), `com.miden.wallet.**` is kept wholesale, and the new classes are referenced directly. No plugin registration: none of the new classes is a plugin.

**Interfaces:**
```java
final class BreadAuthState {
    static final String CALLBACK_SCHEME = "com.miden.wallet.auth";
    static final String CALLBACK_ADDRESS = "com.miden.wallet.auth://callback";
    static final int MAX_URL_LENGTH = 4096;
    static final String NOT_MAIN_FRAME = "AUTH_NOT_MAIN_FRAME", INSECURE_PAGE = "AUTH_INSECURE_PAGE",
        INVALID_URL = "AUTH_INVALID_URL", BUSY = "AUTH_BUSY", UNAVAILABLE = "AUTH_UNAVAILABLE", FAILED = "AUTH_FAILED";
    enum Phase { IDLE, LAUNCHING, AWAY }
    enum Outcome { NONE, RESOLVED, CANCELLED, FAILED }
    static String rejection(boolean mainFrame, String pageScheme, String pageHost, int pagePort, Object url); // null when valid
    static boolean isCallback(String url);
    String refusal();               // BUSY unless IDLE; UNAVAILABLE while the host is stopped; else null
    long begin();                   // IDLE to LAUNCHING; returns the ticket
    void stopped();                 // the host stopped: LAUNCHING to AWAY
    Outcome resumed();              // the host resumed: AWAY to IDLE is CANCELLED; LAUNCHING stays (a pause alone); else NONE
    Outcome callback(String url);   // IDLE gives NONE; otherwise to IDLE, RESOLVED if isCallback(url) else FAILED
    void release(long ticket);      // the owner closed or the launch failed; a stale ticket changes nothing
    Phase phase();
}
final class BreadAuthController {
    static BreadAuthState state = new BreadAuthState(); // one sheet per process; tests reset it
    BreadAuthController(WebViewDialog owner, WebView webView);
    BooleanSupplier presentable;    // the dialog is showing, not closing, and has an activity
    void install();                 // only with DOCUMENT_START_SCRIPT and WEB_MESSAGE_LISTENER, like BreadPresentationController.install()
    void close();                   // removeWebMessageListener(webView, "breadAuth"); frees an owned sheet; drops its reply
    static void hostStopped();
    static void hostResumed();      // CANCELLED replies {"id","cancelled":true}
    static void hostCallback(String url); // RESOLVED replies {"id","url"}; FAILED replies {"id","error":"AUTH_FAILED"}
}
public final class BreadAuthCallbacks {
    // A VIEW intent whose data has the scheme com.miden.wallet.auth (ASCII case-insensitive): hands the data string to the
    // open sheet, if any, and returns a copy without data. Any other intent comes back unchanged, as the same object.
    public static Intent consume(Intent intent);
}
```
- `rejection` parses with `java.net.URI` after the length and character checks, rejects `getRawUserInfo() != null`, and compares ports as `port < 0 ? 443 : port`.
- The listener is `WebViewCompat.addWebMessageListener(webView, "breadAuth", Collections.singleton("*"), (view, message, origin, mainFrame, reply) -> receive(message.getData(), origin, mainFrame, reply))`; `origin` is the native source origin.
- The Custom Tab: `new CustomTabsIntent.Builder().build()` with no session (the plugin's shared `CustomTabsSession` callback, lines 1214-1232, fires `browserPageLoaded` into JS), `tab.intent.setPackage(pkg)` with `pkg = CustomTabsClient.getPackageName(owner.activity, browsers)` over the packages from `queryIntentActivities(new Intent(ACTION_VIEW, Uri.parse("http://")), MATCH_ALL)`, launched with `tab.launchUrl(owner.activity, Uri.parse(url))`. An Activity context means no `FLAG_ACTIVITY_NEW_TASK`, so the tab opens in Bread's task. No `FLAG_ACTIVITY_NO_HISTORY`, so switching to a password manager or a 2FA app doesn't end the flow. A null `pkg` or `ActivityNotFoundException` gives `AUTH_UNAVAILABLE`; any other `RuntimeException` gives `AUTH_FAILED`.
- The return: the browser fires the VIEW intent; `singleTask` clears the tab above `MainActivity` and delivers `onNewIntent`, where `BreadAuthCallbacks.consume` resolves the sheet. Android delivers `onNewIntent` before `onResume`, so `hostResumed` is then quiet. Closing the tab with X or Back resumes Bread after a stop with no callback, and `hostResumed` replies cancelled.

- [ ] **Step 1: Write the failing tests:**
```java
// BreadAuthStateTest (plain JUnit, like BreadPresentationStateTest)
mainFrameIsCheckedFirst                      // a child frame on an http page with a bad url: AUTH_NOT_MAIN_FRAME
nonHttpsOrOpaquePagesAreInsecure             // scheme http, a null scheme (opaque origin), an empty host: AUTH_INSECURE_PAGE
urlMustBeAbsoluteSameOriginHttps             // null, an Integer, "", relative, http, another host, :444, userinfo, a backslash, a space,
                                             // non-ASCII, 4097 characters: AUTH_INVALID_URL; https://GAME.example:443/a?b#c and 4096
                                             // characters on page (https, game.example, -1): null
callbackAddressIsExactWithAnyQuery           // the same accept and reject table as the iOS test
oneSheetAtATime                              // after begin(), refusal() is AUTH_BUSY; release(stale) keeps it; release(current) frees it
stoppedHostRefusesUnavailable                // stopped() with no sheet: refusal() is AUTH_UNAVAILABLE until resumed()
resumeAfterStopWithoutCallbackCancels        // begin, stopped, resumed: CANCELLED and IDLE; a later callback is NONE
aPauseAloneKeepsTheSheet                     // begin, resumed with no stop: NONE, still LAUNCHING; then callback(valid): RESOLVED
callbackBeforeResumeResolvesAndResumeIsQuiet // begin, stopped, callback(valid): RESOLVED; resumed: NONE
foreignCallbackWhileOpenFails                // callback("com.miden.wallet.auth://callback/x"): FAILED, slot freed
callbackWithoutSheetIsIgnored                // callback(valid) while IDLE: NONE
// BreadAuthControllerTest (Robolectric, @Config(sdk = 34)): the static mocks of BreadPresentationControllerTest lines 66-91,
// capturing listeners by name into a map (the existing messageListener is last-wins); JavaScriptReplyProxy is a Mockito mock,
// and replies are compared as parsed JSON (Android's JSONObject escapes '/'); com.android.chrome is registered with
// ShadowPackageManager with an http VIEW activity and a CustomTabsService; presentable is () -> true unless a test needs false;
// @Before resets BreadAuthController.state; @After calls forceClose() on open dialogs.
installsBreadAuthBeforePresentationAndFirstNavigation // installed starts with listener:breadAuth, rules {"*"}, no url loaded yet
missingWebViewFeatureInstallsNoAuthListener
childFrameRepliesNotMainFrame                // isMainFrame false: {id: "a", error: "AUTH_NOT_MAIN_FRAME"}
insecurePageRepliesInsecurePage              // origin http://fixture.example: AUTH_INSECURE_PAGE
crossOriginUrlRepliesInvalidUrl              // https://other.example/ from https://fixture.example: AUTH_INVALID_URL
launchesSessionlessCustomTabInTheHostTask    // next started activity: VIEW, the exact url, package com.android.chrome, no
                                             // FLAG_ACTIVITY_NEW_TASK, no FLAG_ACTIVITY_NO_HISTORY, null CustomTabsIntent.EXTRA_SESSION binder
callbackIntentResolvesTheUrlUntouched        // hostStopped, then BreadAuthCallbacks.consume(VIEW com.miden.wallet.auth://callback?login=a%2Fb&x=1):
                                             // replies {id: "a", url: <that exact string>}; the returned intent keeps its action and has no data;
                                             // hostResumed sends nothing more
consumeLeavesOtherIntentsAlone               // MAIN, VIEW com.miden.wallet://wc?uri=x, VIEW without data: the same object back, nothing sent
consumeStripsACallbackWithNoSheet            // no open sheet (a cold start after process death): a copy without data, nothing sent
resumeAfterStopRepliesCancelled              // hostStopped then hostResumed: {id: "a", cancelled: true} once
pluginStopAndResumeReachTheSheet             // InAppBrowserPlugin's handleOnStop() then handleOnResume() cancel the open sheet
                                             // (construct the plugin as the existing plugin tests do if the resume body needs a bridge)
secondOpenRepliesBusy                        // from the same or another dialog: AUTH_BUSY; the first stays open
noCustomTabsBrowserRepliesUnavailable        // no browser registered: AUTH_UNAVAILABLE, slot freed
hiddenDialogRepliesUnavailable               // presentable false: AUTH_UNAVAILABLE, no activity started
closingTheDialogFreesTheSheetAndIgnoresALateCallback // after forceClose(), consume(valid callback) sends nothing; a new dialog can open a sheet
```
```kotlin
// BreadAuthManifestTest.kt (plain JVM, run from the module directory; namespace-aware DocumentBuilderFactory)
mainActivityIsSingleTask                     // .MainActivity keeps android:launchMode="singleTask", which clears the tab on return
mainActivityReceivesTheCallbackAddress       // one VIEW + DEFAULT + BROWSABLE filter with scheme com.miden.wallet.auth and host callback;
                                             // no other component declares that scheme
mainActivityConsumesCallbacksBeforeTheBridge // MainActivity.java: onCreate calls setIntent(BreadAuthCallbacks.consume(getIntent())) before
                                             // super.onCreate, and onNewIntent passes BreadAuthCallbacks.consume(intent) to super.onNewIntent
                                             // (a source check: the app module has no Robolectric)
```
- [ ] **Step 2: Implement.** `WebViewDialog` lines 931-934 (auth registers first, so the presentation listener stays last and `window.breadAuth` exists before the document-start script runs):
```java
if (_options.getBreadPresentation() != null) {
    auth = new BreadAuthController(this, _webView);
    auth.install();
    presentation = new BreadPresentationController(this, _webView, _options.getBreadPresentation(), _options.isInitiallyVisible());
    presentation.install();
}
```
  `BreadAuthController.receive`:
```java
private void receive(String raw, Uri origin, boolean mainFrame, JavaScriptReplyProxy proxy) {
    String id; Object url;
    try { JSONObject m = new JSONObject(raw); id = m.getString("id"); url = m.opt("url"); }
    catch (JSONException | NullPointerException e) { return; }
    if (id.isEmpty() || id.length() > 128) return;
    String code = BreadAuthState.rejection(mainFrame, origin.getScheme(), origin.getHost(), origin.getPort(), url);
    if (code == null) code = state.refusal();
    if (code == null && !presentable.getAsBoolean()) code = BreadAuthState.UNAVAILABLE;
    String browser = code == null ? customTabsPackage(owner.activity) : null;
    if (code == null && browser == null) code = BreadAuthState.UNAVAILABLE;
    if (code != null) { send(proxy, id, "error", code); return; }
    ticket = state.begin(); reply = proxy; requestId = id; active = this;
    try {
        CustomTabsIntent tab = new CustomTabsIntent.Builder().build();
        tab.intent.setPackage(browser);
        tab.launchUrl(owner.activity, Uri.parse((String) url));
    } catch (ActivityNotFoundException e) { finish("error", BreadAuthState.UNAVAILABLE); }
    catch (RuntimeException e) { finish("error", BreadAuthState.FAILED); }
}
```
  - The static hooks route to `active`, the one controller that owns the open sheet. `hostCallback(url)` calls `state.callback(url)`: RESOLVED gives `active.finish("url", url)`, FAILED gives `active.finish("error", FAILED)`. `finish` sends `new JSONObject().put("id", id).put(key, value).toString()` on the saved proxy, clears `active` and calls `state.release(ticket)`.
  - `BreadAuthCallbacks.consume(intent)`: return `intent` unless it is `ACTION_VIEW` with a data string whose scheme is `com.miden.wallet.auth` (ASCII case-insensitive, compared on the text before the first `:`); otherwise call `BreadAuthController.hostCallback(data)` and return `new Intent(intent).setData(null)`.
  - `MainActivity`:
```java
@Override
protected void onCreate(Bundle savedInstanceState) {
    // A dApp sign-in callback carries a login handle; Capacitor hands every intent to every plugin, and AppPlugin keeps VIEW URLs
    setIntent(BreadAuthCallbacks.consume(getIntent()));
    // Register custom plugins before super.onCreate
    // ... the existing registerPlugin calls, super.onCreate and setupStatusBar() are unchanged
}

@Override
protected void onNewIntent(Intent intent) {
    super.onNewIntent(BreadAuthCallbacks.consume(intent));
}
```
  - Nothing in these classes logs a URL.
- [ ] **Step 3: CI**, with batch B2: `pr-compile-surfaces.yml` job `android` ("Compile Android"): "Build debug APK" (`yarn test:e2e:android:build`, which merges both manifests) and "Run Android unit tests" (`cd android && ./gradlew :app:testDebugUnitTest :miden-dapp-browser:testDebugUnitTest --console=plain`). Also `pr.yml` and `changelog.yml`. No PR job builds the minified release. Expected: PASS.
- [ ] **Step 4: Commit:** `git commit -S -m "Open dApp sign-in in a Custom Tab on Android"`

### Task B4: An empty window.bread in the desktop dApp window

**Files:**
- Modify: `src-tauri/scripts/dapp-injection.js`: define the marker right after the `__midenInjected` guard (lines 46-48), before `pendingRequests` (line 51). It runs synchronously at document start, so a site's first script sees it, while the wallet API waits for `DOMContentLoaded` when there is no body (lines 558-571). The top-frame return at line 44 already keeps it out of sub-frames, including WebView2's.
- Modify: `docs/dapp-fullscreen.md`: lines 16 and 53, `if (window.bread?.version === 1) {` becomes `if (window.bread?.presentation) {`; line 21 adds: "Bread's desktop app defines an empty, frozen `window.bread`, so detect each capability by its presence."
- Modify: `CHANGELOG.md`, Features: `- [FEATURE][desktop] The desktop dApp window defines an empty, frozen window.bread, so a site can tell it runs inside Bread. It has no presentation or auth.`
- Test: `src/lib/desktop/dapp-injection.test.ts`

**Interfaces:**
- `window.bread` is an own property that is non-writable, non-enumerable and non-configurable, the same descriptor as mobile's (`presentation-script.ts` line 99). Its value is `Object.freeze({})`: no `version`, no `presentation`, no `auth`. The published `window.bread?.version === 1` checks therefore keep skipping presentation on desktop.
- The extension gets nothing.

- [ ] **Step 1: Write the failing tests.** Extract `run(win)` from `load()` (the `new Function(...)` call at lines 46-53) so a window can be evaluated twice, add `loadFrame()` (a JSDOM at `https://dapp.example/` with an `iframe`, `__MIDEN_BRIDGE_TOKEN__` set on its `contentWindow`, and `run` there), and add `bread?: object` to `DappWindow` (lines 26-30).
```ts
it('marks the top document with an empty, frozen window.bread')   // Object.keys(win.bread) is []; frozen; no version, presentation or auth
it('defines window.bread synchronously even when the wallet API waits for DOMContentLoaded') // body removed before run: bread yes, midenWallet not yet
it('keeps window.bread non-writable and non-configurable')       // descriptor {writable: false, enumerable: false, configurable: false};
                                                                 // Reflect.set and Reflect.deleteProperty return false
it('defines nothing in a sub-frame')                              // after loadFrame(): no bread, no midenWallet
it('keeps the same marker when the script runs again')            // a second run(win) doesn't throw; win.bread is the same object
```
- [ ] **Step 2: Implement** after line 48:
```js
// Desktop has neither presentation nor auth; a page detects Bread by window.bread and each capability by its presence.
try {
  Object.defineProperty(window, 'bread', { value: Object.freeze({}) });
} catch (e) {
  // A page-defined non-configurable `bread` keeps its value; the wallet bridge still installs.
}
```
  Then the two doc edits.
- [ ] **Step 3: CI**, with batch B2: `pr.yml` unit (`src-tauri/` is outside `collectCoverageFrom`, so coverage is unchanged), `pr-compile-surfaces.yml` job `desktop` (the `include_str!` in `dapp_browser.rs` line 36 still builds), `changelog.yml`. Expected: PASS.
- [ ] **Step 4: Commit:** `git commit -S -m "Define an empty window.bread in the desktop dApp window"`

### Task B5: Document the sheet and check it on phones

**Files:**
- Create: `docs/dapp-sign-in.md`, a sibling of `dapp-fullscreen.md`, covering:
  - The API with presence detection: `if (window.bread?.auth) { const result = await window.bread.auth.open(url); }`; the two result shapes; reading the handle with `new URL(result.url).searchParams.get('login')` or `'login_error'`.
  - The six codes, one line each, in the check order.
  - The page rules: the main frame, an https page, an absolute same-origin https URL of at most 4096 characters, one sheet across the app, the browser visible and in the foreground.
  - The callback: a navigation inside the sheet to `com.miden.wallet.auth://callback` ends the flow, whether a redirect, a refresh or a link the user taps. Bread resolves only while its own sheet is open and only for that address, forwards the URL untouched, and reads, stores and logs nothing from it. Recommend ending the flow with a small no-store page that refreshes to `com.miden.wallet.auth://callback?login=<handle>` (or `?login_error=<code>`) and also shows a "Return to Bread" link to the same address, because Chrome on Android may refuse a redirect to an app that no tap started, as after Apple's script-submitted form post.
  - The site's security duty: on Android any installed app can send that address while a sheet is open, so redeem a handle only together with a secret the page kept in memory and committed to in its auth URL (a PKCE-style challenge), single use and short-lived.
  - Platforms: iOS shows its consent prompt, the sheet shares Safari's cookies, and Cancel on the prompt or the sheet gives `{ cancelled: true }`. Android opens a Custom Tab in Bread's task, sharing the browser's cookies; closing the tab gives `{ cancelled: true }`. Desktop: `window.bread` is empty. Extension: nothing.
  - Native integration: the `breadAuth` transports and the reply shapes from the shared rules.
- Modify: `docs/dapp-fullscreen.md`: line 21, a sentence pointing to `dapp-sign-in.md` for `window.bread.auth`; line 60, a sentence saying the `breadPresentation` option also installs the `breadAuth` transport.
- No CHANGELOG line: PR B's entries came with B1 and B4.

- [ ] **Step 1: Write the device checks.** On a build of this branch, with a fixture site at an https origin that has Google and Apple buttons, a cross-origin iframe and a button that opens twice:
  - iPhone, Google: the system prompt names the site's host; after Continue and sign-in the promise resolves `{ url }` with `?login=`, and the page is still loaded.
  - iPhone, Apple: the same, through Apple's form post.
  - iPhone, Cancel on the system prompt, and Cancel inside the sheet: `{ cancelled: true }`.
  - iPhone, a fullscreen site and a browser-mode site: the sheet is usable and typing works in both; note how it looks inside the slot in browser mode.
  - iPhone, VoiceOver on: the sheet is reachable and Cancel can be activated.
  - Android, Google: the Custom Tab opens over the site; on success the tab closes by itself, Bread returns in the same task (Recents shows one Bread task) with the page still loaded, and the promise resolves `{ url }`.
  - Android, Apple: the same; note whether Bread came back by itself or the site's "Return to Bread" link was needed.
  - Android, close the tab with X or Back: `{ cancelled: true }`, the page still loaded.
  - Android, switch to a 2FA or password app mid-flow and come back through Recents: the flow continues.
  - Android, a permission prompt or system dialog over Bread just before the tab appears: the flow continues.
  - Android, tap Bread's launcher icon mid-flow: note whether the tab stays on top (the flow continues) or is gone (`{ cancelled: true }`).
  - Both, a second open while the sheet is up, from the same page and from another parked dApp: `AUTH_BUSY`.
  - Both, an iframe or an http page calling: `AUTH_NOT_MAIN_FRAME` or `AUTH_INSECURE_PAGE`.
  - Both, a parked or hidden dApp calling: `AUTH_UNAVAILABLE`, and no sheet over the wallet.
  - iPhone, closing the dApp while the sheet is open: the sheet closes, and a new sign-in works.
  - Android, `adb shell am kill com.miden.wallet` while the tab is open, then finish signing in: Bread starts without crashing and nothing resolves.
  - Both, logs: `adb logcat` and the iOS Console show no line containing the login handle.
- [ ] **Step 2: Write** `docs/dapp-sign-in.md` and the two `dapp-fullscreen.md` sentences.
- [ ] **Step 3: CI**, with batch B2: every required check stays green (`pr.yml` gate `ci`, `coverage-gate`, `i18n-check`; `changelog.yml`; `pr-compile-surfaces.yml` `android`, `ios`, `desktop`). Run the device checks on the batch B2 build (an iPhone and an Android phone; the release needs real phones) and record the results in the PR body.
- [ ] **Step 4: Commit:** `git commit -S -m "Document the dApp sign-in sheet"`

### Risks to probe in review and on the phones

1. **Chrome's external-protocol rule.** Chrome may refuse a redirect to a custom scheme that no tap started, as after Apple's script-submitted form post. Sites end the flow with a page that refreshes and offers a "Return to Bread" link (B5); the device checks try Google and Apple on Android.
2. **Process death on Android while the tab is open.** The callback cold-starts Bread with no site, no sheet and nothing to resolve; `MainActivity` takes the data out of the intent, and the user signs in again.
3. **Lifecycle order.** B3 relies on `onNewIntent` arriving before `onResume`, which Android documents. A pause alone never cancels; a stop then a resume without a callback does.
4. **The dialog surviving the tab.** On pause, non-fullscreen dialogs hide with `super.hide()` and show again on resume; fullscreen ones stay covered. The site's state, audio and timers survive, and the reply lands after the dialog is visible.
5. **Callback injection on Android.** Any installed app can send the callback while a sheet is open. Sites bind the handle to their in-memory secret (B5). iOS is immune: the scheme isn't registered, and the session completes only from its own browser.
6. **Frames and direct calls.** `"*"` rules put `window.breadAuth` in every Android frame, `.page` handlers are visible to iOS iframes, and a page can call the transport directly. The native checks are the only authority; B2 and B3 test the main frame, the origin and the URL.
7. **iOS replies exactly once** on every exit: validation, busy, unavailable, a failed start, each completion, `close()`, `deinit`, and the weak wrapper with a dead delegate.
8. **iOS resign-active during the consent prompt.** `BreadPresentationController` pauses its readiness budget and `InAppBrowserPlugin` adds its privacy screen (lines 1144-1180) under the sheet: look for flicker or a stuck cover after Continue or Cancel.
9. **The iOS anchor window hidden or resized while the sheet is open** (parking, overlays, rotation): the sheet hides or re-lays out with it while the slot stays busy. In browser mode the sheet is laid out inside the slot; if the device check finds that unusable, a full-scene anchor window above the navbar overlay replaces it, and `render()` then skips `makeKey()` and `accessibilityViewIsModal` while a sheet is open.
10. **Android package visibility.** Without a merged `CustomTabsService` query, `getPackageName` returns null on Android 11+ and every open fails `AUTH_UNAVAILABLE`. On old WebViews without `addEventListener` on `breadAuth`, B1 falls back to `onmessage`.
11. **Test harness order.** `BreadPresentationControllerTest` captures listeners last-wins (line 78), so auth registers before presentation, and the install list at line 1507 changes in the same commit.
12. **Crash reports.** No native or JS reporter records an intent, a URL or console output carrying the callback.
13. **iOS 26 SDK concurrency annotations.** The SDK marks the reply handler `@MainActor @Sendable`; in Swift 5 mode a mismatch should only warn. If `Compile iOS` errors, match the SDK's signature exactly.
