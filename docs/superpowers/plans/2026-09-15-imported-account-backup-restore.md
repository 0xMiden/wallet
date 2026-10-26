# Imported Account Backup and Restore Implementation Plan

> **For the implementer:** Follow `superpowers:test-driven-development` task by task. Do not write production code until the named failing test proves the behavior is absent. Use `superpowers:verification-before-completion` before every commit and `review-council:rev` after the implementation is locally green.

**Goal:** Make a newly exported encrypted wallet file restore imported single-signature accounts with their original auth secrets, while keeping legacy backups compatible and rejecting multiple mnemonic roots.

**Architecture:** A versioned backup contract and parser live below the UI. One authenticated backend request produces a consistent mnemonic, account, imported-secret, and Miden database snapshot. Restore decrypts and parses the whole payload before importing its database dumps, then sends the versioned account material through the existing serialized registration path. The vault validates every imported secret against its declared scheme, commitment, and reconstructed account ID before inserting any imported secret or publishing the new vault.

**Tech stack:** React, TypeScript, Zustand request transport, Dexie, `@miden-sdk/miden-sdk`, Jest, Testing Library, Playwright.

---

## Task 1: Establish the versioned backup contract and strict parser

**Files:**

- Create: `src/lib/miden/backup-file.ts`
- Create: `src/lib/miden/backup-file.test.ts`
- Modify: `src/screens/shared.ts`
- Modify: `src/lib/shared/types.ts`

1. Measure the existing TypeScript comment ratio repo-wide and in the files being touched. Keep implementation comments inside that band and retain only security invariants and non-obvious compatibility rules.
2. Add failing parser tests for a legacy payload, a valid version 2 payload, an unknown version, malformed account arrays, malformed auth schemes, malformed secret hex, and duplicate imported-account identifiers or commitments.
3. Run `yarn jest src/lib/miden/backup-file.test.ts --runInBand` and confirm the new tests fail for the missing parser.
4. Define `ImportedAccountBackup` with `accountId`, `publicKeyCommitment`, `authScheme`, and `secretKeyHex`. Define version 2 without weakening the legacy shape. Parse decrypted JSON from `unknown`; never trust the `decryptJson` return type directly.
5. Keep `screens/shared.ts` as a compatibility re-export so existing imports do not churn.
6. Re-run the focused test and commit only after it passes.

## Task 2: Add one authenticated backend export snapshot

**Files:**

- Modify: `src/lib/shared/types.ts`
- Modify: `src/lib/miden/back/vault.ts`
- Modify: `src/lib/miden/back/vault.test.ts`
- Modify: `src/lib/miden/back/actions.ts`
- Modify: `src/lib/miden/back/actions.test.ts`
- Modify: `src/lib/miden/back/main.ts`
- Modify: `src/lib/miden/back/main.test.ts`
- Modify: `src/lib/intercom/in-process-request-handler.ts`
- Modify: `src/lib/intercom/mobile-adapter.test.ts`
- Modify: `src/lib/intercom/desktop-adapter.test.ts`
- Modify: `src/lib/store/index.ts`
- Modify: `src/lib/store/index.test.ts`
- Modify: `src/lib/store/types.ts`
- Modify: `src/lib/miden/front/client.ts`
- Modify: `src/lib/miden/front/client.test.tsx`

1. Add failing vault tests showing one password or hardware authorization returns the mnemonic, all wallet account records, the Miden database dump, and one imported-secret record per `hdIndex < 0` account.
2. Cover export failure before a payload is returned when an imported account is absent from the restored SDK database, has zero or multiple auth commitments, has a missing vault secret, or has a scheme, commitment, or reconstructed ID mismatch.
3. Confirm the focused vault tests fail because no snapshot API exists.
4. Extract the deterministic `AccountBuilder` chain from `importAccountFromPrivateKey` into one internal helper used by both import and backup validation. Keep imported accounts single-signature and public, matching the supported import path.
5. Add `Vault.exportWalletBackupMaterial(password?)`. Authenticate exactly once, serialize it on the account write queue, read the account records with that vault key, hold the WASM client lock while resolving SDK accounts and exporting the database, and return no data unless the full imported set validates.
6. Add a dedicated request and response pair through every transport and expose one `exportWalletBackupMaterial` method to the React context. Do not implement export by repeatedly calling `revealPrivateKey`.
7. Run the listed focused suites, confirm all pass, and commit.

## Task 3: Validate and restore imported secrets before publishing the vault

**Files:**

- Modify: `src/lib/shared/types.ts`
- Modify: `src/lib/miden/back/vault.ts`
- Modify: `src/lib/miden/back/vault.test.ts`
- Modify: `src/lib/miden/back/actions.ts`
- Modify: `src/lib/miden/back/actions.test.ts`
- Modify: `src/lib/miden/back/main.ts`
- Modify: `src/lib/miden/back/main.test.ts`
- Modify: `src/lib/intercom/in-process-request-handler.ts`
- Modify: `src/lib/intercom/mobile-adapter.test.ts`
- Modify: `src/lib/intercom/desktop-adapter.test.ts`
- Modify: `src/lib/store/index.ts`
- Modify: `src/lib/store/index.test.ts`
- Modify: `src/lib/store/types.ts`
- Modify: `src/lib/miden/front/client.ts`

1. Add failing tests for valid Falcon and ECDSA restores plus missing, extra, duplicate, malformed, wrong-scheme, wrong-commitment, and wrong-account-ID entries.
2. Add a failure test proving that validation completes for the whole imported collection before the first imported `keystore.insert` call. Add hold-eviction tests around every parking await.
3. Extend `ImportFromClientRequest`, `registerImportedWallet`, and `Vault.spawnFromMidenClient` with the parsed format version and imported-secret collection.
4. For legacy files, retain the existing mnemonic-derived behavior and omission notice. For version 2, require a one-to-one imported account mapping, deserialize every secret, detect its scheme, rebuild the account with the shared helper, compare normalized commitment and account ID, and only then insert secrets under the restored SDK account IDs.
5. Preserve the current unlock publication order: `unlocked(...)` runs only after the complete spawn succeeds. On failure, retire the provisional vault sink in `finally` so no rejected restore retains a live key callback.
6. Run all focused transport, action, and vault tests and commit after they pass.

## Task 4: Export complete version 2 encrypted files

**Files:**

- Modify: `src/screens/encrypted-file-flow/ExportFileComplete.tsx`
- Modify: `src/screens/encrypted-file-flow/ExportFileComplete.test.tsx`
- Modify: `public/_locales/en/en.json`
- Regenerate: `public/_locales/*/messages.json`

1. Replace the existing omission assertions with failing tests that decrypt the generated file and require `formatVersion: 2`, every account, and the complete imported-secret collection. Add a test proving a snapshot failure creates no download or share result.
2. Replace the separate mnemonic reveal, account filtering, and frontend Miden DB export with the single backend snapshot. Continue exporting the wallet Dexie database, then encrypt the assembled version 2 payload under the existing authenticated envelope.
3. Remove the imported-account omission warning from successful new exports. Keep the legacy restore notice key for old files.
4. Regenerate locale bundles with the repository script, run the focused screen test plus i18n lint and locale parity tests, and commit.

## Task 5: Restore the encrypted-file onboarding entry point

**Files:**

- Restore and adapt: `src/screens/onboarding/import-wallet-flow/SelectImportType.tsx`
- Restore and adapt: `src/screens/onboarding/import-wallet-flow/SelectImportType.test.tsx`
- Restore and adapt: `src/screens/onboarding/import-wallet-flow/ImportWalletFile.tsx`
- Restore and adapt: `src/screens/onboarding/import-wallet-flow/ImportWalletFile.test.tsx`
- Modify: `src/screens/onboarding/types.ts`
- Modify: `src/screens/onboarding/types.test.ts`
- Modify: `src/screens/onboarding/navigator.tsx`
- Modify: `src/screens/onboarding/navigator.test.tsx`
- Modify: `public/_locales/en/en.json`
- Regenerate: `public/_locales/*/messages.json`

1. Start from tests, not the deleted implementation. Add failing navigation tests requiring Recover to offer Seed Phrase and Encrypted Wallet File, plus file-screen tests for drag/drop, picker selection, password failure, malformed JSON, unsupported version, restore-import failure, and the legacy omission acknowledgement.
2. Restore the two screens from their last known behavior only as a visual baseline, then adapt them to the current onboarding components, typed error handling, mobile layout, strict parser, and current i18n conventions.
3. Decrypt and parse the entire payload before calling either database import. Report wrong-password failures separately from structurally invalid or operational restore failures.
4. Pass one parsed restore payload forward. Never pass loose unvalidated secret arrays through component state.
5. Preserve seed recovery behavior and all current network-notice, Guardian discovery, passcode, hardware, browser-back, and stale-transition guards.
6. Regenerate locale bundles, run the four focused onboarding suites plus i18n gates, and commit.

## Task 6: Wire file restore through Welcome without changing seed recovery

**Files:**

- Modify: `src/app/pages/Welcome.tsx`
- Modify: `src/app/pages/Welcome.test.tsx`
- Modify: `src/app/pages/ForgotPassword/ForgotPassword.test.tsx`

1. Add failing state-machine tests for file selection, password/passcode or hardware protection, back navigation, duplicate confirmation taps, failed restore retry, and successful `importWalletFromClient` with the exact parsed versioned payload.
2. Track import type and one parsed file payload in Welcome. For file restore, skip Guardian discovery and wallet-type selection because the backup already names the accounts being restored.
3. Make the existing registration de-duplication key include the backup version and imported account bindings, without including raw secret bytes in logs or analytics.
4. Route seed recovery exactly as before. Add a focused Forgot Password regression test proving its seed-only flow does not accidentally expose or depend on the new onboarding file state.
5. Run the focused suites and commit.

## Task 7: Prove the exported imported account can sign after restore

**Files:**

- Modify: `playwright/e2e/helpers/wallet-page.ts`
- Create: `playwright/e2e/tests/imported-account-backup-restore.spec.ts`
- Modify only if needed: E2E test hooks under `src/lib/store/index.ts`

1. Add the Playwright scenario first and demonstrate that it fails on the current exporter because the imported account is absent after restore.
2. Through the real UI, create a wallet, import a deterministic single-signature private key, export the encrypted wallet file, clear an isolated profile, restore from that file with a new vault password, select the restored imported account, and sign a deterministic challenge or transaction with the same account ID.
3. Keep the hook surface E2E-gated and never expose the private key or decrypted backup in screenshots, traces, console logs, or test artifacts.
4. Run the new Playwright spec with retries disabled. If a live network is needed, use the repository's isolated version-aligned harness and tear down only resources created by this test.
5. Commit after the regression passes.

## Task 8: Full verification, visual evidence, Council, and delivery

**Files:**

- Modify: `tasks/todo.md`

1. Update the issue checklist and add a review section with exact commands and results.
2. Run `git diff --check`, the forbidden-dash scan, attribution scan, dependency integrity, TypeScript, ESLint, Prettier check, i18n lint, locale parity, all affected Jest suites, and the new Playwright scenario.
3. Read `jest.config.ts`, run full `yarn test:coverage --runInBand`, and verify statements, branches, functions, and lines all meet the configured 95% global threshold before any push.
4. Build every affected target. Search complete output for any error and verify expected artifacts such as `dist/chrome_unpacked/manifest.json` and the mobile `dist` entry files exist.
5. Capture fresh desktop and mobile screenshots of import-type selection, file selection, failure, and success states. Resize every screenshot to a maximum 1800 px long side before opening it. Grade each approved criterion in a literal pass/fail table.
6. Run `review-council:rev` explicitly on the branch with the required Sol, Terra, Opus, and Sonnet roster. Apply every actionable finding with new commits, rerun affected verification, and keep the Council receipt.
7. Push once the final reviewed tree is green. Open a concise non-draft PR whose body contains a standalone `Closes #64` and a focused `Reviewers:` line.
8. Use the autopilot loop to resolve clear comments or CI failures, re-run Council after code changes when required, wait for every required and affected check to pass, then admin squash merge.
9. Verify the merged PR, the squash commit on `main`, and issue #64's closed state through the PR link.
